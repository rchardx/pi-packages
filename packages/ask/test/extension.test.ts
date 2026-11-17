import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  type ExtensionUIContext,
  initTheme,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";

const askPackagePath = fileURLToPath(new URL("../", import.meta.url));
const subagentsPackagePath = fileURLToPath(new URL("../../subagents/", import.meta.url));

async function startMockOpenAIServer(t: TestContext) {
  const requests: Array<{ tools?: Array<{ function?: { name?: string } }>; messages?: unknown[] }> =
    [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
      })}\n\n` +
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        })}\n\n` +
        "data: [DONE]\n\n",
    );
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    requests,
    modelsJson: {
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "mock-key",
          api: "openai-completions",
          models: [
            {
              id: "mock-model",
              name: "Mock Model",
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

async function createAskSession(
  t: TestContext,
  options: {
    directory?: string;
    sessionManager?: SessionManager;
    mode?: "tui" | "rpc" | "print" | "json";
    extraExtensionPaths?: string[];
    modelsJson?: unknown;
    uiOverrides?: Partial<ExtensionUIContext>;
  } = {},
) {
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "pi-ask-extension-")));
  if (!options.directory) {
    t.after(() => rm(directory, { recursive: true, force: true }));
  }

  if (options.modelsJson !== undefined) {
    await writeFile(join(directory, "models.json"), JSON.stringify(options.modelsJson));
  }

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    additionalExtensionPaths: [askPackagePath, ...(options.extraExtensionPaths ?? [])],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);

  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "catalog.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader: loader,
    modelRuntime,
    settingsManager,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(directory),
  });
  t.after(async () => {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });

  const baseUi = session.extensionRunner.createContext().ui;
  await session.bindExtensions({
    mode: options.mode ?? "tui",
    uiContext: {
      ...baseUi,
      ...options.uiOverrides,
    },
  });

  if (options.modelsJson !== undefined) {
    const mockModel = session.extensionRunner
      .createContext()
      .modelRegistry.find("mock", "mock-model");
    assert.ok(mockModel);
    await session.setModel(mockModel);
  }

  return { session, loader, directory };
}

function declaredToolNames(request: { tools?: Array<{ function?: { name?: string } }> }): string[] {
  return (request.tools ?? []).flatMap((tool) => (tool.function?.name ? [tool.function.name] : []));
}

test("ask activates in tui and rpc modes with sequential execution and custom/dialog dispatch", async (t) => {
  initTheme("dark");
  const agentDir = await mkdtemp(join(tmpdir(), "pi-ask-tui-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-ask-tui-cwd-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [askPackagePath], enableInstallTelemetry: false }),
  );

  const runtime = await createAgentSessionRuntime(
    async ({ cwd: targetCwd, agentDir: targetAgentDir, sessionManager }) => {
      const settingsManager = SettingsManager.create(targetCwd, targetAgentDir);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(targetAgentDir, "auth.json"),
        modelsPath: join(targetAgentDir, "models.json"),
        modelsStorePath: join(targetAgentDir, "catalog.json"),
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      const services = await createAgentSessionServices({
        cwd: targetCwd,
        agentDir: targetAgentDir,
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      const created = await createAgentSessionFromServices({ services, sessionManager });
      return { ...created, services, diagnostics: services.diagnostics };
    },
    { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
  );
  t.after(() => runtime.dispose());

  let sendInput: ((data: string) => void) | undefined;
  const programStatuses: Array<ProgramStatus | undefined> = [];
  const terminal: Terminal = {
    columns: 100,
    rows: 30,
    kittyProtocolActive: false,
    start(onInput) {
      sendInput = onInput;
    },
    stop() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus(status) {
      programStatuses.push(status);
    },
    async drainInput() {},
  };
  const interactive = new InteractiveMode(runtime, { terminal, tuiMode: "regular" });
  await interactive.init();
  t.after(() => interactive.stop());

  const tuiSession = runtime.session;
  assert.ok(tuiSession.getActiveToolNames().includes("ask"));
  assert.match(
    tuiSession.systemPrompt,
    /- ask: Ask the user structured multiple-choice clarification questions/u,
  );
  assert.match(tuiSession.systemPrompt, /Use ask only when requirements/u);
  assert.match(tuiSession.systemPrompt, /Batch related clarifications into one ask call/u);

  const toolInfo = tuiSession.getAllTools().find((candidate) => candidate.name === "ask");
  assert.ok(toolInfo);
  assert.equal(toolInfo.exposure, "model-only");
  assert.deepEqual(toolInfo.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });

  const registered = tuiSession.resourceLoader.getExtensions().extensions[0]?.tools.get("ask");
  assert.ok(registered);
  assert.equal(registered.definition.executionMode, "sequential");

  const tuiTool = tuiSession.agent.state.tools.find((candidate) => candidate.name === "ask");
  assert.ok(tuiTool);
  const pendingAsk = tuiTool.execute("call-tui", {
    questions: [
      {
        id: "auth",
        header: "Auth",
        question: "Which auth?",
        options: [{ label: "Device code" }, { label: "Localhost" }],
      },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    programStatuses.some(
      (status) => status?.kind === "question" && status.message === "Which auth?",
    ),
  );
  assert.ok(sendInput);
  sendInput("\r");
  const tuiOutcome = await pendingAsk;
  assert.deepEqual(tuiOutcome.content, [{ type: "text", text: "Answer (auth): Device code" }]);

  // A pre-aborted signal fails before opening a custom UI dialog
  const preAborted = new AbortController();
  preAborted.abort(new Error("pre-cancelled"));
  await assert.rejects(
    tuiTool.execute(
      "call-preaborted",
      {
        questions: [
          {
            id: "auth",
            question: "Which auth?",
            options: [{ label: "Device code" }, { label: "Localhost" }],
          },
        ],
      },
      preAborted.signal,
    ),
    /pre-cancelled/u,
  );

  const { session: rpcSession } = await createAskSession(t, {
    mode: "rpc",
    uiOverrides: {
      async select() {
        return "Localhost";
      },
    },
  });
  assert.ok(rpcSession.getActiveToolNames().includes("ask"));
  const rpcTool = rpcSession.agent.state.tools.find((candidate) => candidate.name === "ask");
  assert.ok(rpcTool);
  const rpcOutcome = await rpcTool.execute("call-rpc", {
    questions: [
      {
        id: "auth",
        question: "Which auth?",
        options: [{ label: "Device code" }, { label: "Localhost" }],
      },
    ],
  });
  assert.deepEqual(rpcOutcome.content, [{ type: "text", text: "Answer (auth): Localhost" }]);
});

test("print and json modes hide ask from requests without stripping ask when the session resumes in tui", async (t) => {
  const { requests, modelsJson } = await startMockOpenAIServer(t);
  const directory = await mkdtemp(join(tmpdir(), "pi-ask-resume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // 1. Initial interactive tui prompt declares ask — even when a before_agent_start hook projects event.systemPrompt
  const hookPath = join(directory, "prompt-observer.ts");
  await writeFile(
    hookPath,
    `export default function (pi) {
      pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\nOBSERVER_MARKER" }));
    }`,
  );
  const initialManager = SessionManager.create(directory, directory);
  const sessionFile = initialManager.getSessionFile();
  assert.ok(sessionFile);
  const step1 = await createAskSession(t, {
    directory,
    sessionManager: initialManager,
    mode: "tui",
    extraExtensionPaths: [hookPath],
    modelsJson,
  });
  await step1.session.prompt("Hello from tui");
  assert.ok(declaredToolNames(requests[0] ?? {}).includes("ask"));
  assert.match(
    JSON.stringify(requests[0]?.messages),
    /- ask: Ask the user structured multiple-choice clarification questions/u,
  );
  assert.match(JSON.stringify(requests[0]?.messages), /Batch related clarifications/u);
  assert.match(JSON.stringify(requests[0]?.messages), /OBSERVER_MARKER/u);

  // 2. Resuming the same session file in print mode hides ask from requests and fails closed on direct execution
  const step2 = await createAskSession(t, {
    directory,
    sessionManager: SessionManager.open(sessionFile, directory),
    mode: "print",
    modelsJson,
  });
  assert.doesNotMatch(step2.session.systemPrompt, /- ask:/u);
  assert.doesNotMatch(step2.session.systemPrompt, /Batch related clarifications/u);
  await step2.session.prompt("Continue in print mode");
  assert.ok(!declaredToolNames(requests[1] ?? {}).includes("ask"));
  assert.doesNotMatch(JSON.stringify(requests[1]?.messages), /- ask:/u);
  assert.doesNotMatch(JSON.stringify(requests[1]?.messages), /Batch related clarifications/u);

  const printTool = step2.session.agent.state.tools.find((candidate) => candidate.name === "ask");
  assert.ok(printTool);
  await assert.rejects(
    printTool.execute("direct-print", {
      questions: [
        {
          id: "auth",
          question: "Which auth?",
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
    }),
    /requires tui or rpc mode \(current mode: print\)/u,
  );

  // 3. Resuming the same session file back in tui restores ask in both system prompt and declared tools
  const step3 = await createAskSession(t, {
    directory,
    sessionManager: SessionManager.open(sessionFile, directory),
    mode: "tui",
    modelsJson,
  });
  assert.ok(step3.session.getActiveToolNames().includes("ask"));
  assert.match(
    step3.session.systemPrompt,
    /- ask: Ask the user structured multiple-choice clarification questions/u,
  );
  assert.match(step3.session.systemPrompt, /Batch related clarifications/u);
  await step3.session.prompt("Back in tui");
  assert.ok(declaredToolNames(requests[2] ?? {}).includes("ask"));
});

test("delegated subagents in json mode inherit parent toolsets cleanly while hiding ask from child requests", async (t) => {
  const { requests, modelsJson } = await startMockOpenAIServer(t);
  const { session: parentSession } = await createAskSession(t, {
    mode: "tui",
    extraExtensionPaths: [subagentsPackagePath],
    modelsJson,
  });

  assert.ok(parentSession.getActiveToolNames().includes("ask"));
  assert.ok(parentSession.getActiveToolNames().includes("subagent"));

  const completion = new Promise<string>((resolve) => {
    const unsubscribe = parentSession.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "subagent:result"
      ) {
        unsubscribe();
        resolve(JSON.stringify(event.message));
      }
    });
  });

  const subagentTool = parentSession.agent.state.tools.find(
    (candidate) => candidate.name === "subagent",
  );
  assert.ok(subagentTool);
  await subagentTool.execute("delegate-with-ask", { task: "Check child environment." });
  const completedMessage = await completion;
  assert.match(completedMessage, /"status":"completed"/u);

  assert.equal(requests.length, 1);
  assert.ok(!declaredToolNames(requests[0] ?? {}).includes("ask"));
  assert.doesNotMatch(JSON.stringify(requests[0]?.messages), /- ask:/u);
  assert.doesNotMatch(JSON.stringify(requests[0]?.messages), /Batch related clarifications/u);
});
