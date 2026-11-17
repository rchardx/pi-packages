import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  initTheme,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const packagesRoot = join(repoRoot, "packages");

interface PackageManifest {
  name: string;
  version: string;
  files?: string[];
  pi?: {
    extensions?: string[];
  };
}

async function listWorkspacePackages() {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    dirs.map(async (dir) => {
      const root = join(packagesRoot, dir);
      const raw = await readFile(join(root, "package.json"), "utf8");
      const manifest = JSON.parse(raw) as PackageManifest;
      return { dir, root, manifest };
    }),
  );
}

function createCaptureTerminal(): { terminal: Terminal; output: () => string } {
  const chunks: string[] = [];
  const terminal: Terminal = {
    start() {},
    stop() {},
    async drainInput() {},
    write(data) {
      chunks.push(data);
    },
    get columns() {
      return 120;
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
    output: () =>
      stripVTControlCharacters(chunks.join(""))
        .replaceAll("\r\n", "\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n"),
  };
}

async function renderStartupBanner(
  t: TestContext,
  agentDir: string,
  packageSources: string[],
  verbose = false,
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-packages-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const previousOffline = process.env.PI_OFFLINE;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_OFFLINE = "1";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: packageSources, enableInstallTelemetry: false }),
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
    {
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
    },
  );
  t.after(() => runtime.dispose());

  assert.deepEqual(runtime.session.resourceLoader.getExtensions().errors, []);
  assert.deepEqual(runtime.session.resourceLoader.getExtensions().warnings ?? [], []);

  initTheme();
  const { terminal, output } = createCaptureTerminal();
  const mode = new InteractiveMode(runtime, {
    terminal,
    tuiMode: "regular",
    verbose,
  });
  await mode.init();
  mode.stop();

  return output();
}

test("workspace packages expose root index.ts entrypoints and include them in tarballs", async () => {
  const packages = await listWorkspacePackages();
  assert.deepEqual(
    packages.map((pkg) => pkg.dir),
    ["ask", "background", "statusline", "subagents", "web-access"],
  );

  for (const pkg of packages) {
    assert.deepEqual(pkg.manifest.pi?.extensions, ["./index.ts"]);
    assert.ok(pkg.manifest.files?.includes("index.ts"));

    const pack = spawnSync(
      "npm",
      ["pack", "--workspace", pkg.manifest.name, "--dry-run", "--json"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    assert.ifError(pack.error);
    assert.equal(pack.status, 0, pack.stderr);
    const parsed = JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>;
    const packedPaths = parsed[0]?.files.map((file) => file.path) ?? [];
    assert.ok(packedPaths.includes("index.ts"), `${pkg.dir} tarball missing index.ts`);
    assert.ok(!packedPaths.includes("src/index.ts"), `${pkg.dir} tarball kept src/index.ts`);
  }
});

test("local package installs display package directory names instead of /src in Pi UI", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-packages-local-agent-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));

  const packages = await listWorkspacePackages();
  const sources = packages.map((pkg) => pkg.root);
  const compactBanner = await renderStartupBanner(t, agentDir, sources, false);
  assert.match(
    compactBanner,
    /\[Extensions\]\n {2}ask, background, statusline, subagents, web-access\n/u,
  );
  assert.doesNotMatch(compactBanner, /\/src\b/u);

  const verboseBanner = await renderStartupBanner(t, agentDir, sources, true);
  for (const pkg of packages) {
    assert.ok(verboseBanner.includes(`/packages/${pkg.dir}\n`));
  }
  assert.doesNotMatch(verboseBanner, /\/src\b/u);
});

test("managed npm package installs display package specs without :src suffixes in Pi UI", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-packages-npm-agent-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));

  const packages = await listWorkspacePackages();
  const specs: string[] = [];
  for (const pkg of packages) {
    const target = join(agentDir, "npm", "node_modules", ...pkg.manifest.name.split("/"));
    await mkdir(target, { recursive: true });
    await cp(join(pkg.root, "package.json"), join(target, "package.json"));
    await cp(join(pkg.root, "index.ts"), join(target, "index.ts"));
    await cp(join(pkg.root, "src"), join(target, "src"), { recursive: true });
    specs.push(`npm:${pkg.manifest.name}@${pkg.manifest.version}`);
  }

  const banner = await renderStartupBanner(t, agentDir, specs);
  assert.match(
    banner,
    /\[Extensions\]\n {2}@rchardx\/pi-ask@0\.1\.0,\s+@rchardx\/pi-background@0\.1\.0,\s+@rchardx\/pi-statusline@0\.1\.0,\s+@rchardx\/pi-subagents@0\.1\.0,\s+@rchardx\/pi-web-access@0\.1\.0\n/u,
  );
  assert.doesNotMatch(banner, /:src\b/u);
});
