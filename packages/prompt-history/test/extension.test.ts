import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionFactory,
  initTheme,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";
import { appendHistoryEntry, historyCwdDir, MAX_ENTRY_BYTES, readHistory } from "../src/store.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_LEFT = "\x1b[D";
const KEY_ENTER = "\r";
const KEY_ALT_ENTER = "\x1b\r";

function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface MockProvider {
  baseUrl: string;
  requests: Record<string, unknown>[];
  holdNextResponse: () => { started: Promise<void>; release: () => void };
}

async function startMockProvider(t: TestContext): Promise<MockProvider> {
  const requests: Record<string, unknown>[] = [];
  let pendingHold:
    | {
        notifyStarted: () => void;
        waitRelease: Promise<void>;
      }
    | undefined;

  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed: unknown = JSON.parse(body);
    assert.ok(isRecord(parsed));
    requests.push(parsed);

    res.writeHead(200, { "content-type": "text/event-stream" });
    const firstChunk = {
      id: "mock-resp",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock-model",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "ack" },
          finish_reason: null,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(firstChunk)}\n\n`);

    if (pendingHold) {
      const hold = pendingHold;
      pendingHold = undefined;
      hold.notifyStarted();
      await hold.waitRelease;
    }

    const doneChunk = {
      ...firstChunk,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    };
    res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(
    () =>
      new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  );

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    holdNextResponse() {
      let notifyStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((r) => {
        notifyStarted = r;
      });
      const waitRelease = new Promise<void>((r) => {
        release = r;
      });
      pendingHold = { notifyStarted, waitRelease };
      return { started, release };
    },
  };
}

async function writeAgentSetup(
  agentDir: string,
  baseUrl: string,
  options?: { includeResources?: boolean; extensions?: string[] },
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      ...(options?.extensions ? { extensions: options.extensions } : {}),
      packages: [packageRoot],
      enableInstallTelemetry: false,
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl,
          api: "openai-completions",
          apiKey: "test-key",
          models: [
            {
              id: "mock-model",
              name: "Mock Model",
              reasoning: false,
              input: ["text"],
              contextWindow: 32000,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );

  if (options?.includeResources) {
    const promptsDir = join(agentDir, "prompts");
    const skillDir = join(agentDir, "skills", "demo-skill");
    await mkdir(promptsDir, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(promptsDir, "review.md"),
      "---\ndescription: Review target files\n---\nEXPANDED_TEMPLATE_BODY: $@\n",
    );
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo skill for prompt history tests.\n---\nEXPANDED_SKILL_INSTRUCTIONS\n",
    );
  }
}

interface HarnessOptions {
  cwd: string;
  agentDir: string;
  sessionManager?: SessionManager | undefined;
  initialMessage?: string | undefined;
  enableResources?: boolean | undefined;
  onTerminalStart?: ((sendInput: (data: string) => void) => void) | undefined;
}

interface InteractiveHarness {
  runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  mode: InteractiveMode;
  sendInput: (data: string) => void;
  submit: (text: string) => void;
  submitFollowUp: (text: string) => void;
  onNextRuntimeCreate: (hook: () => void) => void;
  getCtx: () => ExtensionContext;
  getPi: () => ExtensionAPI;
  waitForSettled: () => Promise<void>;
  waitForSessionStart: () => Promise<void>;
  flushRenderedOutput: () => Promise<string>;
  stop: () => Promise<void>;
}

async function launchInteractiveSession(
  t: TestContext,
  options: HarnessOptions,
): Promise<InteractiveHarness> {
  initTheme("dark");
  process.env.PI_OFFLINE = "1";
  process.env.PI_CODING_AGENT_DIR = options.agentDir;

  let latestCtx: ExtensionContext | undefined;
  let latestPi: ExtensionAPI | undefined;
  let nextRuntimeCreateHook: (() => void) | undefined;
  let initialRuntimeCreated = false;
  const settledWaiters: Array<() => void> = [];
  const sessionStartWaiters: Array<() => void> = [];

  const observerExtension: ExtensionFactory = (pi) => {
    latestPi = pi;
    pi.on("session_start", (_event, ctx) => {
      latestCtx = ctx;
      for (const wake of sessionStartWaiters.splice(0)) {
        wake();
      }
    });
    pi.on("agent_settled", () => {
      for (const wake of settledWaiters.splice(0)) {
        wake();
      }
    });
    pi.registerCommand("ext-noop", {
      description: "Test extension slash command",
      handler: async () => {},
    });
    pi.registerCommand("test-switch", {
      description: "Switch session in tests",
      handler: async (args, cmdCtx: ExtensionCommandContext) => {
        await cmdCtx.switchSession(args.trim());
      },
    });
  };

  const runtime = await createAgentSessionRuntime(
    async ({ cwd: targetCwd, agentDir: targetAgentDir, sessionManager, sessionStartEvent }) => {
      if (initialRuntimeCreated && nextRuntimeCreateHook) {
        const hook = nextRuntimeCreateHook;
        nextRuntimeCreateHook = undefined;
        hook();
      }
      initialRuntimeCreated = true;
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
          noSkills: !options.enableResources,
          noPromptTemplates: !options.enableResources,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [observerExtension],
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
      });
      const mockModel = modelRuntime.getModel("mock", "mock-model");
      assert.ok(mockModel);
      await created.session.setModel(mockModel);
      return { ...created, services, diagnostics: services.diagnostics };
    },
    {
      cwd: options.cwd,
      agentDir: options.agentDir,
      sessionManager:
        options.sessionManager ??
        SessionManager.create(options.cwd, join(options.agentDir, "sessions")),
    },
  );

  let inputListener: ((data: string) => void) | undefined;
  const chunks: string[] = [];
  const terminal: Terminal = {
    columns: 120,
    rows: 40,
    kittyProtocolActive: false,
    start(onInput) {
      inputListener = onInput;
      options.onTerminalStart?.((data) => onInput(data));
    },
    stop() {},
    write(data) {
      chunks.push(data);
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
    async drainInput() {},
  };

  const mode = new InteractiveMode(runtime, {
    terminal,
    tuiMode: "regular",
    verbose: false,
    ...(options.initialMessage !== undefined ? { initialMessage: options.initialMessage } : {}),
  });

  await mode.init();
  const initialSettled =
    options.initialMessage !== undefined
      ? new Promise<void>((resolveSettled) => {
          settledWaiters.push(resolveSettled);
        })
      : undefined;
  // Start the background interactive input loop without blocking the test.
  void mode.run();
  if (initialSettled) {
    await initialSettled;
  }
  await new Promise((r) => setImmediate(r));

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    mode.stop();
    await runtime.dispose();
  };
  t.after(stop);

  return {
    runtime,
    mode,
    sendInput(data: string) {
      assert.ok(inputListener, "Terminal input listener is not active");
      inputListener(data);
    },
    submit(text: string) {
      assert.ok(inputListener, "Terminal input listener is not active");
      inputListener(text);
      inputListener(KEY_ENTER);
    },
    submitFollowUp(text: string) {
      assert.ok(inputListener, "Terminal input listener is not active");
      inputListener(text);
      inputListener(KEY_ALT_ENTER);
    },
    onNextRuntimeCreate(hook: () => void) {
      nextRuntimeCreateHook = hook;
    },
    getCtx() {
      assert.ok(latestCtx, "Extension context not bound yet");
      return latestCtx;
    },
    getPi() {
      assert.ok(latestPi, "Extension API not bound yet");
      return latestPi;
    },
    waitForSettled() {
      return new Promise<void>((resolveSettled) => {
        settledWaiters.push(resolveSettled);
      });
    },
    async waitForSessionStart() {
      await new Promise<void>((resolveStart) => {
        sessionStartWaiters.push(resolveStart);
      });
      await new Promise((r) => setTimeout(r, 20));
    },
    async flushRenderedOutput() {
      // Allow TUI's 16ms throttled render scheduler to flush pending frames.
      await new Promise((r) => setTimeout(r, 40));
      return stripVTControlCharacters(chunks.join(""))
        .replaceAll("\r\n", "\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n");
    },
    stop,
  };
}

test("recalls prompts newest-first across sessions in the same cwd, isolates other cwds/agentDirs, and preserves multiline + draft navigation", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-history-tui-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const oldOffline = process.env.PI_OFFLINE;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (oldOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = oldOffline;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  });

  const provider = await startMockProvider(t);
  const agentDirA = join(root, "agent-a");
  const agentDirB = join(root, "agent-b");
  const cwdA = join(root, "cwd-a");
  const cwdB = join(root, "cwd-b");
  await mkdir(cwdA, { recursive: true });
  await mkdir(cwdB, { recursive: true });
  await writeAgentSetup(agentDirA, provider.baseUrl);
  await writeAgentSetup(agentDirB, provider.baseUrl);

  // Pre-existing session file on disk must NOT be scanned or imported into fresh sessions.
  process.env.PI_CODING_AGENT_DIR = agentDirA;
  const preExistingSession = SessionManager.create(cwdA);
  preExistingSession.appendMessage({
    role: "user",
    content: [{ type: "text", text: "legacy pre-existing session prompt" }],
    timestamp: Date.now() - 10_000,
  });
  const preExistingSessionFile = preExistingSession.getSessionFile();
  assert.ok(preExistingSessionFile);

  const session1 = await launchInteractiveSession(t, {
    cwd: cwdA,
    agentDir: agentDirA,
    onTerminalStart(sendEarlyInput) {
      // Type during startup before session_start runs: cursor position must survive empty startup.
      sendEarlyInput("abc");
      sendEarlyInput(KEY_LEFT);
      sendEarlyInput("X");
    },
  });
  session1.sendInput("Y");
  assert.equal(session1.getCtx().ui.getEditorText(), "abXYc");
  session1.getCtx().ui.setEditorText("");
  session1.sendInput(KEY_UP);
  assert.equal(session1.getCtx().ui.getEditorText(), "");

  // Submit prompt 1 in cwd A.
  const settled1 = session1.waitForSettled();
  session1.submit("first prompt in A");
  await settled1;

  // Submit multiline prompt 2 with internal indentation and non-ASCII text.
  const multilinePrompt = "Check block:\n  if (ok) {\n    return '你好';\n  }";
  const settled2 = session1.waitForSettled();
  session1.submit(bracketedPaste(multilinePrompt));
  await settled2;

  // Leave an unsent draft in session 1 before closing: must NOT be persisted.
  session1.sendInput("unsent draft from session 1");
  await session1.stop();

  const requestsBeforeRecall = provider.requests.length;

  // Fresh session 2 in cwd A recalls newest-first, navigates multiline, and restores draft.
  const session2 = await launchInteractiveSession(t, { cwd: cwdA, agentDir: agentDirA });
  session2.sendInput("working draft");
  assert.equal(session2.getCtx().ui.getEditorText(), "working draft");

  // First Up moves cursor from end of single-line draft to column 0; second Up enters history.
  session2.sendInput(KEY_UP);
  assert.equal(session2.getCtx().ui.getEditorText(), "working draft");
  session2.sendInput(KEY_UP);
  assert.equal(session2.getCtx().ui.getEditorText(), multilinePrompt);

  // Another Up recalls the older entry immediately because cursor starts on line 0.
  session2.sendInput(KEY_UP);
  assert.equal(session2.getCtx().ui.getEditorText(), "first prompt in A");

  // Down returns to the newer multiline entry (cursor placed on last line) and next Down restores draft.
  session2.sendInput(KEY_DOWN);
  assert.equal(session2.getCtx().ui.getEditorText(), multilinePrompt);
  session2.sendInput(KEY_DOWN);
  assert.equal(session2.getCtx().ui.getEditorText(), "working draft");

  // Restored draft keeps cursor at column 0, so a single Up re-enters history at line 0, col 0.
  session2.sendInput(KEY_UP);
  assert.equal(session2.getCtx().ui.getEditorText(), multilinePrompt);
  // Four lines total: three Downs move cursor through lines 1, 2, 3 without leaving the entry.
  session2.sendInput(KEY_DOWN);
  assert.equal(session2.getCtx().ui.getEditorText(), multilinePrompt);
  session2.sendInput(KEY_DOWN);
  assert.equal(session2.getCtx().ui.getEditorText(), multilinePrompt);
  session2.sendInput(KEY_DOWN);
  assert.equal(session2.getCtx().ui.getEditorText(), multilinePrompt);
  // Fourth Down from the last visual line exits history and restores the draft.
  session2.sendInput(KEY_DOWN);
  assert.equal(session2.getCtx().ui.getEditorText(), "working draft");

  // Recall must never auto-submit a prompt.
  assert.equal(provider.requests.length, requestsBeforeRecall);
  await session2.stop();

  // Early drafts typed during startup or /new transitions keep their text and still seed
  // persisted Up history for the session rather than disabling recall for the whole session.
  const startupDraftSession = await launchInteractiveSession(t, {
    cwd: cwdA,
    agentDir: agentDirA,
    onTerminalStart(sendEarlyInput) {
      sendEarlyInput("early draft");
    },
  });
  assert.equal(startupDraftSession.getCtx().ui.getEditorText(), "early draft");
  startupDraftSession.getCtx().ui.setEditorText("");
  startupDraftSession.sendInput(KEY_UP);
  assert.equal(startupDraftSession.getCtx().ui.getEditorText(), multilinePrompt);
  await startupDraftSession.stop();

  // Cold-start resume (pi -c / --session) replays the resumed session's own messages on top of
  // seeded cwd history in memory without writing legacy session messages back to disk.
  const coldResumed = await launchInteractiveSession(t, {
    cwd: cwdA,
    agentDir: agentDirA,
    sessionManager: SessionManager.open(preExistingSessionFile),
  });
  coldResumed.sendInput(KEY_UP);
  assert.equal(coldResumed.getCtx().ui.getEditorText(), "legacy pre-existing session prompt");
  coldResumed.sendInput(KEY_UP);
  assert.equal(coldResumed.getCtx().ui.getEditorText(), multilinePrompt);
  coldResumed.sendInput(KEY_UP);
  assert.equal(coldResumed.getCtx().ui.getEditorText(), "first prompt in A");
  await coldResumed.stop();

  const storedAfterColdResume = await readHistory(cwdA, {
    rootDir: join(agentDirA, "prompt-history"),
  });
  assert.equal(storedAfterColdResume.status, "ok");
  assert.deepEqual(storedAfterColdResume.entries, ["first prompt in A", multilinePrompt]);

  const newDraftSession = await launchInteractiveSession(t, { cwd: cwdA, agentDir: agentDirA });
  newDraftSession.onNextRuntimeCreate(() => {
    newDraftSession.sendInput("new draft");
  });
  const newStarted = newDraftSession.waitForSessionStart();
  newDraftSession.submit("/new");
  await newStarted;
  assert.equal(newDraftSession.getCtx().ui.getEditorText(), "new draft");
  newDraftSession.getCtx().ui.setEditorText("");
  newDraftSession.sendInput(KEY_UP);
  assert.equal(newDraftSession.getCtx().ui.getEditorText(), multilinePrompt);
  await newDraftSession.stop();

  // Session in cwd B (same agentDir) does not see cwd A's history.
  const sessionCwdB = await launchInteractiveSession(t, { cwd: cwdB, agentDir: agentDirA });
  sessionCwdB.sendInput(KEY_UP);
  assert.equal(sessionCwdB.getCtx().ui.getEditorText(), "");
  await sessionCwdB.stop();

  // Session in cwd A under a different Pi agent directory does not see agentDirA's history.
  const sessionAgentB = await launchInteractiveSession(t, { cwd: cwdA, agentDir: agentDirB });
  sessionAgentB.sendInput(KEY_UP);
  assert.equal(sessionAgentB.getCtx().ui.getEditorText(), "");
  await sessionAgentB.stop();

  // Default-editor cross-cwd switch + /reload regression:
  // starting in empty-history dir FreshA (keeping defaultEditor), submitting a prompt, switching
  // to empty-history dir FreshB, and running /reload in FreshB must NOT leak FreshA's prompt.
  const cwdFreshA = join(root, "cwd-fresh-a");
  const cwdFreshB = join(root, "cwd-fresh-b");
  await mkdir(cwdFreshA, { recursive: true });
  await mkdir(cwdFreshB, { recursive: true });
  const freshBTargetSession = join(root, "fresh-b-session.jsonl");
  await writeFile(
    freshBTargetSession,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "22222222-2222-4222-8222-222222222222",
      timestamp: new Date().toISOString(),
      cwd: cwdFreshB,
    })}\n`,
  );

  const switchHarness = await launchInteractiveSession(t, {
    cwd: cwdFreshA,
    agentDir: agentDirA,
  });
  const freshASettled = switchHarness.waitForSettled();
  switchHarness.submit("prompt from fresh A");
  await freshASettled;

  const switchedToFreshB = switchHarness.waitForSessionStart();
  switchHarness.submit(`/test-switch ${freshBTargetSession}`);
  await switchedToFreshB;
  assert.equal(switchHarness.getCtx().cwd, cwdFreshB);
  switchHarness.sendInput(KEY_UP);
  assert.equal(switchHarness.getCtx().ui.getEditorText(), "");

  const reloadedInFreshB = switchHarness.waitForSessionStart();
  switchHarness.submit("/reload");
  await reloadedInFreshB;
  switchHarness.sendInput(KEY_UP);
  assert.equal(switchHarness.getCtx().ui.getEditorText(), "");
  switchHarness.sendInput(KEY_UP);
  assert.equal(switchHarness.getCtx().ui.getEditorText(), "");
  await switchHarness.stop();
});

test("records pre-expansion skills/templates, steering, follow-ups, and CLI initial prompts while excluding commands, shell, extension-injected, and non-TUI inputs", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-history-filter-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const oldOffline = process.env.PI_OFFLINE;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (oldOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = oldOffline;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  });

  const provider = await startMockProvider(t);
  const agentDir = join(root, "agent");
  const cwd = join(root, "cwd");
  await mkdir(cwd, { recursive: true });
  await writeAgentSetup(agentDir, provider.baseUrl, { includeResources: true });

  const session = await launchInteractiveSession(t, {
    cwd,
    agentDir,
    initialMessage: "cli initial prompt",
    enableResources: true,
  });

  // Built-in slash command, extension slash command, and shell commands must not be recorded.
  session.submit("/hotkeys");
  await new Promise((r) => setTimeout(r, 30));
  session.submit("/ext-noop ignored");
  await new Promise((r) => setTimeout(r, 30));
  session.submit("!printf 'shell-one'");
  await new Promise((r) => setTimeout(r, 80));
  session.submit("!!printf 'shell-two'");
  await new Promise((r) => setTimeout(r, 80));

  // Extension-injected message must not be recorded.
  const injectedSettled = session.waitForSettled();
  session.getPi().sendUserMessage("injected from extension");
  await injectedSettled;

  // Prompt template and skill invocations are recorded BEFORE expansion.
  const templateSettled = session.waitForSettled();
  session.submit("/review src/store.ts");
  await templateSettled;
  assert.match(JSON.stringify(provider.requests.at(-1)), /EXPANDED_TEMPLATE_BODY: src\/store\.ts/u);

  const skillSettled = session.waitForSettled();
  session.submit("/skill:demo-skill check boundaries");
  await skillSettled;
  assert.match(JSON.stringify(provider.requests.at(-1)), /EXPANDED_SKILL_INSTRUCTIONS/u);

  // Steering and follow-up submissions while streaming are both recorded.
  const hold = provider.holdNextResponse();
  const streamingSettled = session.waitForSettled();
  session.submit("trigger streaming run");
  await hold.started;

  session.submit("steer during stream");
  session.submitFollowUp("followup during stream");
  await new Promise((r) => setTimeout(r, 40));
  hold.release();
  await streamingSettled;
  await session.stop();

  const stored = await readHistory(cwd, { rootDir: join(agentDir, "prompt-history") });
  assert.equal(stored.status, "ok");
  assert.deepEqual(stored.entries, [
    "cli initial prompt",
    "/review src/store.ts",
    "/skill:demo-skill check boundaries",
    "trigger streaming run",
    "steer during stream",
    "followup during stream",
  ]);

  // Ephemeral --no-session runs (SessionManager.inMemory) in a cwd that ALREADY has persisted
  // disk history keep Pi's native in-memory history across /reload without reading or writing disk.
  const ephemeral = await launchInteractiveSession(t, {
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
  });
  ephemeral.sendInput(KEY_UP);
  assert.equal(ephemeral.getCtx().ui.getEditorText(), "");

  const ephemeralSettled = ephemeral.waitForSettled();
  ephemeral.submit("ephemeral secret prompt");
  await ephemeralSettled;

  const ephemeralReloaded = ephemeral.waitForSessionStart();
  ephemeral.submit("/reload");
  await ephemeralReloaded;

  ephemeral.sendInput(KEY_UP);
  assert.equal(ephemeral.getCtx().ui.getEditorText(), "ephemeral secret prompt");
  await ephemeral.stop();

  const storedAfterEphemeral = await readHistory(cwd, {
    rootDir: join(agentDir, "prompt-history"),
  });
  assert.equal(storedAfterEphemeral.status, "ok");
  assert.deepEqual(storedAfterEphemeral.entries, stored.entries);

  // Verify RPC, print, and json modes neither record inputs nor install an editor component.
  const headlessCwd = join(root, "headless-cwd");
  await mkdir(headlessCwd, { recursive: true });

  for (const hostMode of ["rpc", "print", "json"] as const) {
    const settingsManager = SettingsManager.create(headlessCwd, agentDir);
    const loader = new DefaultResourceLoader({
      cwd: headlessCwd,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "catalog.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const { session: nonTuiSession } = await createAgentSession({
      cwd: headlessCwd,
      agentDir,
      resourceLoader: loader,
      modelRuntime,
      settingsManager,
      sessionManager: SessionManager.inMemory(headlessCwd),
    });
    const mockModel = modelRuntime.getModel("mock", "mock-model");
    assert.ok(mockModel);
    await nonTuiSession.setModel(mockModel);

    let setEditorCalled = false;
    await nonTuiSession.bindExtensions({
      mode: hostMode,
      uiContext: {
        ...nonTuiSession.extensionRunner.createContext().ui,
        setEditorComponent: () => {
          setEditorCalled = true;
        },
      },
    });

    await nonTuiSession.prompt(
      `${hostMode} prompt`,
      hostMode === "rpc" ? { source: "rpc" } : undefined,
    );
    assert.equal(setEditorCalled, false, `setEditorComponent must not run in ${hostMode} mode`);
    nonTuiSession.dispose();
  }

  await assert.rejects(stat(historyCwdDir(headlessCwd, join(agentDir, "prompt-history"))), {
    code: "ENOENT",
  });
});

test("preserves custom-editor integration without duplicating entries or stacking wrappers across /reload, /new, and session switches", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-history-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const oldOffline = process.env.PI_OFFLINE;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (oldOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = oldOffline;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  });

  const provider = await startMockProvider(t);
  const agentDir = join(root, "agent");
  const cwdA = join(root, "cwd-a");
  const cwdB = join(root, "cwd-b");
  await mkdir(cwdA, { recursive: true });
  await mkdir(cwdB, { recursive: true });

  // Load a custom-editor extension BEFORE prompt-history via settings.extensions.
  const priorEditorPath = join(root, "prior-custom-editor.ts");
  await writeFile(
    priorEditorPath,
    `import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
const stats = ((globalThis as Record<string, unknown>).__priorEditorStats ??= {
  factoryCalls: 0,
  shortcutCalls: 0,
}) as { factoryCalls: number; shortcutCalls: number };

class TaggedCustomEditor extends CustomEditor {
  override handleInput(data: string): void {
    if (data === "\\x18") {
      stats.shortcutCalls++;
      return;
    }
    super.handleInput(data);
  }
}

export default function priorEditor(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, kb) => {
      stats.factoryCalls++;
      return new TaggedCustomEditor(tui, theme, kb, { embedWorkingStatus: true });
    });
  });
}
`,
    "utf8",
  );
  t.after(() => {
    delete (globalThis as Record<string, unknown>).__priorEditorStats;
  });

  await writeAgentSetup(agentDir, provider.baseUrl, { extensions: [priorEditorPath] });

  process.env.PI_CODING_AGENT_DIR = agentDir;
  const manualSessionBPath = join(root, "cwd-b-session.jsonl");
  await writeFile(
    manualSessionBPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "11111111-1111-4111-8111-111111111111",
      timestamp: new Date().toISOString(),
      cwd: cwdB,
    })}\n`,
  );

  const getEditorStats = () =>
    (globalThis as Record<string, unknown>).__priorEditorStats as {
      factoryCalls: number;
      shortcutCalls: number;
    };

  const sessionA = SessionManager.create(cwdA);
  const harness = await launchInteractiveSession(t, {
    cwd: cwdA,
    agentDir,
    sessionManager: sessionA,
  });

  // Empty startup does not rebuild or wrap the prior custom editor unnecessarily.
  assert.equal(getEditorStats().factoryCalls, 1);

  const s1 = harness.waitForSettled();
  harness.submit("alpha");
  await s1;
  const s2 = harness.waitForSettled();
  harness.submit("beta");
  await s2;

  const sessionAFile = harness.runtime.session.sessionFile;
  assert.ok(sessionAFile);

  // Repeated /reload and /new cycles must not stack wrappers or duplicate entries.
  for (let round = 0; round < 3; round++) {
    const before = getEditorStats().factoryCalls;
    const reloaded = harness.waitForSessionStart();
    harness.submit("/reload");
    await reloaded;
    assert.equal(
      getEditorStats().factoryCalls - before,
      2,
      `Expected exactly one base + one seeded instantiation on /reload round ${round}`,
    );
  }

  const freshStarted = harness.waitForSessionStart();
  harness.submit("/new");
  await freshStarted;

  // Prior custom editor behavior remains intact.
  harness.sendInput("\x18");
  assert.equal(getEditorStats().shortcutCalls, 1);

  // Recalled entries are exact and non-duplicated: beta, then alpha, then no further older entries.
  harness.sendInput(KEY_UP);
  assert.equal(harness.getCtx().ui.getEditorText(), "beta");
  harness.sendInput(KEY_UP);
  assert.equal(harness.getCtx().ui.getEditorText(), "alpha");
  harness.sendInput(KEY_UP);
  assert.equal(harness.getCtx().ui.getEditorText(), "alpha");
  harness.sendInput(KEY_DOWN);
  harness.sendInput(KEY_DOWN);
  assert.equal(harness.getCtx().ui.getEditorText(), "");

  // Switch to a session in cwdB (no persisted history): editor history must be clean, not leaking cwdA.
  const switchedToB = harness.waitForSessionStart();
  harness.submit(`/test-switch ${manualSessionBPath}`);
  await switchedToB;
  assert.equal(harness.getCtx().cwd, cwdB);
  harness.sendInput(KEY_UP);
  assert.equal(harness.getCtx().ui.getEditorText(), "");

  // Switch back to cwdA session: cwdA history is available again without duplication.
  const switchedToA = harness.waitForSessionStart();
  harness.submit(`/test-switch ${sessionAFile}`);
  await switchedToA;
  assert.equal(harness.getCtx().cwd, cwdA);
  harness.sendInput(KEY_UP);
  assert.equal(harness.getCtx().ui.getEditorText(), "beta");
  harness.sendInput(KEY_UP);
  assert.equal(harness.getCtx().ui.getEditorText(), "alpha");
});

test("surfaces oversized-entry and corrupt-storage warnings visibly without blocking prompt submission", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-history-degrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const oldOffline = process.env.PI_OFFLINE;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (oldOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = oldOffline;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  });

  const provider = await startMockProvider(t);
  const agentDir = join(root, "agent");
  const cwdOversized = join(root, "cwd-oversized");
  const cwdCorrupt = join(root, "cwd-corrupt");
  await mkdir(cwdOversized, { recursive: true });
  await mkdir(cwdCorrupt, { recursive: true });
  await writeAgentSetup(agentDir, provider.baseUrl);

  // 1. Oversized prompt warns, still submits to model, and does not truncate history.
  const oversizedHarness = await launchInteractiveSession(t, {
    cwd: cwdOversized,
    agentDir,
  });
  const keepSettled = oversizedHarness.waitForSettled();
  oversizedHarness.submit("keep me intact");
  await keepSettled;

  const hugePrompt = "Z".repeat(MAX_ENTRY_BYTES + 128);
  const hugeSettled = oversizedHarness.waitForSettled();
  await oversizedHarness.runtime.session.prompt(hugePrompt);
  await hugeSettled;

  const oversizedRendered = await oversizedHarness.flushRenderedOutput();
  assert.match(oversizedRendered, /exceeds 256\.0KB history limit.*skipped saving/u);
  await oversizedHarness.stop();

  const afterHuge = await readHistory(cwdOversized, { rootDir: join(agentDir, "prompt-history") });
  assert.equal(afterHuge.status, "ok");
  assert.deepEqual(afterHuge.entries, ["keep me intact"]);

  // 2. Corrupt history storage warns once per session, leaves corrupt entry untouched, never blocks
  // prompts, and syncs concurrent disk entries across /reload before a later storage failure.
  const corruptHistoryRoot = join(agentDir, "prompt-history");
  const corruptDir = historyCwdDir(cwdCorrupt, corruptHistoryRoot);
  const corruptHarness = await launchInteractiveSession(t, {
    cwd: cwdCorrupt,
    agentDir,
  });

  // Simulate another Pi process saving an entry, then reload while storage is healthy so
  // fallback.entries refreshes from diskEntries.
  assert.equal(
    (
      await appendHistoryEntry(cwdCorrupt, "concurrent before corruption", {
        rootDir: corruptHistoryRoot,
      })
    ).status,
    "saved",
  );
  const syncedReload = corruptHarness.waitForSessionStart();
  corruptHarness.submit("/reload");
  await syncedReload;

  const corruptFile = join(corruptDir, "999999999999999-0123456789ab.json");
  const brokenPayload = "{corrupt-user-history";
  await writeFile(corruptFile, brokenPayload, "utf8");

  const reqCountBefore = provider.requests.length;
  const c1 = corruptHarness.waitForSettled();
  corruptHarness.submit("first under corrupt store");
  await c1;
  const c2 = corruptHarness.waitForSettled();
  corruptHarness.submit("second under corrupt store");
  await c2;

  assert.equal(provider.requests.length, reqCountBefore + 2);
  assert.equal(await readFile(corruptFile, "utf8"), brokenPayload);

  const corruptNotices = (await corruptHarness.flushRenderedOutput())
    .split("\n")
    .filter((line) => line.includes("Prompt history storage is corrupt"));
  assert.equal(corruptNotices.length, 1, "Corrupt storage warning should be deduplicated");

  const reloadAfterCorrupt = corruptHarness.waitForSessionStart();
  corruptHarness.submit("/reload");
  await reloadAfterCorrupt;
  corruptHarness.sendInput(KEY_UP);
  assert.equal(corruptHarness.getCtx().ui.getEditorText(), "second under corrupt store");
  corruptHarness.sendInput(KEY_UP);
  assert.equal(corruptHarness.getCtx().ui.getEditorText(), "first under corrupt store");
  corruptHarness.sendInput(KEY_UP);
  assert.equal(corruptHarness.getCtx().ui.getEditorText(), "concurrent before corruption");
  await corruptHarness.stop();

  // 3. Unwritable storage warns without blocking submission, then recovers once storage is restored.
  const agentBlocked = join(root, "agent-blocked");
  const cwdBlocked = join(root, "cwd-blocked");
  await mkdir(cwdBlocked, { recursive: true });
  await writeAgentSetup(agentBlocked, provider.baseUrl);
  const blockedHistoryPath = join(agentBlocked, "prompt-history");

  const blockedHarness = await launchInteractiveSession(t, {
    cwd: cwdBlocked,
    agentDir: agentBlocked,
  });
  // Block storage after startup so save-time I/O degradation is exercised directly.
  await writeFile(blockedHistoryPath, "blocking-file", "utf8");
  const reqBeforeBlocked = provider.requests.length;
  const b1 = blockedHarness.waitForSettled();
  blockedHarness.submit("while unwritable 1");
  await b1;
  const b2 = blockedHarness.waitForSettled();
  blockedHarness.submit("while unwritable 2");
  await b2;
  assert.equal(provider.requests.length, reqBeforeBlocked + 2);

  const saveErrorNotices = (await blockedHarness.flushRenderedOutput())
    .split("\n")
    .filter((line) => line.includes("Prompt history could not be saved"));
  assert.equal(saveErrorNotices.length, 1, "I/O save warning should be deduplicated");

  // Running /reload while storage is unavailable must NOT wipe out the in-session memory history.
  const reloadedWhileBlocked = blockedHarness.waitForSessionStart();
  blockedHarness.submit("/reload");
  await reloadedWhileBlocked;
  blockedHarness.sendInput(KEY_UP);
  assert.equal(blockedHarness.getCtx().ui.getEditorText(), "while unwritable 2");
  blockedHarness.sendInput(KEY_UP);
  assert.equal(blockedHarness.getCtx().ui.getEditorText(), "while unwritable 1");
  blockedHarness.getCtx().ui.setEditorText("");

  // Unblock storage and verify subsequent submissions persist and collapse consecutive duplicates.
  await rm(blockedHistoryPath, { force: true });
  const b3 = blockedHarness.waitForSettled();
  blockedHarness.submit("recovered entry");
  await b3;
  const b4 = blockedHarness.waitForSettled();
  blockedHarness.submit("recovered entry");
  await b4;
  await blockedHarness.stop();

  const recoveredStore = await readHistory(cwdBlocked, { rootDir: blockedHistoryPath });
  assert.equal(recoveredStore.status, "ok");
  assert.deepEqual(recoveredStore.entries, ["recovered entry"]);
});
