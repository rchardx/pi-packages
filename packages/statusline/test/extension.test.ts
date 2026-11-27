import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type ExtensionContext,
  initTheme,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";

const statuslineRoot = fileURLToPath(new URL("../", import.meta.url));

function createCaptureTerminal(initialColumns = 140): {
  terminal: Terminal;
  setColumns: (columns: number) => void;
  clear: () => void;
  output: () => string;
} {
  let currentColumns = initialColumns;
  const chunks: string[] = [];
  const terminal: Terminal = {
    start() {},
    stop() {},
    async drainInput() {},
    write(data) {
      chunks.push(data);
    },
    get columns() {
      return currentColumns;
    },
    get rows() {
      return 40;
    },
    get kittyProtocolActive() {
      return false;
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
  };
  return {
    terminal,
    setColumns: (columns: number) => {
      currentColumns = columns;
    },
    clear: () => {
      chunks.length = 0;
    },
    output: () =>
      stripVTControlCharacters(chunks.join(""))
        .replaceAll("\r\n", "\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n"),
  };
}

test("statusline renders subagents before background on the path line in TUI mode", async (t: TestContext) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-statusline-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-statusline-cwd-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const oldOffline = process.env.PI_OFFLINE;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_OFFLINE = "1";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (oldOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = oldOffline;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  });

  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [statuslineRoot], enableInstallTelemetry: false }),
  );

  let capturedCtx: ExtensionContext | undefined;
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
          extensionFactories: [
            (pi) => {
              pi.on("session_start", (_event, ctx) => {
                capturedCtx = ctx;
              });
            },
          ],
        },
      });
      const created = await createAgentSessionFromServices({ services, sessionManager });
      return { ...created, services, diagnostics: services.diagnostics };
    },
    {
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
    },
  );
  t.after(() => runtime.dispose());

  initTheme();
  const { terminal, setColumns, clear, output } = createCaptureTerminal();
  const mode = new InteractiveMode(runtime, {
    terminal,
    tuiMode: "regular",
    verbose: false,
  });
  await mode.init();
  t.after(() => mode.stop());

  assert.ok(capturedCtx);
  // Set background before subagents to verify priority ordering beats registration order.
  clear();
  capturedCtx.ui.setStatus("background", "background: 1 running");
  capturedCtx.ui.setStatus("subagents", "subagents: 2 running");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const rendered = output();
  assert.ok(
    rendered.includes(`${cwd} · subagents: 2 running · background: 1 running`),
    `Expected inline statusline in output:\n${rendered}`,
  );
  assert.ok(
    !rendered.includes("\nsubagents: 2 running"),
    "extension statuses must not render on a separate third footer row",
  );

  // Shrink terminal width in the same session to verify narrow widths propagate to the footer.
  setColumns(60);
  clear();
  capturedCtx.ui.setStatus("subagents", "subagents: 3 running");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const narrowRendered = output();
  assert.ok(
    narrowRendered.includes("... · subagents: 3 running · background: 1 running"),
    `Expected elided cwd and intact statuses in narrow output:\n${narrowRendered}`,
  );
});

test("statusline labels official OAuth subscriptions as (sub) but not Radius OAuth or API keys", async (t: TestContext) => {
  for (const [providerId, authEntry, expectSub] of [
    [
      "radius",
      {
        type: "oauth",
        refresh: "refresh-token",
        access: "access-token",
        expires: Date.now() + 600_000,
      },
      false,
    ],
    [
      "anthropic",
      {
        type: "api_key",
        key: "sk-ant-test",
      },
      false,
    ],
    [
      "anthropic",
      {
        type: "oauth",
        refresh: "refresh-token",
        access: "access-token",
        expires: Date.now() + 600_000,
      },
      true,
    ],
    [
      "openai",
      {
        type: "oauth",
        refresh: "refresh-token",
        access: "access-token",
        expires: Date.now() + 600_000,
      },
      true,
    ],
  ] as const) {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-statusline-oauth-"));
    const cwd = await mkdtemp(join(tmpdir(), "pi-statusline-oauth-cwd-"));
    t.after(() => rm(agentDir, { recursive: true, force: true }));
    t.after(() => rm(cwd, { recursive: true, force: true }));

    const oldOffline = process.env.PI_OFFLINE;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_OFFLINE = "1";
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(() => {
      if (oldOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = oldOffline;
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    });

    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [statuslineRoot],
        enableInstallTelemetry: false,
      }),
    );
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({
        [providerId]: authEntry,
      }),
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
        const selected = modelRuntime.getModels(providerId)[0];
        assert.ok(selected, `Expected built-in model for ${providerId}`);
        await created.session.setModel(selected);
        return { ...created, services, diagnostics: services.diagnostics };
      },
      {
        cwd,
        agentDir,
        sessionManager: SessionManager.inMemory(cwd),
      },
    );
    t.after(() => runtime.dispose());

    initTheme();
    const { terminal, output } = createCaptureTerminal();
    const mode = new InteractiveMode(runtime, {
      terminal,
      tuiMode: "regular",
      verbose: false,
    });
    await mode.init();
    mode.stop();

    const rendered = output();
    assert.equal(
      rendered.includes("$0.000 (sub)"),
      expectSub,
      `Unexpected (sub) state for ${providerId} (${authEntry.type}):\n${rendered}`,
    );
  }
});

for (const hostMode of ["rpc", "print", "json"] as const) {
  test(`statusline is a no-op in ${hostMode} mode`, async (t: TestContext) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-statusline-mode-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      additionalExtensionPaths: [statuslineRoot],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      modelsStorePath: join(dir, "catalog.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      resourceLoader: loader,
      modelRuntime,
      settingsManager,
      sessionManager: SessionManager.inMemory(dir),
      tools: [],
    });
    t.after(() => session.dispose());

    let footerCalls = 0;
    await session.bindExtensions({
      mode: hostMode,
      uiContext: {
        ...session.extensionRunner.createContext().ui,
        setFooter: () => {
          footerCalls++;
        },
      },
    });
    assert.equal(footerCalls, 0);
  });
}
