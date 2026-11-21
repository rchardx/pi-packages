import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspClient } from "../src/client.ts";
import { BUILTIN_SERVERS } from "../src/config.ts";
import { LspManager } from "../src/manager.ts";

const mockServerScript = fileURLToPath(new URL("./mock-lsp-server.mjs", import.meta.url));
const builtinTypeScript = BUILTIN_SERVERS.find((server) => server.id === "typescript");
assert.ok(builtinTypeScript);
const tsServer = builtinTypeScript;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = Date.now();
  const value = await run();
  return { value, ms: Date.now() - startedAt };
}

function setEnv(t: TestContext, name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A workspace with a root marker, and `lsp.json` pointing `extension` files at the mock server. */
async function workspace(
  t: TestContext,
  servers: Record<string, [mode: string, extension: string, delayMs?: number]>,
  config: Record<string, unknown> = {},
): Promise<string> {
  const agentDir = await tempDir(t, "pi-lsp-agent-");
  setEnv(t, "PI_CODING_AGENT_DIR", agentDir);
  const entries = Object.entries(servers).map(([id, [mode, extension, delayMs]]) => [
    id,
    {
      command: process.execPath,
      args: [mockServerScript, mode, ...(delayMs === undefined ? [] : [String(delayMs)])],
      extensions: [extension],
      rootMarkers: ["tsconfig.json"],
      languageId: "typescript",
    },
  ]);
  await writeFile(
    join(agentDir, "lsp.json"),
    JSON.stringify({ ...config, servers: Object.fromEntries(entries) }),
  );
  const ws = await tempDir(t, "pi-lsp-ws-");
  await writeFile(join(ws, "tsconfig.json"), "{}");
  return ws;
}

function manager(t: TestContext): LspManager {
  const instance = new LspManager();
  t.after(() => instance.shutdownAll());
  return instance;
}

async function startClient(
  t: TestContext,
  mode: string,
  delayMs?: number,
): Promise<{ client: LspClient; dir: string }> {
  const dir = await tempDir(t, "pi-lsp-client-");
  const client = await LspClient.start({
    server: tsServer,
    binary: {
      command: process.execPath,
      args: [mockServerScript, mode, ...(delayMs === undefined ? [] : [String(delayMs)])],
    },
    workspaceRoot: dir,
    requestTimeoutMs: 5_000,
  });
  t.after(() => client.close());
  return { client, dir };
}

/** Server pids recorded by the mock server, in start order. */
function serverPids(t: TestContext, dir: string): () => Promise<number[]> {
  const pidFile = join(dir, "server-pids.txt");
  setEnv(t, "MOCK_LSP_PID_FILE", pidFile);
  return async () => {
    const text = await readFile(pidFile, "utf8").catch(() => "");
    return text.trim() ? text.trim().split("\n").map(Number) : [];
  };
}

const codes = (diagnostics: ReadonlyArray<{ code?: string }> | undefined) =>
  diagnostics?.map((item) => item.code);

test("pull servers answer diagnostics, definition, references, and hover for the file on disk", async (t) => {
  const { client, dir } = await startClient(t, "pull");
  const file = join(dir, "a.ts");
  await writeFile(file, "export function greet() {}\nconst x = TYPE_ERROR; // UNUSED_WARN\n");

  const diagnostics = await client.diagnostics(file, 1_000);
  assert.deepEqual(
    diagnostics?.map((item) => [item.line, item.column, item.severity, item.code]),
    [
      [2, 11, "error", "TS2322"],
      [2, 26, "warning", "TS6133"],
    ],
  );

  // The symbol on the line selects the column; the mock echoes it back
  assert.deepEqual(await client.definition(file, 1, "greet"), [
    { filePath: file, line: 1, column: 17 },
  ]);
  assert.equal((await client.references(file, 1, "greet")).length, 2);
  assert.match(await client.hover(file, 1, "greet"), /greet\(col_16: number\)/u);
  await assert.rejects(client.hover(file, 1, "missing"), /Symbol "missing" not found on line 1/u);
  await assert.rejects(client.hover(file, 9, undefined), /Line 9 is out of range/u);

  // The next query sees what is on disk now
  await writeFile(file, "export function greet() {}\n");
  assert.deepEqual(await client.diagnostics(file, 1_000), []);
});

test("pull diagnostics registered after startup are used, and reports without items are empty", async (t) => {
  const late = await startClient(t, "late-pull");
  const file = join(late.dir, "a.ts");
  await writeFile(file, "const x = TYPE_ERROR;\n");
  // The server registers pull 150ms after startup and never pushes
  const first = await timed(() => late.client.diagnostics(file, 2_000));
  assert.deepEqual(codes(first.value), ["TS2322"]);
  assert.ok(first.ms < 1_000, `took ${first.ms}ms`);

  const empty = await startClient(t, "pull-null");
  const other = join(empty.dir, "a.ts");
  await writeFile(other, "const x = TYPE_ERROR;\n");
  assert.deepEqual(await empty.client.diagnostics(other, 1_000), []);
  await writeFile(other, "const x = 2;\n");
  assert.deepEqual(await empty.client.diagnostics(other, 1_000), []);
});

test("push reports are matched to the document version they describe", async (t) => {
  // Versioned reports: a late report for the previous version does not replace the current one
  const stale = await startClient(t, "push-stale");
  const file = join(stale.dir, "a.ts");
  await writeFile(file, "const x = 1;\n");
  assert.deepEqual(await stale.client.diagnostics(file, 1_000), []);
  await writeFile(file, "const x = TYPE_ERROR;\n");
  assert.deepEqual(codes(await stale.client.diagnostics(file, 1_000)), ["TS2322"]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(codes(await stale.client.diagnostics(file, 1_000)), ["TS2322"]);

  // Unversioned reports: an empty syntax report followed by the semantic one yields the latter
  const waves = await startClient(t, "push-two-wave");
  const second = join(waves.dir, "a.ts");
  await writeFile(second, "const x = TYPE_ERROR;\n");
  assert.deepEqual(codes(await waves.client.diagnostics(second, 1_000)), ["TS2322"]);
});

test("a push server that stays silent yields no result instead of a clean one", async (t) => {
  const silent = await startClient(t, "silent");
  const file = join(silent.dir, "a.ts");
  await writeFile(file, "const x = TYPE_ERROR;\n");
  const none = await timed(() => silent.client.diagnostics(file, 300));
  assert.equal(none.value, undefined);
  assert.ok(none.ms >= 280 && none.ms < 1_000);

  // Like typescript-language-server: a clean file edited into another clean file is not reported
  const dedupe = await startClient(t, "push-dedupe");
  const other = join(dedupe.dir, "a.ts");
  await writeFile(other, "const x = 1;\n");
  assert.deepEqual(await dedupe.client.diagnostics(other, 1_000), []);
  // Unchanged contents are answered from the report the server already sent for them
  assert.deepEqual(await dedupe.client.diagnostics(other, 1_000), []);
  await writeFile(other, "const x = 2;\n");
  assert.equal(await dedupe.client.diagnostics(other, 300), undefined);
  // The earlier report is not presented as current on a later query either
  assert.equal(await dedupe.client.diagnostics(other, 300), undefined);
  await writeFile(other, "const x = TYPE_ERROR;\n");
  assert.deepEqual(codes(await dedupe.client.diagnostics(other, 1_000)), ["TS2322"]);
});

test("closing a server ends pending waits, hung servers, and workers that outlive a clean exit", async (t) => {
  const dir = await tempDir(t, "pi-lsp-close-");
  const workerPidFile = join(dir, "worker.pid");
  setEnv(t, "MOCK_LSP_GRANDCHILD_PID_FILE", workerPidFile);
  const workerPid = async () => {
    await waitUntil(() => {
      try {
        return readFileSync(workerPidFile, "utf8").length > 0;
      } catch {
        return false;
      }
    });
    const pid = Number(readFileSync(workerPidFile, "utf8"));
    await rm(workerPidFile);
    return pid;
  };

  // "silent" answers shutdown and exits cleanly, leaving its worker behind
  const clean = await startClient(t, "silent");
  const cleanWorker = await workerPid();
  const file = join(clean.dir, "a.ts");
  await writeFile(file, "const x = 1;\n");
  const pending = clean.client.diagnostics(file, 5_000);
  const outcome = pending.then(
    () => "resolved",
    (error: Error) => error.message,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await clean.client.close();
  assert.equal(await outcome, 'Language server "typescript" closed.');
  assert.equal(isPidAlive(cleanWorker), false);

  // A server that ignores shutdown and SIGTERM is killed together with its worker
  const hung = await startClient(t, "hang-on-shutdown");
  const hungWorker = await workerPid();
  await hung.client.close();
  assert.equal(hung.client.isAlive, false);
  assert.equal(isPidAlive(hungWorker), false);
});

test("edits append the file's errors and warnings, and nothing for clean files", async (t) => {
  const ws = await workspace(t, { ts: ["pull", ".ts"] });
  const lsp = manager(t);
  await writeFile(join(ws, "a.ts"), "const a = 1; // HINT_ONLY\n");
  assert.equal(await lsp.checkFileAfterEdit("a.ts", ws, true), undefined);

  await writeFile(join(ws, "a.ts"), "const a = TYPE_ERROR;\nconst b = 1; // UNUSED_WARN\n");
  assert.equal(
    await lsp.checkFileAfterEdit("a.ts", ws, true),
    "LSP diagnostics (1 error, 1 warning):\n" +
      "- a.ts:1:11 [error TS2322] Type 'string' is not assignable to type 'number'.\n" +
      "- a.ts:2:17 [warning TS6133] Declared symbol is never read.",
  );

  // Counts cover everything found; the list is bounded
  await writeFile(join(ws, "many.ts"), "const a = TYPE_ERROR;\n".repeat(65));
  const many = await lsp.checkFileAfterEdit("many.ts", ws, true);
  assert.match(many ?? "", /^LSP diagnostics \(65 errors\):\n/u);
  assert.equal(many?.split("\n").length, 22);
  assert.match(many ?? "", /\n- … 45 more not shown$/u);
  const queried = await lsp.execute({ action: "diagnostics", path: "many.ts" }, ws, true);
  assert.match(queried, /^many\.ts: 65 errors \(ts\)\n/u);
  assert.match(queried, /\n- … 15 more not shown$/u);

  assert.deepEqual(lsp.snapshot(), {
    servers: [{ id: "ts", workspaceRoot: ws, openFiles: 2 }],
    unavailable: [],
  });
});

test("an edited file is reported as changed on disk so servers re-read it for other files", async (t) => {
  const ws = await workspace(t, { ts: ["pull-disk-cache", ".ts"] });
  const lsp = manager(t);
  await writeFile(join(ws, "a.ts"), "import { NEEDS_PEER } from './b';\n");
  await writeFile(join(ws, "b.ts"), "export const nothing = 1;\n");
  assert.match((await lsp.checkFileAfterEdit("a.ts", ws, true)) ?? "", /TS2305/u);

  // b.ts was only read from disk by the server; the edit must invalidate that snapshot
  await writeFile(join(ws, "b.ts"), "export const PEER_OK = 1;\n");
  assert.equal(await lsp.checkFileAfterEdit("b.ts", ws, true), undefined);
  assert.equal(
    await lsp.execute({ action: "diagnostics", path: "a.ts" }, ws, true),
    "a.ts: no errors or warnings reported (ts)",
  );
});

test("edits wait a bounded time; late results are dropped and broken servers are not retried", async (t) => {
  const ws = await workspace(
    t,
    {
      slow: ["pull-slow-init", ".ts", 1_500],
      hung: ["hang-on-initialize", ".zz"],
      quiet: ["push-dedupe", ".yy"],
    },
    { requestTimeoutSeconds: 2 },
  );
  const pids = serverPids(t, ws);
  const lsp = manager(t);
  await writeFile(join(ws, "a.ts"), "const a = TYPE_ERROR;\n");
  await writeFile(join(ws, "b.zz"), "TYPE_ERROR\n");
  await writeFile(join(ws, "c.yy"), "x\n");
  const edit = (file: string, signal?: AbortSignal) =>
    timed(() => lsp.checkFileAfterEdit(file, ws, true, signal));

  // A server that needs 1.5s to start: the edit returns at the 0.8s bound without diagnostics
  const cold = await edit("a.ts");
  assert.equal(cold.value, undefined);
  assert.ok(cold.ms >= 750 && cold.ms < 1_200, `waited ${cold.ms}ms`);
  // ...and the server kept starting, so the next edit gets them
  await waitUntil(() => lsp.snapshot().servers.length === 1);
  await writeFile(join(ws, "a.ts"), "const a = TYPE_ERROR; // again\n");
  const warm = await edit("a.ts");
  assert.match(warm.value ?? "", /^LSP diagnostics \(1 error\)/u);
  assert.ok(warm.ms < 500, `waited ${warm.ms}ms`);

  // A server that never finishes starting is bounded the same way, then disabled
  const hung = await edit("b.zz");
  assert.equal(hung.value, undefined);
  assert.ok(hung.ms < 1_200, `waited ${hung.ms}ms`);
  await waitUntil(() => lsp.snapshot().unavailable.length === 1, 4_000);
  assert.match(
    lsp.snapshot().unavailable[0] ?? "",
    /^Language server "hung" failed to start and is disabled until \/lsp reset: /u,
  );
  assert.ok((await edit("b.zz")).ms < 100);
  assert.match(
    await lsp.execute({ action: "diagnostics", path: "b.zz" }, ws, true),
    /^Language server "hung" failed to start/u,
  );
  assert.equal((await pids()).length, 2, "the broken server is not spawned again");

  // A push server that stays silent after a clean-to-clean edit costs the bound and adds nothing
  assert.equal((await edit("c.yy")).value, undefined);
  await writeFile(join(ws, "c.yy"), "y\n");
  const silent = await edit("c.yy");
  assert.equal(silent.value, undefined);
  assert.ok(silent.ms >= 750 && silent.ms < 1_200, `waited ${silent.ms}ms`);

  // An aborted edit returns at once and does not throw
  const aborted = new AbortController();
  setTimeout(() => aborted.abort(), 50);
  await writeFile(join(ws, "c.yy"), "z\n");
  const interrupted = await edit("c.yy", aborted.signal);
  assert.equal(interrupted.value, undefined);
  assert.ok(interrupted.ms < 400, `waited ${interrupted.ms}ms`);
});

test("lsp queries describe one file as text whose first line is the summary", async (t) => {
  const ws = await workspace(t, { ts: ["pull", ".ts"], quiet: ["push-dedupe", ".yy"] });
  const lsp = manager(t);
  const run = (input: Parameters<LspManager["execute"]>[0]) => lsp.execute(input, ws, true);
  await mkdir(join(ws, "src"));
  await writeFile(join(ws, "src", "a.ts"), "export function greet() {}\nconst value = greet();\n");

  assert.equal(
    await run({ action: "diagnostics", path: "src/a.ts" }),
    "src/a.ts: no errors or warnings reported (ts)",
  );
  await writeFile(join(ws, "src", "a.ts"), "export function greet() {}\nconst v = TYPE_ERROR;\n");
  assert.equal(
    await run({ action: "diagnostics", path: "@src/a.ts" }),
    "src/a.ts: 1 error (ts)\n" +
      "- src/a.ts:2:11 [error TS2322] Type 'string' is not assignable to type 'number'.",
  );

  assert.equal(
    await run({ action: "definition", path: "src/a.ts", line: 1, symbol: "greet" }),
    "1 definition (ts)\n- src/a.ts:1:17  export function greet() {}",
  );
  assert.equal(
    await run({ action: "references", path: "src/a.ts", line: 1, symbol: "greet" }),
    "2 references (ts)\n" +
      "- src/a.ts:1:17  export function greet() {}\n" +
      "- src/a.ts:2:14  const v = TYPE_ERROR;",
  );
  assert.equal(
    await run({ action: "hover", path: "src/a.ts", line: 1, symbol: "greet" }),
    "src/a.ts:1 (ts)\n\n```ts\nfunction greet(col_16: number): string\n```\nGreets caller.",
  );
  await assert.rejects(
    run({ action: "hover", path: "src/a.ts" }),
    /"line" is required for hover\./u,
  );

  // A push server that sends nothing for the current contents is reported as exactly that
  await writeFile(join(ws, "c.yy"), "x\n");
  assert.equal(
    await run({ action: "diagnostics", path: "c.yy" }),
    "c.yy: no errors or warnings reported (quiet)",
  );
  await writeFile(join(ws, "c.yy"), "y\n");
  const silent = await timed(() => run({ action: "diagnostics", path: "c.yy" }));
  assert.equal(
    silent.value,
    "c.yy: quiet sent no diagnostics for the current file contents within 2s.",
  );
  assert.ok(silent.ms >= 1_900 && silent.ms < 2_600);
});

test("language servers only run for files inside a trusted session directory", async (t) => {
  const ws = await workspace(t, { ts: ["pull", ".ts"] });
  const pids = serverPids(t, ws);
  const outside = await tempDir(t, "pi-lsp-outside-");
  await writeFile(join(outside, "tsconfig.json"), "{}");
  await writeFile(join(outside, "x.ts"), "const x = TYPE_ERROR;\n");
  await symlink(outside, join(ws, "linked"));
  await symlink(join(outside, "x.ts"), join(ws, "linked-file.ts"));
  await writeFile(join(ws, "notes.txt"), "plain\n");
  const lsp = manager(t);

  assert.equal(
    await lsp.execute({ action: "diagnostics", path: "linked/x.ts" }, ws, false),
    "Language servers are disabled in untrusted projects.",
  );
  assert.equal(await lsp.checkFileAfterEdit("linked/x.ts", ws, false), undefined);

  // Outside the directory, also when reached through a link inside it
  for (const path of [join(outside, "x.ts"), "linked/x.ts", "linked-file.ts", "../x.ts"]) {
    assert.match(
      await lsp.execute({ action: "hover", path, line: 1 }, ws, true),
      /is outside the session working directory/u,
      path,
    );
    assert.equal(await lsp.checkFileAfterEdit(path, ws, true), undefined);
  }
  assert.equal(
    await lsp.execute({ action: "diagnostics", path: "notes.txt" }, ws, true),
    'No language server is configured for "notes.txt".',
  );
  assert.deepEqual(await pids(), [], "no server was started");
});

test("the workspace root is the outermost marker inside the session directory, however it is reached", async (t) => {
  const base = await tempDir(t, "pi-lsp-root-");
  const repo = join(base, "repo");
  await mkdir(join(repo, "packages", "one"), { recursive: true });
  await mkdir(join(repo, "packages", "two"), { recursive: true });
  // A marker above the session directory must not become the server's root
  await writeFile(join(base, "tsconfig.json"), "{}");
  await writeFile(join(repo, "packages", "one", "a.ts"), "const a = TYPE_ERROR;\n");
  await writeFile(join(repo, "packages", "two", "b.ts"), "const b = 1;\n");
  await symlink(repo, join(base, "alias"));
  const ws = await workspace(t, { ts: ["pull", ".ts"] });
  await rm(join(ws, "tsconfig.json"));
  const lsp = manager(t);

  // No marker inside the session directory: the directory itself is the root
  const viaAlias = await lsp.execute(
    { action: "diagnostics", path: join(repo, "packages", "one", "a.ts") },
    join(base, "alias"),
    true,
  );
  assert.match(viaAlias, /^packages\/one\/a\.ts: 1 error \(ts\)/u);
  assert.deepEqual(
    lsp.snapshot().servers.map((server) => server.workspaceRoot),
    [repo],
  );

  // Packages of a monorepo share the server of the outermost marker
  await writeFile(join(repo, "packages", "tsconfig.json"), "{}");
  await writeFile(join(repo, "packages", "one", "tsconfig.json"), "{}");
  const second = new LspManager();
  t.after(() => second.shutdownAll());
  await second.execute({ action: "diagnostics", path: "packages/one/a.ts" }, repo, true);
  await second.execute({ action: "diagnostics", path: "packages/two/b.ts" }, repo, true);
  assert.deepEqual(second.snapshot().servers, [
    { id: "ts", workspaceRoot: join(repo, "packages"), openFiles: 2 },
  ]);
});

test("missing servers are reported once, and paths resolve like the built-in file tools", async (t) => {
  const ws = await workspace(t, { ts: ["pull", ".ts"] });
  await writeFile(join(ws, "my file.ts"), "const a = TYPE_ERROR;\n");
  await writeFile(join(ws, "main.go"), "package main\n");
  const lsp = new LspManager({ envPath: "" });
  t.after(() => lsp.shutdownAll());

  const missing = 'Language server "go" is not installed (tried: gopls).';
  assert.equal(await lsp.execute({ action: "diagnostics", path: "main.go" }, ws, true), missing);
  assert.equal(await lsp.checkFileAfterEdit("main.go", ws, true), undefined);
  assert.deepEqual(lsp.snapshot().unavailable, [missing]);

  assert.match(
    await lsp.execute(
      { action: "diagnostics", path: pathToFileURL(join(ws, "my file.ts")).href },
      ws,
      true,
    ),
    /^my file\.ts: 1 error \(ts\)/u,
  );
});

test("a server start belongs to the session: callers can leave, and shutdown reaps it", async (t) => {
  const ws = await workspace(t, {
    slow: ["pull-slow-init", ".ts", 600],
    broken: ["corrupt-after-init", ".zz"],
  });
  const pids = serverPids(t, ws);
  await writeFile(join(ws, "a.ts"), "const a = TYPE_ERROR;\n");
  await writeFile(join(ws, "b.zz"), "x\n");

  // A caller aborted while its server starts is the only one affected
  const lsp = new LspManager();
  const leaving = new AbortController();
  setTimeout(() => leaving.abort(), 100);
  const [left, stayed] = await Promise.allSettled([
    lsp.execute({ action: "diagnostics", path: "a.ts" }, ws, true, leaving.signal),
    lsp.execute({ action: "diagnostics", path: "a.ts" }, ws, true),
  ]);
  assert.equal(left.status, "rejected");
  assert.equal(stayed.status === "fulfilled" && stayed.value.startsWith("a.ts: 1 error"), true);
  assert.equal((await pids()).length, 1);

  // A server whose channel breaks is closed and replaced on the next call
  await lsp.execute({ action: "diagnostics", path: "b.zz" }, ws, true);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await lsp.execute({ action: "diagnostics", path: "b.zz" }, ws, true);
  assert.equal((await pids()).length, 3);
  await lsp.shutdownAll();
  await waitUntil(async () => !(await pids()).some(isPidAlive));

  // Shutdown during startup: the initializing server is gone when shutdown returns
  const second = new LspManager();
  const call = second.execute({ action: "diagnostics", path: "a.ts" }, ws, true);
  await waitUntil(async () => (await pids()).length === 4);
  await second.shutdownAll();
  assert.equal((await pids()).some(isPidAlive), false);
  assert.equal(await call, "Language servers were stopped.");
  assert.equal(
    await second.execute({ action: "diagnostics", path: "a.ts" }, ws, true),
    "Language servers were stopped.",
  );
  assert.equal((await pids()).length, 4);
});

test("a pull refused with ServerCancelled or ContentModified is sent once more", async (t) => {
  const retry = await startClient(t, "pull-retry");
  const file = join(retry.dir, "a.ts");
  await writeFile(file, "const x = TYPE_ERROR;\n");
  // The first attempt is refused with ServerCancelled, the next one with ContentModified
  assert.deepEqual(codes(await retry.client.diagnostics(file, 1_000)), ["TS2322"]);
  await writeFile(file, "const x = 1;\n");
  assert.deepEqual(await retry.client.diagnostics(file, 1_000), []);

  // A server that keeps refusing is an error after one retry, not a clean file
  const busy = await startClient(t, "pull-busy");
  const other = join(busy.dir, "a.ts");
  await writeFile(other, "const x = TYPE_ERROR;\n");
  await assert.rejects(busy.client.diagnostics(other, 1_000), { code: -32802 });
});

test("only files whose contents changed on disk are reported as changed", async (t) => {
  const dir = await tempDir(t, "pi-lsp-watched-");
  const log = join(dir, "watched.log");
  setEnv(t, "MOCK_LSP_WATCHED_LOG", log);
  const notifications = async () => {
    // Notifications are processed in order: a request answered after them marks the point
    await client.hover(join(clientDir, "probe.ts"), 1, undefined);
    return (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  };
  const { client, dir: clientDir } = await startClient(t, "pull");
  await writeFile(join(clientDir, "probe.ts"), "const p = 1;\n");
  await writeFile(join(clientDir, "a.ts"), "export function greet() {}\n");
  await writeFile(join(clientDir, "b.ts"), "const b = 1;\n");

  // Looking at files for the first time is not a change
  await client.hover(join(clientDir, "a.ts"), 1, "greet");
  await client.diagnostics(join(clientDir, "a.ts"), 1_000);
  assert.equal(await notifications(), 0);
  // A file that was just edited is, even when the server sees it for the first time
  await client.diagnostics(join(clientDir, "b.ts"), 1_000, { edited: true });
  assert.equal(await notifications(), 1);
  // So is a file found changed since it was last synced, and nothing else
  await writeFile(join(clientDir, "a.ts"), "export function greet() { return 1; }\n");
  await client.hover(join(clientDir, "a.ts"), 1, "greet");
  assert.equal(await notifications(), 2);
  await client.hover(join(clientDir, "a.ts"), 1, "greet");
  await client.diagnostics(join(clientDir, "b.ts"), 1_000, { edited: true });
  assert.equal(await notifications(), 2);
});

test("typescript-language-server is asked for diagnostics synchronously instead of trusting its pushes", async (t) => {
  const { client, dir } = await startClient(t, "tsserver");
  const file = join(dir, "a.ts");
  const check = () => timed(() => client.diagnostics(file, 5_000));

  await writeFile(file, "const a = TYPE_ERROR; // UNUSED_WARN HINT_ONLY\n");
  const first = await check();
  assert.deepEqual(
    first.value?.map((item) => [item.line, item.column, item.severity, item.code]),
    [
      [1, 11, "error", "2322"],
      [1, 26, "warning", "6133"],
      [1, 38, "hint", "80001"],
    ],
  );

  // After every change the server pushes a report for the previous contents; it is not used
  await writeFile(file, "const a = 1;\n");
  const fixed = await check();
  assert.deepEqual(fixed.value, []);
  // A clean file edited into another clean file is answered at once, not after a push timeout
  await writeFile(file, "const a = 2;\n");
  const clean = await check();
  assert.deepEqual(clean.value, []);
  await writeFile(file, "const a = TYPE_ERROR;\n");
  const broken = await check();
  assert.deepEqual(codes(broken.value), ["2322"]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(codes((await check()).value), ["2322"]);
  for (const result of [first, fixed, clean, broken]) {
    assert.ok(result.ms < 500, `took ${result.ms}ms`);
  }

  // A diagnostic without a usable position falls back to the start of the file
  await writeFile(file, "\nconst a = 1; // POSITIONLESS\n");
  assert.deepEqual(
    (await check()).value?.map((item) => [item.line, item.column, item.code]),
    [[1, 1, "9999"]],
  );
});

test("reset stops running process groups, clears unavailable servers, and reloads lsp.json", async (t) => {
  const agentDir = await tempDir(t, "pi-lsp-reset-agent-");
  setEnv(t, "PI_CODING_AGENT_DIR", agentDir);
  const ws = await tempDir(t, "pi-lsp-reset-ws-");
  await writeFile(join(ws, "tsconfig.json"), "{}");
  await writeFile(join(ws, "a.ts"), "const a = TYPE_ERROR;\n");
  await writeFile(join(ws, "b.zz"), "const b = TYPE_ERROR;\n");
  await writeFile(join(ws, "main.go"), "package main\n");

  const pids = serverPids(t, ws);
  const workerPidFile = join(ws, "worker.pid");
  setEnv(t, "MOCK_LSP_GRANDCHILD_PID_FILE", workerPidFile);

  const configPath = join(agentDir, "lsp.json");
  await writeFile(
    configPath,
    JSON.stringify({
      requestTimeoutSeconds: 1,
      servers: {
        ts: {
          command: process.execPath,
          args: [mockServerScript, "pull"],
          extensions: [".ts"],
          rootMarkers: ["tsconfig.json"],
          languageId: "typescript",
        },
        broken: {
          command: process.execPath,
          args: [mockServerScript, "hang-on-initialize"],
          extensions: [".zz"],
          rootMarkers: ["tsconfig.json"],
          languageId: "typescript",
        },
      },
    }),
  );

  const binDir = await tempDir(t, "pi-lsp-reset-bin-");
  const lsp = new LspManager({ envPath: binDir });
  t.after(() => lsp.shutdownAll());

  // 1. Start a running server (with a grandchild worker), a missing server, and a broken server
  assert.match(
    await lsp.execute({ action: "diagnostics", path: "a.ts" }, ws, true),
    /^a\.ts: 1 error \(ts\)/u,
  );
  await waitUntil(async () => Number(await readFile(workerPidFile, "utf8").catch(() => "")) > 0);
  const firstWorkerPid = Number(await readFile(workerPidFile, "utf8"));
  assert.ok(firstWorkerPid > 0 && isPidAlive(firstWorkerPid));

  assert.match(
    await lsp.execute({ action: "diagnostics", path: "main.go" }, ws, true),
    /Language server "go" is not installed/u,
  );
  assert.match(
    await lsp.execute({ action: "diagnostics", path: "b.zz" }, ws, true),
    /Language server "broken" failed to start/u,
  );
  assert.equal(lsp.snapshot().servers.length, 1);
  assert.equal(lsp.snapshot().unavailable.length, 2);

  const initialPids = await pids();
  assert.equal(initialPids.length, 2);

  // 2. Fix lsp.json so both broken (.zz) and go (.go) point to working servers, then reset
  await writeFile(
    configPath,
    JSON.stringify({
      servers: {
        ts: {
          command: process.execPath,
          args: [mockServerScript, "pull"],
          extensions: [".ts"],
          rootMarkers: ["tsconfig.json"],
          languageId: "typescript",
        },
        broken: {
          command: process.execPath,
          args: [mockServerScript, "pull"],
          extensions: [".zz"],
          rootMarkers: ["tsconfig.json"],
          languageId: "typescript",
        },
        go: {
          command: process.execPath,
          args: [mockServerScript, "pull"],
          extensions: [".go"],
          rootMarkers: ["tsconfig.json"],
          languageId: "go",
        },
      },
    }),
  );

  await lsp.reset();
  assert.equal(isPidAlive(firstWorkerPid), false, "grandchild worker must exit on reset");
  assert.equal(initialPids.some(isPidAlive), false, "previous server pids must exit on reset");
  assert.deepEqual(lsp.snapshot(), { servers: [], unavailable: [] });

  // 3. Subsequent edits and queries lazily start recovered servers with refreshed config
  assert.match(
    (await lsp.checkFileAfterEdit("b.zz", ws, true)) ?? "",
    /LSP diagnostics \(1 error\)/u,
  );
  assert.equal(
    await lsp.execute({ action: "diagnostics", path: "main.go" }, ws, true),
    "main.go: no errors or warnings reported (go)",
  );
  assert.equal(lsp.snapshot().servers.length, 2);
});

test("reset reaps an initializing server and lets subsequent calls start a fresh one", async (t) => {
  const ws = await workspace(t, { slow: ["pull-slow-init", ".ts", 350] });
  const pids = serverPids(t, ws);
  const workerPidFile = join(ws, "reset-race-worker.pid");
  setEnv(t, "MOCK_LSP_GRANDCHILD_PID_FILE", workerPidFile);
  await writeFile(join(ws, "a.ts"), "const a = TYPE_ERROR;\n");

  const lsp = manager(t);
  const inflightEdit = lsp.checkFileAfterEdit("a.ts", ws, true);
  const inflightQuery = lsp.execute({ action: "diagnostics", path: "a.ts" }, ws, true);
  await waitUntil(async () => (await pids()).length === 1);
  await waitUntil(async () => {
    const raw = await readFile(workerPidFile, "utf8").catch(() => "");
    return Number(raw) > 0;
  });
  const startingWorkerPid = Number(await readFile(workerPidFile, "utf8"));

  await lsp.reset();
  assert.equal(await inflightEdit, undefined);
  assert.equal(await inflightQuery, "Language servers were stopped.");
  assert.equal((await pids()).some(isPidAlive), false);
  assert.equal(isPidAlive(startingWorkerPid), false);
  assert.deepEqual(lsp.snapshot(), { servers: [], unavailable: [] });

  assert.match(
    await lsp.execute({ action: "diagnostics", path: "a.ts" }, ws, true),
    /^a\.ts: 1 error \(slow\)/u,
  );
  assert.equal((await pids()).length, 2);
});

test("reset awaits cleanup of crashed-server workers and replaced broken-RPC servers", async (t) => {
  const ws = await workspace(t, {
    stubborn: ["hang-on-shutdown", ".ts"],
    corrupt: ["corrupt-after-init", ".zz"],
  });
  const pids = serverPids(t, ws);
  const workerPidFile = join(ws, "stubborn-worker.pid");
  setEnv(t, "MOCK_LSP_GRANDCHILD_PID_FILE", workerPidFile);
  await writeFile(join(ws, "a.ts"), "const a = 1;\n");
  await writeFile(join(ws, "b.zz"), "const b = 1;\n");

  const lsp = manager(t);

  const nextWorkerPid = async () => {
    await waitUntil(async () => Number(await readFile(workerPidFile, "utf8").catch(() => "")) > 0);
    const pid = Number(await readFile(workerPidFile, "utf8"));
    await rm(workerPidFile);
    return pid;
  };

  // 1. Crash/kill the server leader: onExit sends SIGTERM (ignored by worker) and removes client
  await lsp.execute({ action: "diagnostics", path: "a.ts" }, ws, true);
  const [crashedServerPid] = await pids();
  assert.ok(crashedServerPid);
  const crashedWorkerPid = await nextWorkerPid();
  assert.equal(isPidAlive(crashedWorkerPid), true);

  process.kill(crashedServerPid, "SIGKILL");
  await waitUntil(() => lsp.snapshot().servers.length === 0);
  // The worker ignores SIGTERM and is still being reaped in the background when reset starts
  assert.equal(isPidAlive(crashedWorkerPid), true);

  const firstReset = lsp.reset();
  await lsp.reset();
  assert.equal(
    isPidAlive(crashedWorkerPid),
    false,
    "worker must be gone even when a second concurrent reset returns",
  );
  await firstReset;

  // 2. Break the RPC channel: wait until clientFor replaces the dead client while its worker is still alive
  await lsp.execute({ action: "diagnostics", path: "b.zz" }, ws, true);
  const corruptServerPid = (await pids()).at(-1);
  assert.ok(corruptServerPid);
  const corruptWorkerPid = await nextWorkerPid();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(isPidAlive(corruptServerPid), true);
  assert.equal(isPidAlive(corruptWorkerPid), true);

  const replacing = lsp.execute({ action: "diagnostics", path: "b.zz" }, ws, true);
  await waitUntil(async () => (await pids()).length === 3);
  const replacementWorkerPid = await nextWorkerPid();
  assert.equal(isPidAlive(corruptWorkerPid), true);

  await lsp.reset();
  assert.equal(
    isPidAlive(corruptServerPid),
    false,
    "evicted server must be gone when reset returns",
  );
  assert.equal(
    isPidAlive(corruptWorkerPid),
    false,
    "evicted worker must be gone when reset returns",
  );
  assert.equal(isPidAlive(replacementWorkerPid), false);
  await replacing;
});
