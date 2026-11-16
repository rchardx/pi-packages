import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getPackageDir,
  ModelRuntime,
  RpcClient,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { record } from "../src/protocol.ts";
import { parentOptions } from "../src/cli.ts";
import { environment } from "../index.ts";
import { startChild } from "../src/runner.ts";

async function fixture(t: TestContext, commands = false, behavior = "normal") {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagents-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_OFFLINE = "1";
  t.after(() => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = oldOffline;
  });
  const requests: Record<string, unknown>[] = [];
  let delayMs = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed: unknown = JSON.parse(body);
    assert.ok(record(parsed));
    requests.push(parsed);
    const messages = Array.isArray(parsed.messages) ? parsed.messages.filter(record) : [];
    const toolCount = messages.filter((message) => message.role === "tool").length;
    const hasTool =
      behavior === "empty" ||
      (behavior !== "loop" &&
        (toolCount >= (commands ? 2 : 1) || JSON.stringify(messages).includes("Subagent ")));
    if (delayMs)
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          JSON.stringify(messages).includes("coordination") ? delayMs * 5 : delayMs,
        ),
      );
    const tool = {
      index: 0,
      id: `test-${toolCount}`,
      type: "function",
      function:
        toolCount === 0
          ? {
              name: "write",
              arguments: JSON.stringify({ path: "result.txt", content: "child wrote this" }),
            }
          : {
              name: "bash",
              arguments: JSON.stringify({ command: "printf checked > checked.txt" }),
            },
    };
    if (behavior === "sleep")
      tool.function = {
        name: "bash",
        // Publish readiness only after the PID is fully written.
        arguments: JSON.stringify({
          command: "echo $$ > shell.pid.tmp && mv shell.pid.tmp shell.pid && sleep 60",
        }),
      };
    if (behavior === "indirect") tool.function = { name: "invoke_extra", arguments: "{}" };
    if (behavior === "delegate" && !JSON.stringify(messages).includes("Delegated task:"))
      tool.function = {
        name: "subagent",
        arguments: JSON.stringify({ task: "Write the file and report." }),
      };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = {
      id: "mock",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: hasTool
            ? { role: "assistant", content: behavior === "empty" ? "" : "Implemented and checked." }
            : { role: "assistant", tool_calls: [tool] },
          finish_reason: null,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: hasTool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "test-only",
          models: [
            {
              id: "test-model",
              name: "Test",
              reasoning: false,
              input: ["text"],
              contextWindow: 32000,
              maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  return {
    dir,
    requests,
    delay: (ms: number) => {
      delayMs = ms;
    },
  };
}

for (const behavior of ["empty", "loop", "sleep"]) {
  test(`real child handles ${behavior} without reporting false success`, {
    timeout: 30_000,
  }, async (t) => {
    const { dir, requests } = await fixture(t, false, behavior);
    const execution = startChild({
      cwd: dir,
      provider: "mock",
      model: "test-model",
      thinking: "off",
      trusted: false,
      extensions: [],
      activeTools: ["read", "write", "bash"],
      requiredTools: ["read", "write", "bash"],
      task: "Perform the task.",
    });
    t.after(() => execution.cancel());
    await execution.ready;
    execution.run();
    if (behavior === "sleep") {
      let pid: number | undefined;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          pid = Number(await readFile(join(dir, "shell.pid"), "utf8"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      assert.ok(pid);
      assert.equal((await execution.cancel()).status, "cancelled");
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } else {
      const result = await execution.done;
      assert.equal(result.status, behavior === "empty" ? "failed" : "limit_reached", result.report);
      if (behavior === "loop") assert.equal(requests.length, 64);
    }
  });
}

test("a continuing child stays reachable until its run actually settles", {
  timeout: 30_000,
}, async (t) => {
  const { dir, requests, delay } = await fixture(t);
  const extension = join(dir, "continue.mjs");
  await writeFile(
    extension,
    `import { writeFileSync } from "node:fs";
export default function (pi) {
  let continued = false;
  pi.on("agent_before_settle", (event) => {
    if (continued) return;
    continued = true;
    writeFileSync(${JSON.stringify(join(dir, "continued.flag"))}, "");
    return {
      entries: [...event.entries, { type: "custom_message", customType: "review-reminder", content: "Review before replying.", display: false }],
      continue: true,
    };
  });
  pi.on("agent_settled", async () => {
    writeFileSync(${JSON.stringify(join(dir, "settling.flag"))}, "");
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}
`,
  );
  const flag = async (name: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await readFile(join(dir, name));
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.fail(`Timed out waiting for ${name}`);
  };
  const envelope = (id: string, message: string) => ({
    id,
    from: "main",
    to: "child",
    broadcast: false,
    message,
    sentAt: Date.now(),
  });
  delay(300);
  const execution = startChild({
    cwd: dir,
    provider: "mock",
    model: "test-model",
    thinking: "off",
    trusted: false,
    extensions: [extension],
    activeTools: ["read", "write", "bash"],
    requiredTools: ["read", "write", "bash"],
    task: "Perform the task.",
  });
  t.after(() => execution.cancel());
  await execution.ready;
  execution.run();

  // Another extension requested a continuation, so the child has not finished.
  await flag("continued.flag");
  assert.deepEqual(await execution.deliver(envelope("m1", "PEER_DURING_CONTINUATION")), {
    accepted: true,
  });

  // The run is idle while settled handlers execute; accepting now would start a new run.
  await flag("settling.flag");
  assert.deepEqual(await execution.deliver(envelope("m2", "PEER_TOO_LATE")), {
    accepted: false,
    reason: "finished",
  });

  const result = await execution.done;
  assert.equal(result.status, "completed", result.report);
  const transcript = JSON.stringify(requests.at(-1));
  assert.match(transcript, /Review before replying\./u);
  assert.match(transcript, /PEER_DURING_CONTINUATION/u);
  assert.doesNotMatch(JSON.stringify(requests), /PEER_TOO_LATE/u);
});

test("a real child stops its shell when the owning process disappears", {
  timeout: 30_000,
}, async (t) => {
  const { dir } = await fixture(t, false, "sleep");
  const launch = {
    cwd: dir,
    provider: "mock",
    model: "test-model",
    thinking: "off",
    trusted: false,
    extensions: [],
    activeTools: ["bash"],
    requiredTools: ["bash"],
    task: "Run a command",
  };
  const runner = new URL("../src/runner.ts", import.meta.url).href;
  const owner = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import {startChild} from ${JSON.stringify(runner)}; const task=startChild(${JSON.stringify(launch)}); await task.ready; task.run(); await task.done;`,
    ],
    { stdio: "ignore" },
  );
  const ownerExit = new Promise<void>((resolve) => owner.on("close", () => resolve()));
  t.after(async () => {
    owner.kill("SIGKILL");
    await ownerExit;
  });
  let pid: number | undefined;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      pid = Number(await readFile(join(dir, "shell.pid"), "utf8"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.ok(pid);
  owner.kill("SIGKILL");
  await ownerExit;
  let gone = false;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      gone = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(gone, "IPC disconnect must terminate the child and its tracked shell");
});

test("real Pi CLI starts fresh, writes files, excludes recursion, and reports completion", {
  timeout: 30_000,
}, async (t) => {
  const { dir, requests } = await fixture(t, true);
  const execution = startChild({
    cwd: dir,
    provider: "mock",
    model: "test-model",
    thinking: "off",
    trusted: false,
    extensions: [fileURLToPath(new URL("../", import.meta.url))],
    activeTools: ["read", "write", "bash"],
    requiredTools: ["read", "write", "bash"],
    cliFlags: ["--append-system-prompt", "Project rule: preserve unrelated files."],
    task: "Write the requested file and report.",
  });
  t.after(() => execution.cancel());
  await execution.ready;
  assert.equal(requests.length, 0, "no model requests before handoff");
  execution.run();
  const result = await execution.done;
  assert.equal(result.status, "completed", result.report);
  assert.match(result.report, /Implemented/u);
  assert.equal(await readFile(join(dir, "result.txt"), "utf8"), "child wrote this");
  assert.equal(await readFile(join(dir, "checked.txt"), "utf8"), "checked");
  assert.equal(result.requests, 3);
  const first = requests[0];
  assert.ok(first);
  assert.match(JSON.stringify(first.messages), /Project rule: preserve unrelated files/u);
  assert.match(JSON.stringify(first.messages), /Write the requested file/u);
  assert.ok(!JSON.stringify(first.tools).includes('"name":"subagent"'));
});

test("explicit extensions reload tools and execute their permission hooks in the child", {
  timeout: 30_000,
}, async (t) => {
  const { dir, requests } = await fixture(t);
  const extension = join(dir, "gate.ts");
  await writeFile(
    extension,
    `export default function(pi) {
    pi.registerTool({name:'sentinel',label:'Sentinel',description:'Test tool',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'ok'}],details:{}})});
    pi.on('tool_call',event=>{if(event.toolName==='write')return {block:true,reason:'Fixture denies writing'};});
  }`,
  );
  const execution = startChild({
    cwd: dir,
    provider: "mock",
    model: "test-model",
    thinking: "off",
    trusted: false,
    extensions: [extension],
    activeTools: ["read", "write", "sentinel"],
    requiredTools: ["read", "write", "sentinel"],
    task: "Write a file",
  });
  t.after(() => execution.cancel());
  await execution.ready;
  execution.run();
  const result = await execution.done;
  assert.equal(result.status, "completed", result.report);
  await assert.rejects(readFile(join(dir, "result.txt")), { code: "ENOENT" });
  assert.match(JSON.stringify(requests), /Fixture denies writing/u);
  assert.match(JSON.stringify(requests[0]?.tools), /sentinel/u);
});

test("missing child tools fail before the first model request", { timeout: 30_000 }, async (t) => {
  const { dir, requests } = await fixture(t);
  const execution = startChild({
    cwd: dir,
    provider: "mock",
    model: "test-model",
    thinking: "off",
    trusted: false,
    extensions: [],
    activeTools: ["read"],
    requiredTools: ["read", "not_installed"],
    task: "Do work",
  });
  t.after(() => execution.cancel());
  await assert.rejects(execution.ready, /missing tools: not_installed/u);
  assert.equal((await execution.done).status, "failed");
  assert.equal(requests.length, 0);
});

async function parentSession(
  t: TestContext,
  dir: string,
  discover = false,
  extensions: string[] = [],
  tools: string[] = [],
) {
  let api: ExtensionAPI | undefined;
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: !discover,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) => {
        api = pi;
      },
    ],
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url)), ...extensions],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    refreshOnCreate: false,
  });
  const model = runtime.getModel("mock", "test-model");
  assert.ok(model);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(dir),
    tools: ["read", "write", "bash", "subagent", "subagent_cancel", ...tools],
  });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await session.abort();
    session.dispose();
  });
  const notices: string[] = [];
  const statuses = new Map<string, string>();
  const statusUpdates: { key: string; text: string | undefined }[] = [];
  await session.bindExtensions({
    mode: "rpc",
    uiContext: {
      ...session.extensionRunner.createContext().ui,
      notify: (message) => {
        notices.push(message);
      },
      setStatus: (key, text) => {
        statusUpdates.push({ key, text });
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
    },
  });
  const tool = session.agent.state.tools.find((entry) => entry.name === "subagent");
  const cancelTool = session.agent.state.tools.find((entry) => entry.name === "subagent_cancel");
  assert.ok(tool);
  assert.ok(cancelTool);
  assert.ok(api);
  return { session, tool, cancelTool, api, notices, statuses, statusUpdates };
}

test("children rebuild their prompt without inherited delegation rules or double-applied hooks", {
  timeout: 30_000,
}, async (t) => {
  const { dir, requests } = await fixture(t);
  await mkdir(join(dir, "extensions"));
  await writeFile(join(dir, "AGENTS.md"), "PROJECT_INSTRUCTION_MARKER");
  await writeFile(
    join(dir, "extensions", "prompt.ts"),
    `export default function(pi) {
    pi.on('before_agent_start', event => ({systemPrompt:event.systemPrompt+'\\nDISCOVERED_HOOK_MARKER'}));
  }`,
  );
  const { session, tool } = await parentSession(t, dir, true);
  await session.prompt("Subagent coordination: finish this parent turn.");
  assert.match(JSON.stringify(requests[0]), /Delegate well-scoped independent work/u);
  assert.match(JSON.stringify(requests[0]), /DISCOVERED_HOOK_MARKER/u);
  const notification = new Promise<void>((resolve) => {
    session.sendCustomMessage = async () => {
      resolve();
    };
  });
  await tool.execute("delegate", { task: "Write the file." });
  await notification;
  const child = requests.find((request) =>
    JSON.stringify(request.messages).includes("Delegated task:"),
  );
  assert.ok(child);
  const transcript = JSON.stringify(child.messages);
  assert.equal(transcript.match(/DISCOVERED_HOOK_MARKER/gu)?.length, 1);
  assert.equal(transcript.match(/You are a child agent executing/gu)?.length, 1);
  assert.match(transcript, /PROJECT_INSTRUCTION_MARKER/u);
  assert.doesNotMatch(transcript, /Delegate well-scoped independent work|Subagent coordination/u);
  assert.doesNotMatch(JSON.stringify(child.tools), /"name":"subagent"/u);
});

test("explicit CLI prompt files and repeated append inputs reach child hooks exactly once", {
  timeout: 30_000,
}, async (t) => {
  const { dir, requests } = await fixture(t);
  await writeFile(join(dir, "base.md"), "EXPLICIT_BASE_MARKER");
  await writeFile(join(dir, "append.md"), "APPEND_FILE_MARKER");
  const extension = join(dir, "hook.ts");
  await writeFile(
    extension,
    `export default function(pi) {
    pi.on('before_agent_start', event => ({systemPrompt:event.systemPrompt+'\\nEXPLICIT_HOOK_MARKER'}));
  }`,
  );
  const options = parentOptions(
    [
      "--system-prompt",
      "base.md",
      "--append-system-prompt",
      "APPEND_LITERAL_MARKER",
      "--append-system-prompt",
      "append.md",
      "-e",
      extension,
    ],
    dir,
  );
  const execution = startChild({
    cwd: dir,
    provider: "mock",
    model: "test-model",
    thinking: "off",
    trusted: false,
    extensions: options.extensions,
    cliFlags: options.flags,
    activeTools: ["write"],
    requiredTools: ["write"],
    task: "Write the file.",
  });
  t.after(() => execution.cancel());
  await execution.ready;
  execution.run();
  assert.equal((await execution.done).status, "completed");
  const transcript = JSON.stringify(requests[0]?.messages);
  for (const marker of [
    "EXPLICIT_BASE_MARKER",
    "APPEND_LITERAL_MARKER",
    "APPEND_FILE_MARKER",
    "EXPLICIT_HOOK_MARKER",
    "You are a child agent executing",
  ])
    assert.equal(transcript.split(marker).length - 1, 1, marker);
  assert.ok(transcript.indexOf("APPEND_LITERAL_MARKER") < transcript.indexOf("APPEND_FILE_MARKER"));
});

for (const offline of ["environment", "flag"]) {
  test(`-ne keeps discovery disabled with explicit extensions and offline ${offline}`, {
    timeout: 30_000,
  }, async (t) => {
    const { dir } = await fixture(t);
    // Exercise both inheritance and CLI --offline without an inherited setting.
    if (offline === "flag") delete process.env.PI_OFFLINE;
    await mkdir(join(dir, "extensions"));
    const marker = join(dir, "discovered.txt");
    await writeFile(
      join(dir, "extensions", "ambient.ts"),
      `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync(${JSON.stringify(marker)},'loaded');}`,
    );
    const explicit = join(dir, "explicit.ts");
    await writeFile(
      explicit,
      `export default function(pi) {
    if(process.env.PI_OFFLINE!=='1')throw new Error('Offline was not forwarded');
    pi.registerTool({name:'explicit_tool',label:'Explicit',description:'Fixture',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'ok'}],details:{}})});
  }`,
    );
    const options = parentOptions(
      ["-ne", ...(offline === "flag" ? ["--offline"] : []), "-e", explicit],
      dir,
    );
    const execution = startChild({
      cwd: dir,
      provider: "mock",
      model: "test-model",
      thinking: "off",
      trusted: false,
      extensions: options.extensions,
      cliFlags: options.flags,
      activeTools: ["write", "explicit_tool"],
      requiredTools: ["write", "explicit_tool"],
      task: "Write the file.",
    });
    t.after(() => execution.cancel());
    await execution.ready;
    execution.run();
    assert.equal((await execution.done).status, "completed");
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  });
}

for (const noMcp of [false, true]) {
  test(`MCP process startup respects no-mcp=${noMcp}, including explicit builtin:mcp`, {
    timeout: 30_000,
  }, async (t) => {
    const { dir } = await fixture(t);
    const marker = join(dir, "mcp-started.txt");
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.exit(0);`,
            ],
          },
        },
      }),
    );
    const options = parentOptions([...(noMcp ? ["--no-mcp"] : []), "-e", "builtin:mcp"], dir);
    const execution = startChild({
      cwd: dir,
      provider: "mock",
      model: "test-model",
      thinking: "off",
      trusted: false,
      extensions: options.extensions,
      cliFlags: options.flags,
      activeTools: ["write"],
      requiredTools: ["write"],
      task: "Write the file.",
    });
    t.after(() => execution.cancel());
    await execution.ready;
    execution.run();
    assert.equal((await execution.done).status, "completed");
    if (noMcp) await assert.rejects(readFile(marker), { code: "ENOENT" });
    else assert.equal(await readFile(marker, "utf8"), "started");
  });
}

test("disabled discovery is not reopened by parent tool-source metadata", {
  timeout: 30_000,
}, async (t) => {
  const { dir } = await fixture(t);
  const extension = join(dir, "extra.ts");
  await writeFile(
    extension,
    `export default function(pi){pi.registerTool({name:'extra',label:'Extra',description:'Fixture',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'ok'}],details:{}})});}`,
  );
  const { session, api } = await parentSession(t, dir, false, [extension], ["extra"]);
  const original = process.argv;
  process.argv = [process.execPath, "pi", "-ne", "--no-mcp", "-e", "npm:@example/pi-tools"];
  t.after(() => {
    process.argv = original;
  });
  const launch = environment(
    api,
    session.extensionRunner.createToolContext("test", undefined),
    "Task",
  );
  assert.deepEqual(launch.extensions, ["npm:@example/pi-tools"]);
  assert.ok(launch.requiredTools.includes("extra"));
  assert.deepEqual(launch.cliFlags, ["--no-extensions", "--no-mcp"]);
});

for (const exposure of ["deferred", "codemode"]) {
  for (const excluded of [false, true]) {
    test(`non-active ${exposure} tools remain callable without direct exposure (excluded=${excluded})`, {
      timeout: 30_000,
    }, async (t) => {
      const { dir, requests } = await fixture(t, false, "indirect");
      const extension = join(dir, "indirect.ts");
      await writeFile(
        extension,
        `export default function(pi) {
        pi.registerTool({name:'extra',label:'Extra',description:'Indirect fixture',exposure:${JSON.stringify(exposure)},
          promptGuidelines:['EXTRA_ACTIVE_GUIDELINE'],parameters:{type:'object',properties:{}},
          execute:async()=>({content:[{type:'text',text:'INDIRECT_RESULT'}],details:{}})});
        pi.registerTool({name:'invoke_extra',label:'Invoke',description:'Call extra indirectly',
          promptGuidelines:['INVOKER_ACTIVE_GUIDELINE'],parameters:{type:'object',properties:{}},
          execute:async(_id,_args,signal,_update,ctx)=>{
            const outcome=await ctx.executeTool('extra',{}, {signal});
            if(outcome.isError)throw new Error('Indirect call failed');
            return outcome.result;
          }});
        pi.registerTool({name:'unselected',label:'Unselected',description:'Inactive direct tool',
          parameters:{type:'object',properties:{}},execute:async()=>({content:[],details:{}})});
      }`,
      );
      const { session, api } = await parentSession(
        t,
        dir,
        false,
        [extension],
        ["extra", "invoke_extra", "unselected"],
      );
      api.setActiveTools(["invoke_extra"]);
      const context = session.extensionRunner.createToolContext("delegate", undefined);
      assert.ok(context.tools.some((tool) => tool.name === "extra"));
      assert.ok(!context.tools.some((tool) => tool.name === "unselected"));
      const launch = environment(api, context, "Call the indirect tool and report.");
      assert.deepEqual(launch.activeTools, ["invoke_extra"]);
      assert.ok(launch.requiredTools.includes("extra"));
      assert.ok(!launch.requiredTools.includes("unselected"));
      if (excluded) launch.cliFlags = [...(launch.cliFlags ?? []), "--exclude-tools", "extra"];
      const execution = startChild(launch);
      t.after(() => execution.cancel());
      if (excluded) {
        await assert.rejects(execution.ready, /missing tools: extra/u);
        assert.equal((await execution.done).status, "failed");
        assert.equal(requests.length, 0);
        return;
      }
      await execution.ready;
      execution.run();
      const result = await execution.done;
      assert.equal(result.status, "completed", result.report);
      assert.equal(requests.length, 2);
      const first = requests[0];
      assert.ok(first);
      assert.ok(Array.isArray(first.tools));
      assert.deepEqual(
        first.tools
          .filter(record)
          .map((tool) => (record(tool.function) ? tool.function.name : undefined)),
        ["invoke_extra"],
      );
      const prompt = JSON.stringify(first.messages);
      assert.match(prompt, /INVOKER_ACTIVE_GUIDELINE/u);
      assert.doesNotMatch(prompt, /EXTRA_ACTIVE_GUIDELINE/u);
      const second = requests[1];
      assert.ok(second && Array.isArray(second.messages));
      const response = second.messages.filter(record).find((message) => message.role === "tool");
      assert.ok(response);
      assert.match(JSON.stringify(response.content), /INDIRECT_RESULT/u);
    });
  }
}

for (const busy of [false, true]) {
  test(`completion uses steer with an ${busy ? "active" : "idle"} parent`, {
    timeout: 30_000,
  }, async (t) => {
    const { dir, requests, delay } = await fixture(t);
    const { session, tool } = await parentSession(t, dir);
    const seen: { delivery: string | undefined; trigger: boolean | undefined }[] = [];
    let activeAtDelivery = false;
    const send = session.sendCustomMessage.bind(session);
    session.sendCustomMessage = async (message, options) => {
      activeAtDelivery = !session.isIdle;
      seen.push({ delivery: options?.deliverAs, trigger: options?.triggerTurn });
      return send(message, options);
    };
    const turn = new AbortController();
    const started = await tool.execute(
      "delegate",
      { task: "Write a file and report." },
      turn.signal,
    );
    assert.match(JSON.stringify(started), /Started subagent/u);
    turn.abort();
    let parentWork: Promise<unknown> | undefined;
    if (busy) {
      delay(500);
      parentWork = session.prompt("Subagent coordination: perform independent work.");
    }
    const deadline = Date.now() + 15_000;
    while (seen.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(seen, [{ delivery: "steer", trigger: true }]);
    assert.equal(activeAtDelivery, busy);
    await parentWork;
    await session.waitForIdle();
    assert.equal(await readFile(join(dir, "result.txt"), "utf8"), "child wrote this");
    assert.ok(requests.length >= 3, "completion wakes or steers the parent");
  });
}

test("root shutdown cancels an active child without notification", {
  timeout: 30_000,
}, async (t) => {
  const { dir, requests, delay } = await fixture(t);
  const { session, tool } = await parentSession(t, dir);
  delay(1000);
  let notifications = 0;
  session.sendCustomMessage = async () => {
    notifications++;
  };
  await tool.execute("delegate", { task: "Write a file and report." });
  const deadline = Date.now() + 10_000;
  while (requests.length === 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(requests.length > 0);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
  assert.equal(notifications, 0);
  await assert.rejects(readFile(join(dir, "result.txt")), { code: "ENOENT" });
});

test("package discovery and tool execution reject nonpersistent host modes", {
  timeout: 30_000,
}, async (t) => {
  const { dir } = await fixture(t);
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    refreshOnCreate: false,
  });
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(dir),
    tools: ["subagent", "subagent_cancel", "subagent_list", "subagent_send", "subagent_wait"],
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "print" });
  assert.deepEqual(session.getActiveToolNames(), [
    "subagent",
    "subagent_cancel",
    "subagent_list",
    "subagent_send",
    "subagent_wait",
  ]);
  for (const [name, args] of [
    ["subagent", { task: "do work" }],
    ["subagent_list", {}],
    ["subagent_send", { to: "*", message: "ping" }],
    ["subagent_wait", { timeoutSeconds: 1 }],
  ] as const) {
    const registered = session.agent.state.tools.find((entry) => entry.name === name);
    assert.ok(registered);
    await assert.rejects(registered.execute(`check-${name}`, args), /require tui or rpc/u);
  }
});

test("installed package outside workspace node_modules launches and completes a real child", {
  timeout: 30_000,
}, async (t) => {
  const { dir } = await fixture(t, false, "delegate");
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  const installedRoot = join(dir, "packages", "subagents");
  await mkdir(installedRoot, { recursive: true });
  const manifest: unknown = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  assert.ok(record(manifest) && Array.isArray(manifest.files));
  const entries = [
    "package.json",
    "LICENSE",
    ...manifest.files.filter((entry): entry is string => typeof entry === "string"),
  ];
  for (const entry of entries) {
    await cp(join(sourceRoot, entry), join(installedRoot, entry), { recursive: true });
  }
  const client = new RpcClient({
    cliPath: join(getPackageDir(), "dist", "bundle", "cli.js"),
    cwd: dir,
    provider: "mock",
    model: "test-model",
    args: ["--no-session", "-ne", "-ns", "-np", "--no-themes", "-e", installedRoot],
  });
  t.after(() => client.stop());
  let report = "";
  const completed = new Promise<void>((resolve, reject) => {
    client.onEvent((event) => {
      if (event.type === "tool_execution_end" && event.isError) {
        reject(new Error(`Tool failed: ${JSON.stringify(event.result)}`));
      }
      if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "subagent:result" &&
        typeof event.message.content === "string"
      ) {
        report = event.message.content;
      }
      if (event.type === "agent_settled" && report) {
        resolve();
      }
    });
  });
  await client.start();
  await client.prompt("Delegate the work.");
  await completed;
  assert.match(report, /: completed\n[\s\S]*Implemented and checked\./u);
  assert.equal(await readFile(join(dir, "result.txt"), "utf8"), "child wrote this");
});

test("/subagents snapshot, status updates, and subagents.json limits work end-to-end", {
  timeout: 30_000,
}, async (t) => {
  const { dir, requests, delay } = await fixture(t, false, "loop");
  const { session, tool, cancelTool, notices, statuses, statusUpdates } = await parentSession(
    t,
    dir,
  );
  statuses.set("other-extension", "unchanged");
  assert.deepEqual(statusUpdates, [{ key: "subagents", text: undefined }]);
  assert.ok(session.extensionRunner.getMessageRenderer("subagent:result"));

  const initialMessages = [...session.messages];
  await session.prompt("/subagents");
  assert.deepEqual(notices, ["No subagents running."]);
  assert.deepEqual(session.messages, initialMessages);

  await writeFile(join(dir, "subagents.json"), "{broken");
  await assert.rejects(
    tool.execute("bad-config", { task: "Must not start." }),
    /Invalid subagents configuration/u,
  );
  assert.equal(requests.length, 0);
  assert.equal(statuses.has("subagents"), false);

  await writeFile(
    join(dir, "subagents.json"),
    JSON.stringify({ maxConcurrent: 1, maxRequests: 2 }),
  );
  delay(800);
  const started = await tool.execute("first", { task: "First task\nwith details" });
  const firstId = (started.details as { id?: string }).id;
  assert.ok(firstId);
  assert.equal(statuses.get("subagents"), "subagents: 1 running");

  await assert.rejects(tool.execute("over-limit", { task: "Second task" }), /At most 1 subagents/u);

  await session.prompt("/subagents");
  assert.equal(notices.length, 2);
  assert.match(
    notices[1] ?? "",
    new RegExp(
      `^Subagents · 1 running\\n\\n${firstId} {2}running {2}\\d+s\\n {2}First task\\n {2}with details$`,
      "u",
    ),
  );
  assert.deepEqual(session.messages, initialMessages);

  const cancelled = await cancelTool.execute("cancel-first", { id: firstId });
  assert.match(JSON.stringify(cancelled), /cancelled/u);
  assert.equal(statuses.has("subagents"), false);
  assert.equal(statuses.get("other-extension"), "unchanged");

  delay(0);
  const finished = new Promise<{ details?: unknown }>((resolve) => {
    session.sendCustomMessage = async (message) => {
      resolve(message);
    };
  });
  await tool.execute("bounded-turns", { task: "Loop until maxRequests." });
  const delivered = await finished;
  assert.equal(statuses.has("subagents"), false);
  assert.ok(record(delivered.details));
  assert.equal(delivered.details.status, "limit_reached");
  assert.equal(delivered.details.requests, 2);
});

async function communicationFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagents-comm-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_OFFLINE = "1";
  t.after(() => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = oldOffline;
  });

  let releaseMain: () => void = () => {};
  const mainHeld = new Promise<void>((resolve) => {
    releaseMain = resolve;
  });
  t.after(() => releaseMain());
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed: unknown = JSON.parse(body);
    assert.ok(record(parsed));
    const messages = Array.isArray(parsed.messages) ? parsed.messages.filter(record) : [];
    const transcript = JSON.stringify(messages);
    const toolMessages = messages.filter((entry) => entry.role === "tool");

    res.writeHead(200, { "content-type": "text/event-stream" });
    const respondText = (text: string) => {
      const chunk = {
        id: "mock",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          ...chunk,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    };
    const respondToolCalls = (
      calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
    ) => {
      calls.forEach((call, index) => {
        const toolCall = {
          index,
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        };
        const chunk = {
          id: "mock",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              delta:
                index === 0
                  ? { role: "assistant", tool_calls: [toolCall] }
                  : { tool_calls: [toolCall] },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      });
      res.write(
        `data: ${JSON.stringify({
          id: "mock",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    };

    if (transcript.includes("Delegated task:\\n\\nASK_MAIN_FOR_PORT")) {
      if (transcript.includes("PORT_IS_9090")) {
        if (toolMessages.some((entry) => JSON.stringify(entry).includes("port.txt"))) {
          respondText("Configured port 9090.");
        } else {
          respondToolCalls([
            { id: "write-port", name: "write", args: { path: "port.txt", content: "9090" } },
          ]);
        }
      } else {
        respondToolCalls([
          {
            id: "ask-main",
            name: "subagent_send",
            args: { to: "main", message: "NEED_PORT_DECISION" },
          },
          { id: "wait-main", name: "subagent_wait", args: { timeoutSeconds: 10 } },
        ]);
      }
      return;
    }

    if (transcript.includes("Delegated task:\\n\\nROLE_RECEIVER")) {
      if (transcript.includes("DIRECT_SECRET_77")) {
        respondText("Receiver confirmed DIRECT_SECRET_77.");
      } else {
        respondToolCalls([
          { id: "wait-peer", name: "subagent_wait", args: { timeoutSeconds: 10 } },
        ]);
      }
      return;
    }

    if (transcript.includes("Delegated task:\\n\\nROLE_SENDER")) {
      if (toolMessages.length === 0) {
        respondToolCalls([{ id: "discover", name: "subagent_list", args: {} }]);
      } else if (toolMessages.length === 1) {
        const listing = JSON.stringify(toolMessages[0]?.content ?? "");
        const peerMatch = /- ([0-9a-f-]{36}) ·/u.exec(listing);
        assert.ok(peerMatch?.[1], `Expected live sibling UUID in listing: ${listing}`);
        respondToolCalls([
          {
            id: "send-direct",
            name: "subagent_send",
            args: { to: peerMatch[1], message: "DIRECT_SECRET_77" },
          },
          {
            id: "send-broadcast",
            name: "subagent_send",
            args: { to: "*", message: "BROADCAST_PING" },
          },
        ]);
      } else {
        respondText("Sender notified peers.");
      }
      return;
    }

    if (transcript.includes("Delegated task:\\n\\nNOTIFY_MAIN_THEN_STAY")) {
      respondToolCalls(
        toolMessages.length === 0
          ? [{ id: "notify", name: "subagent_send", args: { to: "main", message: "NOTE_1" } }]
          : [{ id: "stay", name: "subagent_wait", args: { timeoutSeconds: 30 } }],
      );
      return;
    }

    if (transcript.includes("HOLD_MAIN")) await mainHeld;
    respondText("Ack.");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "test-only",
          models: [
            {
              id: "test-model",
              name: "Test",
              reasoning: false,
              input: ["text"],
              contextWindow: 32000,
              maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  return { dir, releaseMain };
}

test("updates the host drops from its queue stop counting as queued", {
  timeout: 30_000,
}, async (t) => {
  const { dir, releaseMain } = await communicationFixture(t);
  const { session, tool, cancelTool } = await parentSession(
    t,
    dir,
    false,
    [],
    ["subagent_list", "subagent_send", "subagent_wait"],
  );
  const waitTool = session.agent.state.tools.find((entry) => entry.name === "subagent_wait");
  assert.ok(waitTool);
  const original = session.sendCustomMessage.bind(session);
  const queued = new Promise<void>((resolve) => {
    session.sendCustomMessage = async (message, options) => {
      const sent = original(message, options);
      if (message.customType === "subagent:message") resolve();
      return sent;
    };
  });

  const busy = session.prompt("HOLD_MAIN");
  const started = await tool.execute("start", { task: "NOTIFY_MAIN_THEN_STAY" });
  const childId = (started.details as { id?: string }).id;
  assert.ok(childId);
  await queued;
  assert.equal(session.isStreaming, true);

  // RPC clear_queue: the queued peer message is dropped without a message_end.
  session.clearQueue();
  releaseMain();
  await busy;
  assert.doesNotMatch(JSON.stringify(session.messages), /NOTE_1/u);

  await cancelTool.execute("cancel", { id: childId });
  for (const call of ["first", "second"]) {
    const waited = await waitTool.execute(call, { timeoutSeconds: 5 });
    assert.deepEqual(waited.details, { outcome: "idle", waitedMs: 0 });
  }
});

test("live child and main exchange messages and completed children reject later messages", {
  timeout: 30_000,
}, async (t) => {
  const { dir } = await communicationFixture(t);
  const { session, tool } = await parentSession(
    t,
    dir,
    false,
    [],
    ["subagent_list", "subagent_send", "subagent_wait"],
  );
  const sendTool = session.agent.state.tools.find((entry) => entry.name === "subagent_send");
  const listTool = session.agent.state.tools.find((entry) => entry.name === "subagent_list");
  assert.ok(sendTool && listTool);
  assert.ok(session.extensionRunner.getMessageRenderer("subagent:message"));

  const childQuestion = new Promise<{ content?: unknown; details?: unknown }>((resolve) => {
    const original = session.sendCustomMessage.bind(session);
    session.sendCustomMessage = async (message, options) => {
      if (message.customType === "subagent:message") resolve(message);
      return original(message, options);
    };
  });

  let finalReport: { content?: unknown; details?: unknown } | undefined;
  const childCompleted = new Promise<void>((resolve) => {
    const current = session.sendCustomMessage.bind(session);
    session.sendCustomMessage = async (message, options) => {
      if (message.customType === "subagent:result") {
        finalReport = message;
        resolve();
      }
      return current(message, options);
    };
  });

  const started = await tool.execute("start-worker", { task: "ASK_MAIN_FOR_PORT" });
  const childId = (started.details as { id?: string }).id;
  assert.ok(childId);

  const listed = await listTool.execute("list-live", {});
  assert.match(JSON.stringify(listed), new RegExp(childId, "u"));

  const question = await childQuestion;
  assert.match(String(question.content), /NEED_PORT_DECISION/u);
  assert.ok(record(question.details));
  assert.equal(question.details.from, childId);

  await sendTool.execute("reply-port", { to: childId, message: "PORT_IS_9090" });
  await childCompleted;
  await session.waitForIdle();

  assert.equal(await readFile(join(dir, "port.txt"), "utf8"), "9090");
  assert.ok(finalReport && record(finalReport.details));
  assert.equal(finalReport.details.status, "completed");
  assert.match(String(finalReport.content), /Configured port 9090\./u);

  // Autonomously completed subagents never receive further messages.
  await assert.rejects(
    sendTool.execute("late-send", { to: childId, message: "PORT_CHANGED" }),
    /already finished \(completed\) and cannot receive messages/u,
  );
});

test("sibling subagents discover peers and exchange direct and broadcast messages", {
  timeout: 30_000,
}, async (t) => {
  const { dir } = await communicationFixture(t);
  const { session, tool } = await parentSession(
    t,
    dir,
    false,
    [],
    ["subagent_list", "subagent_send", "subagent_wait"],
  );

  const broadcasts: Record<string, unknown>[] = [];
  const results = new Map<string, Record<string, unknown>>();
  const bothDone = new Promise<void>((resolve) => {
    const original = session.sendCustomMessage.bind(session);
    session.sendCustomMessage = async (message, options) => {
      if (message.customType === "subagent:message" && record(message.details)) {
        broadcasts.push(message.details);
      }
      if (
        message.customType === "subagent:result" &&
        record(message.details) &&
        typeof message.details.id === "string"
      ) {
        results.set(message.details.id, message.details);
        if (results.size === 2) resolve();
      }
      return original(message, options);
    };
  });

  const receiver = await tool.execute("start-receiver", { task: "ROLE_RECEIVER" });
  const receiverId = (receiver.details as { id?: string }).id;
  assert.ok(receiverId);

  const sender = await tool.execute("start-sender", { task: "ROLE_SENDER" });
  const senderId = (sender.details as { id?: string }).id;
  assert.ok(senderId);

  await bothDone;
  await session.waitForIdle();

  assert.equal(results.get(receiverId)?.status, "completed");
  assert.match(String(results.get(receiverId)?.report), /Receiver confirmed DIRECT_SECRET_77\./u);
  assert.equal(results.get(senderId)?.status, "completed");
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0]?.from, senderId);
  assert.equal(broadcasts[0]?.broadcast, true);
  assert.equal(broadcasts[0]?.message, "BROADCAST_PING");
});
