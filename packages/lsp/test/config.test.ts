import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  BUILTIN_SERVERS,
  configFilePath,
  findWorkspaceRoot,
  loadConfig,
  matchServerForFile,
  parseConfig,
  resolveServerBinary,
} from "../src/config.ts";

test("built-in presets cover TS/JS, Python, Rust, Go, and C/C++ with accurate language IDs", () => {
  const cfg = parseConfig({});
  assert.deepEqual(
    BUILTIN_SERVERS.map((s) => s.id),
    ["typescript", "python", "rust", "go", "clangd"],
  );

  const ts = matchServerForFile(cfg, "/repo/src/view.tsx");
  assert.equal(ts?.id, "typescript");
  assert.equal(ts?.languageIdForPath("/repo/src/view.tsx"), "typescriptreact");
  assert.equal(ts?.languageIdForPath("/repo/src/util.mjs"), "javascript");

  assert.equal(matchServerForFile(cfg, "/repo/app.py")?.id, "python");
  assert.equal(matchServerForFile(cfg, "/repo/src/lib.rs")?.id, "rust");
  assert.equal(matchServerForFile(cfg, "/repo/cmd/main.go")?.id, "go");

  const clangd = matchServerForFile(cfg, "/repo/src/engine.cpp");
  assert.equal(clangd?.id, "clangd");
  assert.equal(clangd?.languageIdForPath("/repo/include/engine.h"), "c");
  assert.equal(clangd?.languageIdForPath("/repo/src/engine.cpp"), "cpp");
});

test("parseConfig and loadConfig use getAgentDir() and fail closed on invalid input", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lsp-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
  });
  assert.equal(configFilePath(), join(dir, "lsp.json"));

  // Missing file returns defaults
  const defaults = await loadConfig();
  assert.equal(defaults.diagnosticsOnEdit, true);
  assert.equal(defaults.requestTimeoutMs, 15_000);

  // Valid custom config disabling rust and adding zig
  const validPath = join(dir, "lsp.json");
  await writeFile(
    validPath,
    JSON.stringify({
      diagnosticsOnEdit: false,
      requestTimeoutSeconds: 10,
      servers: {
        rust: false,
        zig: {
          command: "zls",
          args: ["--enable-debug-log"],
          extensions: [".zig"],
          rootMarkers: ["build.zig"],
          languageId: "zig",
        },
      },
    }),
  );
  const custom = await loadConfig(validPath);
  assert.equal(custom.diagnosticsOnEdit, false);
  assert.equal(custom.requestTimeoutMs, 10_000);
  assert.equal(matchServerForFile(custom, "/repo/lib.rs"), undefined);
  assert.equal(matchServerForFile(custom, "/repo/main.zig")?.id, "zig");

  // Invalid JSON and invalid schema fail closed
  const brokenPath = join(dir, "broken.json");
  await writeFile(brokenPath, "{ invalid");
  await assert.rejects(loadConfig(brokenPath), /Invalid JSON/u);

  for (const bad of [
    null,
    [],
    { unknownKey: true },
    { requestTimeoutSeconds: 0 },
    { maxServers: 2 },
    { servers: { bad: { command: "x", extensions: ["no_dot"], languageId: "x" } } },
    { servers: { blank: { command: "   ", extensions: [".x"], languageId: "x" } } },
    { servers: { blank: { command: "x", extensions: [".x"], languageId: " " } } },
    { servers: { " ": { command: "x", extensions: [".x"], languageId: "x" } } },
  ]) {
    assert.throws(() => parseConfig(bad), /Invalid LSP configuration/u);
  }
  // Errors name the first offending field
  assert.throws(
    () => parseConfig({ requestTimeoutSeconds: 0 }),
    /: \/requestTimeoutSeconds: must be >= 1\.$/u,
  );
  assert.throws(() => parseConfig({ unknownKey: true }), /: \/unknownKey: unknown property\.$/u);
  assert.throws(
    () =>
      parseConfig({ servers: { zig: { command: " ", extensions: [".zig"], languageId: "zig" } } }),
    /: \/servers\/zig\/command: must match pattern/u,
  );
});

test("findWorkspaceRoot shares the outermost marker inside cwd across monorepo packages and never looks above cwd", async (t: TestContext) => {
  const base = await mkdtemp(join(tmpdir(), "pi-lsp-mono-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const repo = join(base, "repo");
  await mkdir(join(repo, "packages", "a", "src"), { recursive: true });
  await mkdir(join(repo, "packages", "b"), { recursive: true });
  await writeFile(join(repo, "tsconfig.json"), "{}");
  await writeFile(join(repo, "package.json"), "{}");
  await writeFile(join(repo, "packages", "a", "package.json"), "{}");
  await writeFile(join(repo, "packages", "b", "package.json"), "{}");
  const markers = ["tsconfig.json", "jsconfig.json", "package.json"];

  // Inside cwd: every package resolves to the outermost marker directory
  assert.equal(
    await findWorkspaceRoot(join(repo, "packages", "a", "src", "x.ts"), markers, repo),
    repo,
  );
  assert.equal(await findWorkspaceRoot(join(repo, "packages", "b", "y.ts"), markers, repo), repo);

  // A session started inside one package stays scoped to that package
  const pkgA = join(repo, "packages", "a");
  assert.equal(await findWorkspaceRoot(join(pkgA, "src", "x.ts"), markers, pkgA), pkgA);

  // No marker inside cwd falls back to cwd
  const bare = join(base, "bare", "deep");
  await mkdir(bare, { recursive: true });
  assert.equal(
    await findWorkspaceRoot(join(bare, "z.ts"), markers, join(base, "bare")),
    join(base, "bare"),
  );
});

test("typescript preset prefers a local TypeScript 7 tsc --lsp and ignores older or PATH tsc", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-ts7-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tsServer = BUILTIN_SERVERS.find((s) => s.id === "typescript");
  assert.ok(tsServer);

  const binDir = join(root, "node_modules", ".bin");
  const tsPkgDir = join(root, "node_modules", "typescript");
  const pathDir = join(root, "path-bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(tsPkgDir, { recursive: true });
  await mkdir(pathDir, { recursive: true });
  for (const script of [
    join(binDir, "tsc"),
    join(pathDir, "tsc"),
    join(pathDir, "typescript-language-server"),
  ]) {
    await writeFile(script, "#!/bin/sh\nexit 0\n");
    await chmod(script, 0o755);
  }

  await writeFile(join(tsPkgDir, "package.json"), JSON.stringify({ version: "7.0.2" }));
  assert.deepEqual(await resolveServerBinary(tsServer, root, pathDir), {
    command: join(binDir, "tsc"),
    args: ["--lsp", "--stdio"],
  });

  await writeFile(join(tsPkgDir, "package.json"), JSON.stringify({ version: "5.9.3" }));
  assert.deepEqual(await resolveServerBinary(tsServer, root, pathDir), {
    command: join(pathDir, "typescript-language-server"),
    args: ["--stdio"],
  });
});

test("findWorkspaceRoot ignores markers above cwd and resolveServerBinary checks ancestor node_modules/.bin before PATH", async (t: TestContext) => {
  const fakeHome = await mkdtemp(join(tmpdir(), "pi-lsp-home-"));
  t.after(() => rm(fakeHome, { recursive: true, force: true }));

  // A marker above the session cwd (e.g. ~/package.json) never becomes the workspace root
  await writeFile(join(fakeHome, "package.json"), "{}");
  const projectDir = join(fakeHome, "work", "scratch");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "index.ts"), "export const x = 1;\n");

  const fallbackRoot = await findWorkspaceRoot(
    join(projectDir, "index.ts"),
    ["tsconfig.json", "package.json"],
    projectDir,
  );
  assert.equal(fallbackRoot, projectDir, "must not promote a directory above cwd to the root");

  // When a marker exists inside the project hierarchy, it resolves to that directory
  const subPkg = join(projectDir, "packages", "web", "src");
  await mkdir(subPkg, { recursive: true });
  await writeFile(join(projectDir, "packages", "web", "tsconfig.json"), "{}");
  await writeFile(join(subPkg, "index.ts"), "export const y = 2;\n");

  const foundRoot = await findWorkspaceRoot(
    join(subPkg, "index.ts"),
    ["tsconfig.json", "package.json"],
    projectDir,
  );
  assert.equal(foundRoot, join(projectDir, "packages", "web"));

  // Binary resolution checks ancestor node_modules/.bin first, then PATH
  const localBinDir = join(projectDir, "node_modules", ".bin");
  const pathBinDir = join(fakeHome, "global-bin");
  await mkdir(localBinDir, { recursive: true });
  await mkdir(pathBinDir, { recursive: true });

  const localScript = join(localBinDir, "typescript-language-server");
  const globalScript = join(pathBinDir, "typescript-language-server");
  await writeFile(localScript, "#!/bin/sh\nexit 0\n");
  await writeFile(globalScript, "#!/bin/sh\nexit 0\n");
  await chmod(localScript, 0o755);
  await chmod(globalScript, 0o755);

  const tsServer = BUILTIN_SERVERS.find((s) => s.id === "typescript");
  assert.ok(tsServer);

  const resolvedLocal = await resolveServerBinary(
    tsServer,
    join(projectDir, "packages", "web"),
    pathBinDir,
  );
  assert.equal(resolvedLocal?.command, localScript);

  await rm(localScript);
  const resolvedGlobal = await resolveServerBinary(
    tsServer,
    join(projectDir, "packages", "web"),
    pathBinDir,
  );
  assert.equal(resolvedGlobal?.command, globalScript);

  const resolvedNone = await resolveServerBinary(tsServer, join(projectDir, "packages", "web"), "");
  assert.equal(resolvedNone, undefined);
});
