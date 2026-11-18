import assert from "node:assert/strict";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const lspPackagePath = fileURLToPath(new URL("../", import.meta.url));
const subagentsPackagePath = fileURLToPath(new URL("../../subagents/", import.meta.url));
const mockServerScript = fileURLToPath(new URL("./mock-lsp-server.mjs", import.meta.url));

interface ScriptedTurn {
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  reply?: string;
}

async function startScriptedOpenAIServer(t: TestContext, script: ScriptedTurn[]) {
  let turnIndex = 0;
  const requests: Array<{
    messages?: Array<{ role?: string; content?: unknown }>;
  }> = [];

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));

    const step = script[turnIndex++] ?? { reply: "Done" };
    res.writeHead(200, { "content-type": "text/event-stream" });

    if (step.toolCalls && step.toolCalls.length > 0) {
      const toolCalls = step.toolCalls.map((call, idx) => ({
        index: idx,
        id: `call_${turnIndex}_${idx}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
      res.write(
        `data: ${JSON.stringify({
          id: `cmpl_${turnIndex}`,
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: null },
          ],
        })}\n\n` +
          `data: ${JSON.stringify({
            id: `cmpl_${turnIndex}`,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n` +
          "data: [DONE]\n\n",
      );
      res.end();
      return;
    }

    res.write(
      `data: ${JSON.stringify({
        id: `cmpl_${turnIndex}`,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: step.reply ?? "OK" },
            finish_reason: null,
          },
        ],
      })}\n\n` +
        `data: ${JSON.stringify({
          id: `cmpl_${turnIndex}`,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        })}\n\n` +
        "data: [DONE]\n\n",
    );
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");

  return {
    requests,
    modelsJson: {
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${addr.port}/v1`,
          apiKey: "mock-key",
          api: "openai-completions",
          models: [
            {
              id: "mock-model",
              name: "Mock",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  };
}

async function createLspSession(
  t: TestContext,
  options: {
    cwd?: string;
    agentDir?: string;
    mode?: "tui" | "rpc" | "print" | "json";
    trusted?: boolean;
    lspConfig?: unknown;
    extraExtensionPaths?: string[];
    modelsJson?: unknown;
  } = {},
) {
  const cwd = options.cwd ?? (await mkdtemp(join(tmpdir(), "pi-lsp-cwd-")));
  const agentDir = options.agentDir ?? (await mkdtemp(join(tmpdir(), "pi-lsp-agent-")));
  if (!options.cwd) t.after(() => rm(cwd, { recursive: true, force: true }));
  if (!options.agentDir) t.after(() => rm(agentDir, { recursive: true, force: true }));

  if (options.lspConfig !== undefined) {
    await writeFile(join(agentDir, "lsp.json"), JSON.stringify(options.lspConfig));
  }
  if (options.modelsJson !== undefined) {
    await writeFile(join(agentDir, "models.json"), JSON.stringify(options.modelsJson));
  }

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  });

  const settingsManager = SettingsManager.inMemory();
  settingsManager.setProjectTrusted(options.trusted ?? true);

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [lspPackagePath, ...(options.extraExtensionPaths ?? [])],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "catalog.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
  });
  t.after(async () => {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });

  const statusEvents: Array<{ key: string; text: string | undefined }> = [];
  const notices: Array<{ message: string; level: string | undefined }> = [];
  const baseUi = session.extensionRunner.createContext().ui;
  const uiOverrides: Partial<ExtensionUIContext> = {
    setStatus(key, text) {
      statusEvents.push({ key, text });
    },
    notify(message, level) {
      notices.push({ message, level });
    },
  };

  await session.bindExtensions({
    mode: options.mode ?? "tui",
    uiContext: {
      ...baseUi,
      ...uiOverrides,
    },
  });

  if (options.modelsJson !== undefined) {
    const mockModel = session.extensionRunner
      .createContext()
      .modelRegistry.find("mock", "mock-model");
    assert.ok(mockModel);
    await session.setModel(mockModel);
  }

  return { session, cwd, agentDir, statusEvents, notices };
}

test("lsp exposes concise prompt metadata, appends post-edit diagnostics only on issues, and lists servers in /lsp", async (t: TestContext) => {
  const { modelsJson } = await startScriptedOpenAIServer(t, [
    // Turn 1: write clean file -> 0 extra diagnostics
    {
      toolCalls: [
        {
          name: "write",
          args: {
            path: "app.ts",
            content: "export function add(a: number, b: number) {\n  return a + b;\n}\n",
          },
        },
      ],
    },
    // Turn 2: edit introducing type error -> diagnostics appended + statusline updated
    {
      toolCalls: [
        {
          name: "edit",
          args: {
            path: "app.ts",
            edits: [{ oldText: "return a + b;", newText: "return TYPE_ERROR;" }],
          },
        },
      ],
    },
    // Turn 3: direct lsp hover query with @app.ts -> structuredContent validated
    {
      toolCalls: [
        {
          name: "lsp",
          args: { action: "hover", path: "@app.ts", line: 1, symbol: "add" },
        },
      ],
    },
    { reply: "Inspected error." },
    // Prompt 2 Turn 1: fix the type error -> statusline cleared
    {
      toolCalls: [
        {
          name: "edit",
          args: {
            path: "app.ts",
            edits: [{ oldText: "return TYPE_ERROR;", newText: "return a + b;" }],
          },
        },
      ],
    },
    { reply: "Fixed." },
  ]);

  const { session, cwd, statusEvents, notices } = await createLspSession(t, {
    mode: "tui",
    modelsJson,
    lspConfig: {
      servers: {
        typescript: {
          command: process.execPath,
          args: [mockServerScript],
          extensions: [".ts"],
          rootMarkers: ["tsconfig.json"],
          languageId: "typescript",
        },
      },
    },
  });

  await writeFile(join(cwd, "tsconfig.json"), "{}");

  // 1. Prompt surface & tool metadata
  assert.match(
    session.systemPrompt,
    /- lsp: Query a language server for a file's diagnostics or a symbol's definition, references, or type/u,
  );
  assert.match(
    session.systemPrompt,
    /Successful edit and write calls append the file's errors and warnings/u,
  );
  const info = session.getAllTools().find((candidate) => candidate.name === "lsp");
  assert.ok(info);
  assert.deepEqual(info.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(statusEvents, []);

  // /lsp before any server starts is read-only and starts no model turn
  await session.prompt("/lsp");
  assert.equal(session.messages.length, 0);
  assert.match(notices.at(-1)?.message ?? "", /No language servers running/u);

  // Run multi-turn agent loop: clean write -> broken edit -> hover
  await session.prompt("Create and edit app.ts");

  const toolResults = session.messages.filter((m) => m.role === "toolResult");
  assert.equal(toolResults.length, 3);

  const writeResText = JSON.stringify(toolResults[0]?.content);
  assert.match(writeResText, /Successfully wrote to app\.ts/u);
  assert.doesNotMatch(writeResText, /LSP diagnostics/u);

  const brokenEditText = JSON.stringify(toolResults[1]?.content);
  assert.match(brokenEditText, /LSP diagnostics \(1 error\):/u);
  assert.match(brokenEditText, /app\.ts:2:10 \[error TS2322\] Type 'string'/u);

  const hoverMsg = toolResults[2];
  assert.ok(hoverMsg && hoverMsg.role === "toolResult");
  assert.equal(hoverMsg.isError, false);
  assert.match(JSON.stringify(hoverMsg.content), /app\.ts:1 \(typescript\)/u);
  assert.match(JSON.stringify(hoverMsg.content), /col_16/u);

  // /lsp lists the running server
  await session.prompt("/lsp");
  assert.match(notices.at(-1)?.message ?? "", /LSP · 1 running/u);
  assert.match(notices.at(-1)?.message ?? "", /- typescript \(.+\) · 1 open file/u);

  // Fixing the error in a second prompt adds nothing to the edit result
  await session.prompt("Fix app.ts");
  const fixedEditMsg = session.messages.filter((m) => m.role === "toolResult").at(-1);
  assert.doesNotMatch(JSON.stringify(fixedEditMsg?.content), /LSP diagnostics/u);
  // The extension never touches the status area
  assert.deepEqual(statusEvents, []);
});

test("untrusted projects disable language servers entirely even when PATH binaries exist, and missing servers degrade cleanly", async (t: TestContext) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lsp-untrusted-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const markerFile = join(cwd, "pwned.txt");
  const pathBinDir = join(cwd, "global-bin");
  await mkdir(pathBinDir, { recursive: true });
  const globalScript = join(pathBinDir, "typescript-language-server");
  await writeFile(globalScript, `#!/bin/sh\necho pwned > "${markerFile}"\nexit 1\n`);
  await chmod(globalScript, 0o755);
  await writeFile(join(cwd, "tsconfig.json"), "{}");
  await writeFile(join(cwd, "index.ts"), "export const x = TYPE_ERROR;\n");

  const prevPath = process.env.PATH;
  process.env.PATH = pathBinDir;
  t.after(() => {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  });

  const { modelsJson } = await startScriptedOpenAIServer(t, [
    {
      toolCalls: [
        {
          name: "edit",
          args: { path: "index.ts", edits: [{ oldText: "TYPE_ERROR", newText: "1" }] },
        },
        { name: "lsp", args: { action: "diagnostics", path: "index.ts" } },
      ],
    },
    { reply: "Checked." },
  ]);

  const { session } = await createLspSession(t, {
    cwd,
    mode: "print",
    trusted: false,
    modelsJson,
  });

  await session.prompt("Edit and check index.ts");
  const toolResults = session.messages.filter((m) => m.role === "toolResult");
  assert.equal(toolResults.length, 2);

  assert.doesNotMatch(JSON.stringify(toolResults[0]?.content), /LSP diagnostics/u);
  assert.match(
    JSON.stringify(toolResults[1]?.content),
    /Language servers are disabled in untrusted projects/u,
  );
  await assert.rejects(access(markerFile));

  // Trusted project with empty PATH degrades cleanly to "not installed"
  process.env.PATH = "";
  const { session: trustedMissingSession } = await createLspSession(t, {
    cwd,
    mode: "print",
    trusted: true,
  });
  const lspTool = trustedMissingSession.agent.state.tools.find((tool) => tool.name === "lsp");
  assert.ok(lspTool);
  const directUnavailable = await lspTool.execute("direct-unavail", {
    action: "diagnostics",
    path: "index.ts",
  });
  assert.match(
    JSON.stringify(directUnavailable.content),
    /not installed \(tried: tsc, typescript-language-server\)/u,
  );
});

test("delegated subagents in json mode inherit lsp and run post-edit diagnostics cleanly", async (t: TestContext) => {
  const { requests, modelsJson } = await startScriptedOpenAIServer(t, [
    {
      toolCalls: [
        { name: "write", args: { path: "sub.ts", content: "export const bad = TYPE_ERROR;\n" } },
      ],
    },
    { reply: "Detected error." },
  ]);

  const { session, cwd } = await createLspSession(t, {
    mode: "tui",
    extraExtensionPaths: [subagentsPackagePath],
    lspConfig: {
      servers: {
        typescript: {
          command: process.execPath,
          args: [mockServerScript],
          extensions: [".ts"],
          rootMarkers: ["tsconfig.json"],
          languageId: "typescript",
        },
      },
    },
    modelsJson,
  });
  await writeFile(join(cwd, "tsconfig.json"), "{}");

  const done = new Promise<string>((resolve) => {
    const unsub = session.subscribe((ev) => {
      if (
        ev.type === "message_end" &&
        ev.message.role === "custom" &&
        ev.message.customType === "subagent:result"
      ) {
        unsub();
        resolve(JSON.stringify(ev.message));
      }
    });
  });

  const subagentTool = session.agent.state.tools.find((tool) => tool.name === "subagent");
  assert.ok(subagentTool);
  await subagentTool.execute("del-lsp", { task: "Write sub.ts and check diagnostics." });
  const outcome = await done;
  assert.match(outcome, /"status":"completed"/u);

  const secondReqStr = JSON.stringify(requests[1]?.messages);
  assert.match(secondReqStr, /LSP diagnostics \(1 error\)/u);
});

test("an invalid lsp.json is reported once at session start, keeps edits silent, and names the field", async (t: TestContext) => {
  const { modelsJson } = await startScriptedOpenAIServer(t, [
    { toolCalls: [{ name: "write", args: { path: "a.ts", content: "export const a = 1;\n" } }] },
    { toolCalls: [{ name: "write", args: { path: "b.ts", content: "export const b = 1;\n" } }] },
    { toolCalls: [{ name: "lsp", args: { action: "diagnostics", path: "a.ts" } }] },
    { reply: "Done." },
  ]);
  const { session, notices } = await createLspSession(t, {
    mode: "tui",
    modelsJson,
    lspConfig: { requestTimeoutSeconds: 0 },
  });
  const configErrors = () => notices.filter((notice) => notice.level === "error");
  assert.equal(configErrors().length, 1);
  assert.match(configErrors()[0]?.message ?? "", /\/requestTimeoutSeconds: must be >= 1/u);

  await session.prompt("Write two files and check one");
  const results = session.messages.filter((m) => m.role === "toolResult");
  assert.equal(results.length, 3);
  assert.equal(results[0]?.isError, false);
  assert.equal(results[1]?.isError, false);
  // The explicit tool call surfaces the configuration error to the model
  assert.equal(results[2]?.isError, true);
  assert.match(JSON.stringify(results[2]?.content), /requestTimeoutSeconds: must be >= 1/u);
  assert.equal(configErrors().length, 1, "edits must not re-report the configuration error");

  await session.prompt("/lsp");
  assert.equal(configErrors().length, 2);
});

test("post-edit checks resolve paths like the built-in tools, including file:// URLs", async (t: TestContext) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lsp-fileurl-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const target = join(cwd, "my file.ts");
  const { requests, modelsJson } = await startScriptedOpenAIServer(t, [
    {
      toolCalls: [
        {
          name: "write",
          args: { path: pathToFileURL(target).href, content: "export const a = TYPE_ERROR;\n" },
        },
      ],
    },
    { reply: "Seen." },
  ]);
  const { session } = await createLspSession(t, {
    cwd,
    modelsJson,
    lspConfig: {
      servers: {
        typescript: {
          command: process.execPath,
          args: [mockServerScript],
          extensions: [".ts"],
          rootMarkers: ["tsconfig.json"],
          languageId: "typescript",
        },
      },
    },
  });
  await writeFile(join(cwd, "tsconfig.json"), "{}");

  await session.prompt("Write the file");
  // Pi wrote the file the URL names, and the diagnostics refer to that same file
  assert.equal(await readFile(target, "utf8"), "export const a = TYPE_ERROR;\n");
  assert.match(JSON.stringify(requests[1]?.messages), /LSP diagnostics \(1 error\)/u);
  assert.match(JSON.stringify(requests[1]?.messages), /my file\.ts:1:18/u);
});
