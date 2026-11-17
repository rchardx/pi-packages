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
      mcpTools: [],
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
    mcpTools: [],
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
    mcpTools: [],
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
    mcpTools: [],
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
    mcpTools: [],
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
    mcpTools: [],
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

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
interface Delivered {
  customType: string;
  content: unknown;
  details: unknown;
  via: "entry_appended" | "message_end";
}

/** Updates as hosts observe them: appended entries, or the message starting a run. */
function deliveredUpdates(session: Session) {
  const seen: Delivered[] = [];
  const waiting = new Set<() => void>();
  const add = (update: Delivered) => {
    seen.push(update);
    for (const check of [...waiting]) check();
  };
  session.subscribe((event) => {
    if (event.type === "entry_appended" && event.entry.type === "custom_message") {
      const { customType, content, details } = event.entry;
      add({ customType, content, details, via: "entry_appended" });
    } else if (event.type === "message_end" && event.message.role === "custom") {
      const { customType, content, details } = event.message;
      add({ customType, content, details, via: "message_end" });
    }
  });
  return {
    seen,
    next(customType: string, from = 0): Promise<Delivered> {
      return new Promise((resolve) => {
        const check = () => {
          const found = seen.slice(from).find((update) => update.customType === customType);
          if (!found) return;
          waiting.delete(check);
          resolve(found);
        };
        waiting.add(check);
        check();
      });
    },
  };
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
    mcpTools: [],
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
      mcpTools: [],
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
      mcpTools: [],
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
  test(`completion reaches an ${busy ? "active" : "idle"} parent without the steering queue`, {
    timeout: 30_000,
  }, async (t) => {
    const { dir, requests, delay } = await fixture(t);
    const { session, tool } = await parentSession(t, dir);
    const updates = deliveredUpdates(session);
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
    const report = await updates.next("subagent:result");
    // A busy parent receives the report at a run boundary; an idle one is started by it.
    assert.equal(report.via, busy ? "entry_appended" : "message_end");
    assert.match(String(report.content), /: completed\n[\s\S]*Implemented and checked\./u);
    await parentWork;
    await session.waitForIdle();
    assert.equal(updates.seen.length, 1);
    assert.equal(session.pendingMessageCount, 0);
    assert.equal(await readFile(join(dir, "result.txt"), "utf8"), "child wrote this");
    assert.match(JSON.stringify(requests.at(-1)), /Subagent [0-9a-f-]{36}: completed/u);
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
      // An idle root is started by the report; a busy one receives it as an appended entry.
      if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "subagent:result" &&
        typeof event.message.content === "string"
      ) {
        report = event.message.content;
      }
      if (
        event.type === "entry_appended" &&
        event.entry.type === "custom_message" &&
        event.entry.customType === "subagent:result" &&
        typeof event.entry.content === "string"
      ) {
        report = event.entry.content;
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
  let childHeld: Promise<void> | undefined;
  let releaseChild: () => void = () => {};
  const holdChild = () => {
    childHeld = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
  };
  t.after(() => releaseChild());
  let mainRequests = 0;
  let lastMain = "";
  let failMain = false;
  let nextMainHeld: Promise<void> | undefined;
  let notes = 0;
  let noteAccepted: () => void = () => {};
  const noteSent = new Promise<void>((resolve) => {
    noteAccepted = resolve;
  });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed: unknown = JSON.parse(body);
    assert.ok(record(parsed));
    const messages = Array.isArray(parsed.messages) ? parsed.messages.filter(record) : [];
    const transcript = JSON.stringify(messages);
    const toolMessages = messages.filter((entry) => entry.role === "tool");

    const respondText = (text: string) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
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
      res.writeHead(200, { "content-type": "text/event-stream" });
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
      // The child asks again only after its send was accepted by the root session.
      if (toolMessages.length === 1) notes++;
      if (toolMessages.length > 0) noteAccepted();
      else await childHeld;
      respondToolCalls(
        toolMessages.length === 0
          ? [{ id: "notify", name: "subagent_send", args: { to: "main", message: "NOTE_1" } }]
          : [{ id: "stay", name: "subagent_wait", args: { timeoutSeconds: 30 } }],
      );
      return;
    }

    mainRequests++;
    lastMain = transcript;
    if (transcript.includes("MAIN_WAITS")) {
      if (toolMessages.length === 0) {
        respondToolCalls([
          { id: "delegate", name: "subagent", args: { task: "NOTIFY_MAIN_THEN_STAY" } },
        ]);
      } else if (transcript.includes("NOTE_1")) {
        respondText("Root saw NOTE_1.");
      } else {
        respondToolCalls([{ id: "wait", name: "subagent_wait", args: { timeoutSeconds: 20 } }]);
      }
      return;
    }
    if (transcript.includes("HOLD_MAIN")) await mainHeld;
    if (nextMainHeld) {
      const held = nextMainHeld;
      nextMainHeld = undefined;
      await held;
    }
    if (failMain) {
      failMain = false;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Internal server error" } }));
      return;
    }
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
  return {
    dir,
    releaseMain,
    noteSent,
    mainRequests: () => mainRequests,
    notes: () => notes,
    lastMain: () => lastMain,
    holdNextMain: () => {
      let release: () => void = () => {};
      nextMainHeld = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.after(() => release());
      return release;
    },
    failNextMain: () => {
      failMain = true;
    },
    holdChild,
    releaseChild: () => releaseChild(),
  };
}

test("updates for a busy root survive the host clearing its steering queue", {
  timeout: 30_000,
}, async (t) => {
  const { dir, releaseMain, noteSent } = await communicationFixture(t);
  const { session, tool, cancelTool } = await parentSession(
    t,
    dir,
    false,
    [],
    ["subagent_list", "subagent_send", "subagent_wait"],
  );
  const waitTool = session.agent.state.tools.find((entry) => entry.name === "subagent_wait");
  assert.ok(waitTool);
  const updates = deliveredUpdates(session);

  const busy = session.prompt("HOLD_MAIN");
  const started = await tool.execute("start", { task: "NOTIFY_MAIN_THEN_STAY" });
  const childId = (started.details as { id?: string }).id;
  assert.ok(childId);
  await noteSent;
  assert.equal(session.isStreaming, true);
  assert.equal(updates.seen.length, 0, "nothing is handed to Pi before a run boundary");

  // RPC clear_queue and the TUI's queue restore drop queued steering messages.
  session.clearQueue();
  const pending = await waitTool.execute("pending", { timeoutSeconds: 5 });
  assert.deepEqual(pending.details, { outcome: "woke", waitedMs: 0 });
  releaseMain();
  await busy;
  await session.waitForIdle();

  assert.equal(updates.seen.length, 1);
  const [note] = updates.seen;
  assert.equal(note?.via, "entry_appended");
  assert.ok(record(note?.details));
  assert.equal(note.details.from, childId);
  assert.match(JSON.stringify(session.messages), /NOTE_1/u);

  await cancelTool.execute("cancel", { id: childId });
  for (const call of ["first", "second"]) {
    const waited = await waitTool.execute(call, { timeoutSeconds: 5 });
    assert.deepEqual(waited.details, { outcome: "idle", waitedMs: 0 });
  }
});

test("an aborted root run records pending updates without starting another run", {
  timeout: 30_000,
}, async (t) => {
  const { dir, noteSent, mainRequests } = await communicationFixture(t);
  const { session, tool } = await parentSession(
    t,
    dir,
    false,
    [],
    ["subagent_list", "subagent_send", "subagent_wait"],
  );
  const updates = deliveredUpdates(session);

  const busy = session.prompt("HOLD_MAIN");
  await tool.execute("start", { task: "NOTIFY_MAIN_THEN_STAY" });
  await noteSent;
  await session.abort();
  await busy;
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(session.isIdle, true);
  assert.equal(updates.seen.length, 1);
  assert.match(JSON.stringify(session.messages), /NOTE_1/u);
  assert.equal(mainRequests(), 1, "the user's stop is not overridden by a new model request");
});

for (const aborted of [false, true]) {
  test(`an update arriving after the last boundary ${aborted ? "is recorded when the run was aborted" : "starts a run once the root settles"}`, {
    timeout: 30_000,
  }, async (t) => {
    const { dir, noteSent, mainRequests, holdChild, releaseChild } = await communicationFixture(t);
    // Loaded after subagents, so the package's own handler for this boundary has run.
    const slowBoundary = join(dir, "slow-boundary.mjs");
    const reached = join(dir, "boundary.flag");
    await writeFile(
      slowBoundary,
      `import { writeFileSync } from "node:fs";
export default function (pi) {
  let done = false;
  pi.on("agent_before_settle", async () => {
    if (done) return;
    done = true;
    writeFileSync(${JSON.stringify(reached)}, "");
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
}
`,
    );
    const { session, tool } = await parentSession(
      t,
      dir,
      false,
      [slowBoundary],
      ["subagent_list", "subagent_send", "subagent_wait"],
    );
    const updates = deliveredUpdates(session);

    holdChild();
    await tool.execute("start", { task: "NOTIFY_MAIN_THEN_STAY" });
    const run = session.prompt("Plain question.");
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await readFile(reached);
        break;
      } catch {
        assert.ok(Date.now() < deadline, "Timed out waiting for the settlement boundary");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const stopped = aborted ? session.abort() : undefined;
    releaseChild();
    await noteSent;
    assert.equal(session.isStreaming, true);
    assert.equal(updates.seen.length, 0);

    await run;
    await stopped;
    const note = await updates.next("subagent:message");
    assert.equal(note.via, "message_end");
    await session.waitForIdle();
    assert.equal(updates.seen.length, 1);
    assert.match(JSON.stringify(session.messages), /NOTE_1/u);
    // A normal settlement is followed by a run for the update; a user's stop is not.
    assert.equal(mainRequests(), aborted ? 1 : 2);
  });
}

test("updates arriving while the root settles share one requested run", {
  timeout: 30_000,
}, async (t) => {
  const { dir, mainRequests, notes, holdChild, releaseChild } = await communicationFixture(t);
  const slowSettled = join(dir, "slow-settled.mjs");
  const settling = join(dir, "settling.flag");
  await writeFile(
    slowSettled,
    `import { writeFileSync } from "node:fs";
export default function (pi) {
  let done = false;
  pi.on("agent_settled", async () => {
    if (done) return;
    done = true;
    writeFileSync(${JSON.stringify(settling)}, "");
    await new Promise((resolve) => setTimeout(resolve, 800));
  });
}
`,
  );
  const { session, tool } = await parentSession(
    t,
    dir,
    false,
    [slowSettled],
    ["subagent_list", "subagent_send", "subagent_wait"],
  );
  const updates = deliveredUpdates(session);

  holdChild();
  await tool.execute("first", { task: "NOTIFY_MAIN_THEN_STAY" });
  await tool.execute("second", { task: "NOTIFY_MAIN_THEN_STAY" });
  const run = session.prompt("Plain question.");
  const deadline = Date.now() + 10_000;
  const until = async (ready: () => boolean | Promise<boolean>, what: string) => {
    while (!(await ready())) {
      assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await until(
    () =>
      readFile(settling).then(
        () => true,
        () => false,
      ),
    "settled handlers",
  );
  // Pi reports idle here, yet a run requested now starts only after these handlers.
  assert.equal(session.isIdle, true);
  releaseChild();
  await until(() => notes() === 2, "both peer messages");
  assert.equal(updates.seen.length, 0, "both updates arrived before the requested run began");

  await run;
  await updates.next("subagent:message", 1);
  await session.waitForIdle();
  // Both start the single requested run, so its first model request sees both.
  assert.deepEqual(
    updates.seen.map((update) => update.via),
    ["message_end", "message_end"],
  );
  assert.equal(mainRequests(), 2, "one model request handles both updates");
});

test("a root model waiting on subagent_wait receives the update at its turn boundary", {
  timeout: 30_000,
}, async (t) => {
  const { dir, mainRequests, lastMain } = await communicationFixture(t);
  const { session } = await parentSession(
    t,
    dir,
    false,
    [],
    ["subagent_list", "subagent_send", "subagent_wait"],
  );
  const updates = deliveredUpdates(session);

  // The mock root delegates, then calls subagent_wait until it has seen the note.
  await session.prompt("MAIN_WAITS");
  await session.waitForIdle();

  assert.deepEqual(
    updates.seen.map((update) => [update.customType, update.via]),
    [["subagent:message", "entry_appended"]],
  );
  assert.match(lastMain(), /Incoming update queued/u, "the wait returned for the pending note");
  assert.match(JSON.stringify(session.messages.at(-1)), /Root saw NOTE_1\./u);
  assert.equal(mainRequests(), 3, "delegate, wait, and one request that sees the note");
});

test("an update handed over on a failed model request survives the automatic retry", {
  timeout: 30_000,
}, async (t) => {
  const { dir, mainRequests, lastMain, noteSent, releaseMain, failNextMain } =
    await communicationFixture(t);
  const { session, tool } = await parentSession(
    t,
    dir,
    false,
    [],
    ["subagent_list", "subagent_send", "subagent_wait"],
  );
  const updates = deliveredUpdates(session);
  let retries = 0;
  session.subscribe((event) => {
    if (event.type === "auto_retry_start") retries++;
  });

  failNextMain();
  const busy = session.prompt("HOLD_MAIN");
  await tool.execute("start", { task: "NOTIFY_MAIN_THEN_STAY" });
  await noteSent;
  releaseMain();
  await busy;
  await session.waitForIdle();

  assert.equal(retries, 1);
  assert.equal(updates.seen.length, 1, "the update is recorded once, not per attempt");
  assert.equal(mainRequests(), 2);
  assert.match(lastMain(), /NOTE_1/u, "the retried request includes the update");
  assert.equal(session.messages.at(-1)?.role, "assistant");
});

test("an update arriving while an idle root compacts joins the next run's first request", {
  timeout: 30_000,
}, async (t) => {
  const { dir, mainRequests, lastMain, holdChild, releaseChild, noteSent, holdNextMain } =
    await communicationFixture(t);
  const { session, tool } = await parentSession(
    t,
    dir,
    false,
    [],
    ["subagent_list", "subagent_send", "subagent_wait"],
  );
  const updates = deliveredUpdates(session);
  // Enough history for Pi to accept a manual compaction.
  for (let turn = 0; turn < 3; turn++) {
    await session.prompt(`Plain question ${turn}. ${"lorem ipsum ".repeat(6000)}`);
  }
  await session.waitForIdle();
  holdChild();
  await tool.execute("start", { task: "NOTIFY_MAIN_THEN_STAY" });

  const releaseSummary = holdNextMain();
  const compaction = session.compact();
  const deadline = Date.now() + 10_000;
  while (!session.isCompacting) {
    assert.ok(Date.now() < deadline, "Timed out waiting for compaction to start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(session.isStreaming, false);
  releaseChild();
  await noteSent;
  releaseSummary();
  await compaction;
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Pi reports the end of this compaction to no extension event, so nothing wakes the root.
  assert.equal(session.isIdle, true);
  assert.equal(updates.seen.length, 0);

  const before = mainRequests();
  await session.prompt("Next question.");
  await session.waitForIdle();
  assert.deepEqual(
    updates.seen.map((update) => update.via),
    ["message_end"],
  );
  assert.equal(
    mainRequests() - before,
    1,
    "the update starts with the prompt, without an extra request",
  );
  assert.match(lastMain(), /Next question\.[\s\S]*NOTE_1/u);
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

test("roles configure child model, instructions, tool selection, limits, and parent prompt advertisement", {
  timeout: 45_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagents-roles-"));
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

  await writeFile(join(dir, "sample.txt"), "ALPHA_NEEDLE_42\n");

  const parentRequests: Record<string, unknown>[] = [];
  const childRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let holdExplorer: Promise<void> | undefined;
  let releaseExplorer: (() => void) | undefined;

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const parsed: unknown = JSON.parse(raw);
    assert.ok(record(parsed));
    const messages = Array.isArray(parsed.messages) ? parsed.messages.filter(record) : [];
    const serialized = JSON.stringify(messages);
    const isChild = serialized.includes("Delegated task:");
    const toolCount = messages.filter((m) => m.role === "tool").length;

    if (!isChild) {
      parentRequests.push(parsed);
    } else {
      childRequests.push({ url: req.url ?? "", body: parsed });
    }

    if (isChild && serialized.includes("INSPECT_REPO") && holdExplorer) {
      await holdExplorer;
    }

    let toolCall: { name: string; arguments: string } | undefined;
    let reply = "Parent acknowledged.";
    if (isChild) {
      if (serialized.includes("INSPECT_REPO")) {
        if (toolCount === 0) {
          toolCall = {
            name: "grep",
            arguments: JSON.stringify({ pattern: "ALPHA_NEEDLE_42", path: "sample.txt" }),
          };
        } else {
          reply = `Explorer found needle (${String(parsed.model)}).`;
        }
      } else if (serialized.includes("SOLVE_PURE")) {
        reply = "Pure reasoning solution.";
      } else if (serialized.includes("LOOP_RESEARCH")) {
        toolCall = {
          name: "read",
          arguments: JSON.stringify({ path: "sample.txt", offset: 1, limit: 5 }),
        };
      }
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = {
      id: "mock",
      object: "chat.completion.chunk",
      created: 1,
      model: String(parsed.model ?? "test-model"),
      choices: [
        {
          index: 0,
          delta: toolCall
            ? {
                role: "assistant",
                tool_calls: [
                  { index: 0, id: `call-${toolCount}`, type: "function", function: toolCall },
                ],
              }
            : { role: "assistant", content: reply },
          finish_reason: null,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    releaseExplorer?.();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  await writeFile(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${address.port}/mock/v1`,
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
        fast: {
          baseUrl: `http://127.0.0.1:${address.port}/fast/v1`,
          api: "openai-completions",
          apiKey: "test-only",
          models: [
            {
              id: "reader-model",
              name: "Fast Reader",
              reasoning: true,
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

  const docToolPath = join(dir, "docs-tool.ts");
  await writeFile(
    docToolPath,
    `export default function(pi) {
      pi.registerTool({
        name: 'docs_lookup',
        label: 'Docs',
        description: 'Reference lookup fixture',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'docs' }], details: {} }),
      });
    }`,
  );

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url)), docToolPath],
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
  // Omit explicit `tools` so Pi uses normal default active tools while keeping grep/find/ls registered inactive.
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(dir),
  });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await session.abort();
    session.dispose();
  });
  const notices: string[] = [];
  await session.bindExtensions({
    mode: "rpc",
    uiContext: {
      ...session.extensionRunner.createContext().ui,
      notify: (message) => {
        notices.push(message);
      },
    },
  });

  // Built-in `explorer` and `researcher` are advertised out of the box with no subagents.json.
  await session.prompt("Check default built-in roles.");
  const defaultParentPrompt = JSON.stringify(parentRequests[0]?.messages);
  assert.match(defaultParentPrompt, /<subagent_roles>/u);
  assert.match(
    defaultParentPrompt,
    /- explorer \(tools: read, grep, find, ls\): Read-only local codebase search and navigation\./u,
  );
  assert.match(
    defaultParentPrompt,
    /- researcher \(tools: \+grep, \+find, \+ls, -edit, -write, -bash, -powershell\): Read-only documentation/u,
  );

  // Partial overrides customize built-in explorer/researcher without losing their built-in tools/instructions.
  await writeFile(
    join(dir, "subagents.json"),
    JSON.stringify({
      roles: {
        explorer: {
          provider: "fast",
          model: "reader-model",
          thinking: "low",
        },
        researcher: {
          maxRequests: 1,
        },
        solver: {
          tools: [],
          instructions: "ROLE_SOLVER_MARKER",
        },
      },
    }),
  );

  await session.prompt("Check overridden roles.");
  const overriddenParentPrompt = JSON.stringify(parentRequests[1]?.messages);
  assert.match(
    overriddenParentPrompt,
    /- explorer \(fast\/reader-model; thinking: low; tools: read, grep, find, ls\): Read-only local codebase search and navigation\./u,
  );
  assert.match(overriddenParentPrompt, /- solver \(tools: none\)/u);

  const tool = session.agent.state.tools.find((entry) => entry.name === "subagent");
  const listTool = session.agent.state.tools.find((entry) => entry.name === "subagent_list");
  assert.ok(tool && listTool);

  const updates = deliveredUpdates(session);

  // 1. Built-in explorer with model override retains built-in read-only tools and instructions, excluding docs_lookup.
  holdExplorer = new Promise<void>((resolve) => {
    releaseExplorer = resolve;
  });
  const startedExplorer = await tool.execute("call-explorer", {
    task: "INSPECT_REPO",
    role: "explorer",
  });
  assert.match(JSON.stringify(startedExplorer.content), /role: explorer/u);
  assert.ok(record(startedExplorer.details));
  assert.equal(startedExplorer.details.role, "explorer");
  const explorerId = String(startedExplorer.details.id);

  const liveListing = await listTool.execute("list-explorer", {});
  assert.match(JSON.stringify(liveListing.content), new RegExp(`${explorerId} · explorer · `, "u"));
  await session.prompt("/subagents");
  assert.match(notices.at(-1) ?? "", new RegExp(`${explorerId}  explorer  running`, "u"));

  releaseExplorer?.();
  holdExplorer = undefined;
  const explorerUpdate = await updates.next("subagent:result", 0);
  await session.waitForIdle();
  assert.match(
    String(explorerUpdate.content),
    new RegExp(`Subagent ${explorerId} \\(explorer\\): completed`, "u"),
  );
  assert.match(String(explorerUpdate.content), /Explorer found needle \(reader-model\)\./u);
  assert.ok(record(explorerUpdate.details));
  assert.equal(explorerUpdate.details.role, "explorer");

  const explorerReq = childRequests.find((entry) =>
    JSON.stringify(entry.body.messages).includes("INSPECT_REPO"),
  );
  assert.ok(explorerReq);
  assert.equal(explorerReq.url, "/fast/v1/chat/completions");
  assert.equal(explorerReq.body.model, "reader-model");
  const explorerTools = Array.isArray(explorerReq.body.tools)
    ? explorerReq.body.tools
        .filter(record)
        .map((entry) => (record(entry.function) ? entry.function.name : undefined))
    : [];
  assert.deepEqual(explorerTools, ["read", "grep", "find", "ls"]);
  const explorerPrompt = JSON.stringify(explorerReq.body.messages);
  assert.match(explorerPrompt, /Your assigned role is explorer\./u);
  assert.match(explorerPrompt, /Explore the local codebase without modifying files\./u);
  assert.doesNotMatch(explorerPrompt, /subagent_send/u);
  assert.doesNotMatch(explorerPrompt, /<subagent_roles>/u);

  // 2. Zero-tool custom role (`tools: []`).
  const beforeSolver = updates.seen.length;
  await tool.execute("call-solver", { task: "SOLVE_PURE", role: "solver" });
  const solverUpdate = await updates.next("subagent:result", beforeSolver);
  await session.waitForIdle();
  assert.ok(record(solverUpdate.details));
  assert.equal(solverUpdate.details.role, "solver");
  assert.equal(solverUpdate.details.status, "completed");
  const solverReq = childRequests.find((entry) =>
    JSON.stringify(entry.body.messages).includes("SOLVE_PURE"),
  );
  assert.ok(solverReq);
  const solverTools = Array.isArray(solverReq.body.tools) ? solverReq.body.tools : [];
  assert.deepEqual(solverTools, []);
  const solverPrompt = JSON.stringify(solverReq.body.messages);
  assert.match(solverPrompt, /ROLE_SOLVER_MARKER/u);
  assert.doesNotMatch(solverPrompt, /subagent_send/u);

  // 3. Built-in researcher keeps research/extension and communication tools, enables grep/find/ls, and removes edit/write/bash.
  const originalArgv = process.argv;
  process.argv = [process.execPath, "pi", "-e", docToolPath];
  t.after(() => {
    process.argv = originalArgv;
  });
  const beforeResearcher = updates.seen.length;
  await tool.execute("call-researcher", { task: "LOOP_RESEARCH", role: "researcher" });
  process.argv = originalArgv;
  const researcherUpdate = await updates.next("subagent:result", beforeResearcher);
  await session.waitForIdle();
  assert.ok(record(researcherUpdate.details));
  assert.equal(researcherUpdate.details.role, "researcher");
  assert.equal(researcherUpdate.details.status, "limit_reached");
  assert.equal(researcherUpdate.details.requests, 1);
  const researcherReq = childRequests.find((entry) =>
    JSON.stringify(entry.body.messages).includes("LOOP_RESEARCH"),
  );
  assert.ok(researcherReq && Array.isArray(researcherReq.body.tools));
  const researcherTools = researcherReq.body.tools
    .filter(record)
    .map((entry) => (record(entry.function) ? entry.function.name : undefined));
  for (const expected of ["read", "grep", "find", "ls", "docs_lookup", "subagent_send"]) {
    assert.ok(researcherTools.includes(expected), `researcher missing ${expected}`);
  }
  for (const forbidden of ["edit", "write", "bash", "powershell", "subagent"]) {
    assert.ok(!researcherTools.includes(forbidden), `researcher leaked ${forbidden}`);
  }

  // 4. Disabling built-in roles with `false` omits <subagent_roles> without a reload.
  await writeFile(
    join(dir, "subagents.json"),
    JSON.stringify({ roles: { explorer: false, researcher: false } }),
  );
  const beforeCount = parentRequests.length;
  await session.prompt("Check roles after disabling.");
  const disabledParentPrompt = JSON.stringify(parentRequests[beforeCount]?.messages);
  assert.doesNotMatch(disabledParentPrompt, /<subagent_roles>/u);
});

test("roles fail closed on unknown names, unavailable models, and parent tool restrictions", {
  timeout: 30_000,
}, async (t) => {
  const { dir } = await fixture(t);
  const oldXaiKey = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY;
  t.after(() => {
    if (oldXaiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = oldXaiKey;
  });
  await writeFile(
    join(dir, "subagents.json"),
    JSON.stringify({
      roles: {
        needs_grep: {
          tools: ["read", "grep"],
        },
        adds_grep: {
          tools: ["+grep"],
        },
        bad_model: {
          provider: "mock",
          model: "nonexistent-model",
          tools: ["read"],
        },
        unauthed_model: {
          provider: "xai",
          model: "grok-4.7",
          tools: ["read"],
        },
      },
    }),
  );

  // `parentSession` restricts parent allowed tools to ["read", "write", "bash", "subagent", "subagent_cancel"].
  const { tool } = await parentSession(t, dir);

  await assert.rejects(
    tool.execute("empty-role", { task: "Inspect.", role: "   " }),
    /Role name must be nonempty/u,
  );
  await assert.rejects(
    tool.execute("unknown-role", { task: "Inspect.", role: "unknown" }),
    /Unknown subagent role "unknown"\. Configured roles: explorer, researcher, needs_grep, adds_grep, bad_model, unauthed_model\./u,
  );
  await assert.rejects(
    tool.execute("restricted-plain", { task: "Inspect.", role: "needs_grep" }),
    /Role "needs_grep" requires unavailable tool "grep"\./u,
  );
  await assert.rejects(
    tool.execute("restricted-plus", { task: "Inspect.", role: "adds_grep" }),
    /Role "adds_grep" requires unavailable tool "grep"\./u,
  );
  await assert.rejects(
    tool.execute("unavailable-model", { task: "Inspect.", role: "bad_model" }),
    /Role "bad_model" model mock\/nonexistent-model is not available\./u,
  );
  await assert.rejects(
    tool.execute("unauthed-provider", { task: "Inspect.", role: "unauthed_model" }),
    /Child exited before startup[\s\S]*xai/iu,
  );
});
