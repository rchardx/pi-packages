import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assetName, loadPackages } from "./nightly-pack.ts";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// Run the installed code in a separate, bounded process: neither inherited Pi
// settings nor API-key environment variables may affect the smoke results.
async function verifyInstalled(root: string): Promise<void> {
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  const packages = await loadPackages(repoRoot);
  const sources = packages.map((pkg) => join(root, "node_modules", ...pkg.name.split("/")));
  let networkAttempts = 0;
  globalThis.fetch = async () => {
    networkAttempts++;
    throw new Error("Nightly smoke must not make network requests");
  };

  const {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: sources, enableInstallTelemetry: false }),
  );
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, [], "Installed extensions must load without errors");
  assert.deepEqual(loaded.warnings ?? [], [], "Installed extensions must load without warnings");
  assert.deepEqual(
    loaded.extensions.map((extension) => extension.resolvedPath).sort(),
    sources.map((source) => join(source, "index.ts")).sort(),
    "Pi must discover all installed package entrypoints through settings.packages",
  );

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
  const runtimeErrors: unknown[] = [];
  try {
    await session.bindExtensions({ mode: "print", onError: (error) => runtimeErrors.push(error) });
    for (const [name, owner] of [
      ["ask", "ask"],
      ["bash", "background"],
      ["lsp", "lsp"],
      ["subagent", "subagents"],
      ["subagent_cancel", "subagents"],
      ["web_search", "web-access"],
      ["web_fetch", "web-access"],
    ]) {
      const info = session.getAllTools().find((tool) => tool.name === name);
      assert.ok(info, `Missing installed tool: ${name}`);
      assert.equal(
        info.sourceInfo.path,
        join(root, "node_modules", "@rchardx", `pi-${owner}`, "index.ts"),
      );
    }
    assert.ok(!session.getActiveToolNames().includes("web_search"));
    assert.ok(!session.getActiveToolNames().includes("web_fetch"));
    // Explicit activation is not consent. Both web tools must still fail closed.
    session.setActiveToolsByName([...session.getActiveToolNames(), "web_search", "web_fetch"]);
    const execute = (name: string, args: Record<string, unknown>) => {
      const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `Missing executable tool: ${name}`);
      return tool.execute(`nightly-${name}`, args, AbortSignal.timeout(10_000));
    };
    const bash = await execute("bash", {
      command: "printf 'nightly-installed-bash\\n'",
      timeout: 5,
    });
    assert.deepEqual(bash.content, [{ type: "text", text: "nightly-installed-bash\n" }]);
    await assert.rejects(
      execute("bash", { command: "exit 99", background: true, timeout: 5 }),
      /Background execution is unavailable in print mode/u,
    );
    await assert.rejects(
      execute("ask", {
        questions: [
          { id: "smoke", question: "Choose one", options: [{ label: "A" }, { label: "B" }] },
        ],
      }),
      /requires tui or rpc mode \(current mode: print\)/u,
    );
    await assert.rejects(
      execute("subagent", { task: "This must not launch a child." }),
      /Background subagents require tui or rpc mode/u,
    );
    await assert.rejects(
      execute("subagent_cancel", { id: "00000000-0000-4000-8000-000000000000" }),
      /No subagents belong to this session/u,
    );
    const lsp = await execute("lsp", { action: "diagnostics", path: "notes.txt" });
    assert.deepEqual(lsp.content, [
      { type: "text", text: 'No language server is configured for "notes.txt".' },
    ]);
    await assert.rejects(execute("web_search", { query: "nightly smoke" }), /Search is disabled/u);
    await assert.rejects(
      execute("web_fetch", { url: "https://example.invalid/nightly-smoke" }),
      /Fetch is disabled/u,
    );
  } finally {
    try {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
  assert.deepEqual(runtimeErrors, [], "Installed extension lifecycle handlers must not fail");
  assert.equal(networkAttempts, 0, "No model/provider requests are allowed");
  console.log(
    `Installed smoke passed on ${process.version}: ${sources.length} package extensions discovered/loaded; ` +
      "foreground bash; ask/background/subagent mode guards; lsp unavailable-language path; empty subagent cancellation; " +
      "web search/fetch consent guards. Prompt-history and statusline loading only in print mode; no model or child-agent execution.",
  );
}

function run(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} failed (signal: ${result.signal ?? "none"})`);
}

async function main(args: string[]): Promise<void> {
  const [archivesDir] = args;
  assert.ok(
    args.length === 1 && archivesDir && isAbsolute(archivesDir),
    "Usage: node --import tsx scripts/nightly-smoke.ts <absolute-archives-directory>",
  );
  const archives = (await loadPackages(repoRoot)).map((pkg) =>
    join(archivesDir, assetName(pkg.name)),
  );
  for (const archive of archives) {
    assert.ok((await stat(archive)).isFile(), `Archive is not a regular file: ${archive}`);
  }
  const root = await mkdtemp(join(tmpdir(), "pi-nightly-smoke-"));
  try {
    const location = relative(await realpath(repoRoot), await realpath(root));
    assert.ok(
      location.startsWith(`..${sep}`) || isAbsolute(location),
      "Smoke installation must be outside the checkout; choose an external TMPDIR",
    );
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
    run(
      "npm",
      [
        "install",
        "--prefix",
        root,
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...archives,
      ],
      root,
      120_000,
    );
    for (const directory of ["home", "agent", "work", "tmp"]) {
      await mkdir(join(root, directory));
    }
    run(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), scriptPath, "--installed", root],
      join(root, "work"),
      60_000,
      {
        PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        HOME: join(root, "home"),
        TMPDIR: join(root, "tmp"),
        PI_CODING_AGENT_DIR: join(root, "agent"),
        PI_OFFLINE: "1",
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// The private worker branch receives only the temporary install root from main.
const args = process.argv.slice(2);
try {
  if (args[0] === "--installed" && args.length === 2 && args[1]) {
    await verifyInstalled(args[1]);
  } else {
    await main(args);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
