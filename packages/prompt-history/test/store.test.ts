import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendHistoryEntry,
  defaultHistoryDir,
  HISTORY_DIR_NAME,
  HISTORY_VERSION,
  historyCwdDir,
  MAX_ENTRY_BYTES,
  MAX_FILE_BYTES,
  MAX_HISTORY_ENTRIES,
  readHistory,
} from "../src/store.ts";

const storeModuleUrl = new URL("../src/store.ts", import.meta.url).href;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("readHistory returns empty entries without creating storage and honors PI_CODING_AGENT_DIR", async (t: TestContext) => {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-prompt-history-env-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const agentDir = join(sandbox, "agent");
  const cwd = join(sandbox, "project");
  await mkdir(cwd, { recursive: true });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  assert.equal(defaultHistoryDir(), join(agentDir, HISTORY_DIR_NAME));

  const empty = await readHistory(cwd);
  assert.deepEqual(empty, {
    status: "ok",
    dirPath: historyCwdDir(cwd),
    entries: [],
  });
  await assert.rejects(stat(join(agentDir, HISTORY_DIR_NAME)), { code: "ENOENT" });

  const saved = await appendHistoryEntry(cwd, "npm test");
  assert.equal(saved.status, "saved");

  if (process.platform !== "win32") {
    const rootStats = await stat(join(agentDir, HISTORY_DIR_NAME));
    const cwdDirStats = await stat(historyCwdDir(cwd));
    assert.equal(rootStats.mode & 0o777, 0o700);
    assert.equal(cwdDirStats.mode & 0o777, 0o700);

    const entryFiles = await readdir(historyCwdDir(cwd));
    assert.equal(entryFiles.length, 1);
    const [entryFile] = entryFiles;
    assert.ok(entryFile);
    const entryStats = await stat(join(historyCwdDir(cwd), entryFile));
    assert.equal(entryStats.mode & 0o777, 0o600);
  }

  // Project directory itself must remain untouched.
  assert.deepEqual(await readdir(cwd), []);
});

test("directory keying normalizes lexical paths and keeps symlinks isolated", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-history-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const storeDir = join(root, "store");
  const realCwd = join(root, "workspace", "app");
  const linkCwd = join(root, "app-link");
  await mkdir(realCwd, { recursive: true });

  await appendHistoryEntry(join(realCwd, "..", "app/"), "from lexical variant", {
    rootDir: storeDir,
  });
  const fromCanonical = await readHistory(realCwd, { rootDir: storeDir });
  assert.equal(fromCanonical.status, "ok");
  assert.deepEqual(fromCanonical.entries, ["from lexical variant"]);

  if (process.platform !== "win32") {
    await symlink(realCwd, linkCwd);
    const fromSymlink = await readHistory(linkCwd, { rootDir: storeDir });
    assert.equal(fromSymlink.status, "ok");
    assert.deepEqual(fromSymlink.entries, []);
  }
});

test("recording ignores blank input, collapses consecutive duplicates, and preserves exact text", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-history-text-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const storeDir = join(root, "store");
  const cwd = join(root, "cwd");

  for (const blank of ["", "   ", "\n\t  \n"]) {
    const result = await appendHistoryEntry(cwd, blank, { rootDir: storeDir });
    assert.deepEqual(result, { status: "ignored_blank" });
  }
  await assert.rejects(stat(storeDir), { code: "ENOENT" });

  const multiline = [
    "Review this snippet:",
    "  if (ready) {",
    "    console.log('你好，世界 🚀');",
    "",
    "  }",
  ].join("\n");

  const first = await appendHistoryEntry(cwd, multiline, { rootDir: storeDir });
  assert.equal(first.status, "saved");

  const duplicate = await appendHistoryEntry(cwd, multiline, { rootDir: storeDir });
  assert.equal(duplicate.status, "deduplicated");

  const second = await appendHistoryEntry(cwd, "follow-up check", { rootDir: storeDir });
  assert.equal(second.status, "saved");

  // Non-consecutive repeat is appended as the newest entry.
  const nonConsecutive = await appendHistoryEntry(cwd, multiline, { rootDir: storeDir });
  assert.equal(nonConsecutive.status, "saved");

  const loaded = await readHistory(cwd, { rootDir: storeDir });
  assert.equal(loaded.status, "ok");
  assert.deepEqual(loaded.entries, [multiline, "follow-up check", multiline]);
});

test("oversized entries above 256 KiB are skipped without truncating or modifying stored history", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-history-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const storeDir = join(root, "store");
  const cwd = join(root, "cwd");

  const exactMax = "x".repeat(MAX_ENTRY_BYTES);
  const exactResult = await appendHistoryEntry(cwd, exactMax, { rootDir: storeDir });
  assert.equal(exactResult.status, "saved");

  const cwdDir = historyCwdDir(cwd, storeDir);
  const beforeFiles = await readdir(cwdDir);
  assert.equal(beforeFiles.length, 1);

  const oneByteOver = `${exactMax}y`;
  const overResult = await appendHistoryEntry(cwd, oneByteOver, { rootDir: storeDir });
  assert.deepEqual(overResult, {
    status: "skipped_oversized",
    byteLength: MAX_ENTRY_BYTES + 1,
    maxBytes: MAX_ENTRY_BYTES,
  });

  assert.deepEqual(await readdir(cwdDir), beforeFiles);

  const loaded = await readHistory(cwd, { rootDir: storeDir });
  assert.equal(loaded.status, "ok");
  assert.deepEqual(loaded.entries, [exactMax]);
});

test("retention evicts oldest whole entry files beyond 100 entries and 2 MiB total budget, and surfaces non-ENOENT unlink errors", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-history-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const storeDir = join(root, "store");
  const countCwd = join(root, "count-cwd");

  for (let index = 1; index <= 105; index++) {
    const res = await appendHistoryEntry(countCwd, `entry-${index}`, { rootDir: storeDir });
    assert.equal(res.status, "saved");
  }

  const countDir = historyCwdDir(countCwd, storeDir);
  const countFilesAfterPrune = await readdir(countDir);
  assert.equal(countFilesAfterPrune.length, MAX_HISTORY_ENTRIES);

  const countLoaded = await readHistory(countCwd, { rootDir: storeDir });
  assert.equal(countLoaded.status, "ok");
  assert.equal(countLoaded.entries.length, MAX_HISTORY_ENTRIES);
  assert.equal(countLoaded.entries[0], "entry-6");
  assert.equal(countLoaded.entries.at(-1), "entry-105");

  // Exercise multi-entry pruning where one unlink fails with EACCES while others succeed:
  // the newly written prompt must remain committed while appendHistoryEntry reports prune_error.
  const partialCwd = join(root, "partial-prune-cwd");
  const partialDir = historyCwdDir(partialCwd, storeDir);
  const smallPayload = "s".repeat(50 * 1024);
  const largePayload = "L".repeat(250 * 1024);

  // 5 * 50 KiB + 7 * 250 KiB = 2000 KiB <= 2048 KiB: all 12 initial entries fit in the window.
  for (let i = 1; i <= 5; i++) {
    assert.equal(
      (await appendHistoryEntry(partialCwd, `small-${i}:${smallPayload}`, { rootDir: storeDir }))
        .status,
      "saved",
    );
  }
  for (let i = 1; i <= 7; i++) {
    assert.equal(
      (await appendHistoryEntry(partialCwd, `large-${i}:${largePayload}`, { rootDir: storeDir }))
        .status,
      "saved",
    );
  }

  const initialFiles = (await readdir(partialDir)).sort();
  assert.equal(initialFiles.length, 12);
  // Appending one more 250 KiB entry evicts all 5 small entries at once; block only the 3rd one.
  const blockedOldFileName = initialFiles[2];
  assert.ok(blockedOldFileName);
  const blockedOldFilePath = join(partialDir, blockedOldFileName);

  const unlinkShimSource = [
    'import * as realFs from "node:fs";',
    "export const { mkdir, open, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile, chmod } = realFs.promises;",
    "export async function unlink(targetPath) {",
    "  if (String(targetPath) === process.env.BLOCKED_UNLINK_PATH) {",
    '    throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" });',
    "  }",
    "  return realFs.promises.unlink(targetPath);",
    "}",
  ].join("\n");
  const unlinkShimUrl = `data:text/javascript,${encodeURIComponent(unlinkShimSource)}`;
  const unlinkHookLoader = [
    "export async function resolve(specifier, context, nextResolve) {",
    `  if (specifier === "node:fs/promises" && context.parentURL === ${JSON.stringify(storeModuleUrl)}) {`,
    `    return { url: ${JSON.stringify(unlinkShimUrl)}, shortCircuit: true };`,
    "  }",
    "  return nextResolve(specifier, context);",
    "}",
  ].join("\n");
  const registerLoaderScript = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(unlinkHookLoader)}`)});`;
  const eaccesWorkerScript = `
    import assert from "node:assert/strict";
    import { appendHistoryEntry } from ${JSON.stringify(storeModuleUrl)};
    const [targetCwd, rootDir] = process.argv.slice(1);
    const payload = \`large-8:\${"L".repeat(250 * 1024)}\`;
    const res = await appendHistoryEntry(targetCwd, payload, { rootDir });
    assert.equal(res.status, "prune_error");
    assert.match(res.message, /EACCES/u);
  `;

  await new Promise<void>((resolveChild, rejectChild) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(registerLoaderScript)}`,
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        eaccesWorkerScript,
        partialCwd,
        storeDir,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, BLOCKED_UNLINK_PATH: blockedOldFilePath },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectChild);
    child.once("close", (code) => {
      if (code === 0) resolveChild();
      else rejectChild(new Error(`EACCES worker failed (${code}): ${stderr}`));
    });
  });

  // 4 of the 5 obsolete files were removed, 1 blocked obsolete file remained, and all 8 kept entries
  // (including the newly committed large-8 prompt) survived without rollback.
  const filesAfterPartialPrune = await readdir(partialDir);
  assert.equal(filesAfterPartialPrune.length, 9);
  assert.ok(filesAfterPartialPrune.includes(blockedOldFileName));

  const partialLoaded = await readHistory(partialCwd, { rootDir: storeDir });
  assert.equal(partialLoaded.status, "ok");
  assert.deepEqual(
    partialLoaded.entries,
    Array.from({ length: 8 }, (_, idx) => `large-${idx + 1}:${largePayload}`),
  );

  // Exercise the 2 MiB serialized directory budget, including JSON-escaped characters.
  const byteCwd = join(root, "byte-cwd");
  const chunk = `${'line-"quoted"\n'.repeat(15_000)}`;
  assert.ok(Buffer.byteLength(chunk, "utf8") <= MAX_ENTRY_BYTES);

  for (let index = 1; index <= 12; index++) {
    const res = await appendHistoryEntry(byteCwd, `${index}:${chunk}`, { rootDir: storeDir });
    assert.equal(res.status, "saved");
  }

  const byteDir = historyCwdDir(byteCwd, storeDir);
  const remainingFiles = await readdir(byteDir);
  let totalBytes = 0;
  for (const name of remainingFiles) {
    totalBytes += (await stat(join(byteDir, name))).size;
  }
  assert.ok(
    totalBytes <= MAX_FILE_BYTES,
    `Expected total directory bytes <= ${MAX_FILE_BYTES}, got ${totalBytes}`,
  );

  const byteLoaded = await readHistory(byteCwd, { rootDir: storeDir });
  assert.equal(byteLoaded.status, "ok");
  assert.ok(byteLoaded.entries.length > 1 && byteLoaded.entries.length < 12);
  assert.equal(byteLoaded.entries.at(-1), `12:${chunk}`);
  for (const entry of byteLoaded.entries) {
    assert.ok(entry.endsWith(`:${chunk}`), "Eviction must drop whole entries without truncation");
  }
});

test("corrupt and unwritable storage fails safely without clobbering existing files", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-history-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const storeDir = join(root, "store");
  await mkdir(storeDir, { recursive: true });

  const validEntryName = "000000000000001-0123456789ab.json";
  const corruptEntryCases: Array<{ name: string; content: string }> = [
    { name: "invalid-json", content: "{not valid json" },
    {
      name: "wrong-version",
      content: JSON.stringify({
        version: 99,
        cwd: resolve(join(root, "wrong-version")),
        text: "a",
      }),
    },
    {
      name: "mismatched-cwd",
      content: JSON.stringify({ version: HISTORY_VERSION, cwd: "/some/other/cwd", text: "a" }),
    },
    {
      name: "blank-entry",
      content: JSON.stringify({
        version: HISTORY_VERSION,
        cwd: resolve(join(root, "blank-entry")),
        text: "   ",
      }),
    },
    {
      name: "oversized-file",
      content: "a".repeat(MAX_FILE_BYTES + 64),
    },
  ];

  for (const item of corruptEntryCases) {
    const targetCwd = join(root, item.name);
    const targetDir = historyCwdDir(targetCwd, storeDir);
    await mkdir(targetDir, { recursive: true });
    const targetFile = join(targetDir, validEntryName);
    await writeFile(targetFile, item.content, "utf8");

    const readRes = await readHistory(targetCwd, { rootDir: storeDir });
    assert.equal(readRes.status, "corrupt", `Expected corrupt read for ${item.name}`);

    const appendRes = await appendHistoryEntry(targetCwd, "new prompt", { rootDir: storeDir });
    assert.equal(appendRes.status, "corrupt", `Expected corrupt append for ${item.name}`);

    // Corrupt file must remain untouched on disk and no extra entry may be added.
    assert.equal(await readFile(targetFile, "utf8"), item.content);
    assert.deepEqual(await readdir(targetDir), [validEntryName]);
  }

  // Unrelated files (such as macOS .DS_Store) are skipped without disabling history or being deleted.
  const dsStoreCwd = join(root, "ds-store-cwd");
  assert.equal(
    (await appendHistoryEntry(dsStoreCwd, "before ds_store", { rootDir: storeDir })).status,
    "saved",
  );
  const dsStoreFile = join(historyCwdDir(dsStoreCwd, storeDir), ".DS_Store");
  await writeFile(dsStoreFile, "\x00\x00\x00\x01Bud1", "utf8");

  const readWithDsStore = await readHistory(dsStoreCwd, { rootDir: storeDir });
  assert.equal(readWithDsStore.status, "ok");
  assert.deepEqual(readWithDsStore.entries, ["before ds_store"]);

  assert.equal(
    (await appendHistoryEntry(dsStoreCwd, "after ds_store", { rootDir: storeDir })).status,
    "saved",
  );
  const readAfterAppend = await readHistory(dsStoreCwd, { rootDir: storeDir });
  assert.equal(readAfterAppend.status, "ok");
  assert.deepEqual(readAfterAppend.entries, ["before ds_store", "after ds_store"]);
  assert.equal(await readFile(dsStoreFile, "utf8"), "\x00\x00\x00\x01Bud1");

  // Regular file occupying the cwd history directory path is treated as corrupt and left intact.
  const fileSlotCwd = join(root, "file-collision");
  const fileSlotPath = historyCwdDir(fileSlotCwd, storeDir);
  await writeFile(fileSlotPath, "not-a-dir", "utf8");
  assert.equal((await readHistory(fileSlotCwd, { rootDir: storeDir })).status, "corrupt");
  assert.equal(
    (await appendHistoryEntry(fileSlotCwd, "hello", { rootDir: storeDir })).status,
    "corrupt",
  );
  assert.equal(await readFile(fileSlotPath, "utf8"), "not-a-dir");

  // Unwritable parent path (a regular file blocking mkdir) degrades to io_error.
  const blockedRoot = join(root, "blocked-file");
  await writeFile(blockedRoot, "not-a-directory", "utf8");
  const ioRes = await appendHistoryEntry(join(root, "any-cwd"), "hello", { rootDir: blockedRoot });
  assert.equal(ioRes.status, "io_error");

  if (process.platform !== "win32" && process.geteuid?.() !== 0) {
    const readOnlyDir = join(root, "readonly-store");
    await mkdir(readOnlyDir, { mode: 0o500 });
    t.after(() => chmod(readOnlyDir, 0o700).catch(() => {}));
    const roRes = await appendHistoryEntry(join(root, "ro-cwd"), "hello", {
      rootDir: readOnlyDir,
    });
    assert.equal(roRes.status, "io_error");
  }
});

test("paused writer (>60s) survives concurrent temp-file cleanup via atomic retry and never clobbers other writers", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-history-interleave-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const storeDir = join(root, "store");
  const cwd = join(root, "cwd");
  const normalizedCwd = resolve(cwd);
  const cwdDir = historyCwdDir(cwd, storeDir);
  await mkdir(cwdDir, { recursive: true });

  // 1. Fresh own .tmp-<pid>-<uuid> (<60s) and aged foreign .tmp-* files are left untouched,
  // while stale own .tmp-<pid>-<uuid> files (>60s) are pruned.
  const freshTmp = join(cwdDir, ".tmp-88888-11111111-1111-4111-8111-111111111111");
  const freshFinal = join(cwdDir, "000000000000010-aaaaaaaaaaaa.json");
  await writeFile(
    freshTmp,
    `${JSON.stringify({ version: HISTORY_VERSION, cwd: normalizedCwd, text: "fresh-paused" })}\n`,
    "utf8",
  );

  const staleOrphanTmp = join(cwdDir, ".tmp-99999-00000000-0000-4000-8000-000000000000");
  await writeFile(staleOrphanTmp, "partial", "utf8");
  const foreignAgedTmp = join(cwdDir, ".tmp-notes");
  await writeFile(foreignAgedTmp, "user notes", "utf8");
  const agedDate = new Date(Date.now() - 120_000);
  await utimes(staleOrphanTmp, agedDate, agedDate);
  await utimes(foreignAgedTmp, agedDate, agedDate);

  assert.equal(
    (await appendHistoryEntry(cwd, "writer-early", { rootDir: storeDir })).status,
    "saved",
  );
  await assert.rejects(stat(staleOrphanTmp), { code: "ENOENT" });
  assert.equal(await readFile(foreignAgedTmp, "utf8"), "user notes");
  await stat(freshTmp);
  await rename(freshTmp, freshFinal);

  // 2. Real two-process interleaving where writer A pauses >60s right before rename:
  // writer B prunes A's aged .tmp-* file, and A recovers from ENOENT by retrying with a fresh temp file.
  const pauseCwd = join(root, "pause-over-60s-cwd");
  const pauseDir = historyCwdDir(pauseCwd, storeDir);

  const pauseShimSource = [
    'import * as realFs from "node:fs";',
    "export const { mkdir, open, readdir, readFile, rm, stat, symlink, unlink, utimes, writeFile, chmod } = realFs.promises;",
    "let intercepted = false;",
    "export async function rename(oldPath, newPath) {",
    '  if (!intercepted && String(oldPath).includes(".tmp-")) {',
    "    intercepted = true;",
    "    const oldTime = new Date(Date.now() - 61_000);",
    "    await realFs.promises.utimes(oldPath, oldTime, oldTime);",
    '    process.stdout.write("PAUSED_BEFORE_RENAME\\n");',
    "    await new Promise((resolveResume) => {",
    '      process.stdin.once("data", () => resolveResume());',
    "    });",
    "  }",
    "  return realFs.promises.rename(oldPath, newPath);",
    "}",
  ].join("\n");
  const pauseShimUrl = `data:text/javascript,${encodeURIComponent(pauseShimSource)}`;
  const pauseRenameLoader = [
    "export async function resolve(specifier, context, nextResolve) {",
    `  if (specifier === "node:fs/promises" && context.parentURL === ${JSON.stringify(storeModuleUrl)}) {`,
    `    return { url: ${JSON.stringify(pauseShimUrl)}, shortCircuit: true };`,
    "  }",
    "  return nextResolve(specifier, context);",
    "}",
  ].join("\n");
  const registerPauseLoader = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(pauseRenameLoader)}`)});`;
  const pausedWriterScript = `
    import assert from "node:assert/strict";
    import { appendHistoryEntry } from ${JSON.stringify(storeModuleUrl)};
    const [targetCwd, rootDir] = process.argv.slice(1);
    const res = await appendHistoryEntry(targetCwd, "writer-A-paused-61s", { rootDir });
    assert.equal(res.status, "saved");
  `;

  const childA = spawn(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(registerPauseLoader)}`,
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      pausedWriterScript,
      pauseCwd,
      storeDir,
    ],
    { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => {
    if (childA.exitCode === null) childA.kill("SIGKILL");
  });

  let childStderr = "";
  childA.stderr.on("data", (chunk: Buffer) => {
    childStderr += chunk.toString("utf8");
  });

  await new Promise<void>((resolvePaused, rejectPaused) => {
    let stdout = "";
    childA.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("PAUSED_BEFORE_RENAME")) {
        resolvePaused();
      }
    });
    childA.once("error", rejectPaused);
    childA.once("close", (code) => {
      if (!stdout.includes("PAUSED_BEFORE_RENAME")) {
        rejectPaused(new Error(`Writer A exited before pause (${code}): ${childStderr}`));
      }
    });
  });

  // Writer B saves while A is paused at 61s, causing B to delete A's aged .tmp-* file.
  const bRes = await appendHistoryEntry(pauseCwd, "writer-B-concurrent", { rootDir: storeDir });
  assert.equal(bRes.status, "saved");
  const filesWhileAPaused = await readdir(pauseDir);
  assert.equal(
    filesWhileAPaused.some((name) => name.startsWith(".tmp-")),
    false,
    "Expected writer B to have pruned writer A's >60s temp file",
  );

  // Resume writer A: its first rename hits ENOENT, retries once with a fresh temp file, and succeeds.
  childA.stdin.end("RESUME\n");
  await new Promise<void>((resolveDone, rejectDone) => {
    childA.once("error", rejectDone);
    childA.once("close", (code) => {
      if (code === 0) resolveDone();
      else rejectDone(new Error(`Writer A failed after resume (${code}): ${childStderr}`));
    });
  });

  const pauseLoaded = await readHistory(pauseCwd, { rootDir: storeDir });
  assert.equal(pauseLoaded.status, "ok");
  assert.deepEqual(
    new Set(pauseLoaded.entries),
    new Set(["writer-A-paused-61s", "writer-B-concurrent"]),
  );
  assert.equal(pauseLoaded.entries.length, 2);

  // 3. Three-writer non-consecutive duplicate interleaving:
  // A2 scans an empty dir and pauses; A1 commits "repeat-A"; B stages "middle-B" before rename;
  // A2 resumes and commits "repeat-A" (seeing [A1, A2] temporarily adjacent) without unlinking A1;
  // once B renames into place between them, readHistory preserves ["repeat-A", "middle-B", "repeat-A"].
  const triCwd = join(root, "three-writer-dedup-cwd");
  const triNormalizedCwd = resolve(triCwd);
  const triDir = historyCwdDir(triCwd, storeDir);

  const pauseAfterEmptyReadShim = [
    'import * as realFs from "node:fs";',
    "export const { mkdir, open, readFile, rename, rm, stat, symlink, unlink, utimes, writeFile, chmod } = realFs.promises;",
    "let pausedOnce = false;",
    "export async function readdir(targetPath) {",
    "  try {",
    "    return await realFs.promises.readdir(targetPath);",
    "  } catch (err) {",
    '    if (!pausedOnce && err && err.code === "ENOENT") {',
    "      pausedOnce = true;",
    '      process.stdout.write("A2_SCANNED_EMPTY\\n");',
    "      await new Promise((r) => process.stdin.once('data', () => r()));",
    "    }",
    "    throw err;",
    "  }",
    "}",
  ].join("\n");
  const pauseAfterEmptyReadUrl = `data:text/javascript,${encodeURIComponent(pauseAfterEmptyReadShim)}`;
  const a2Loader = [
    "export async function resolve(specifier, context, nextResolve) {",
    `  if (specifier === "node:fs/promises" && context.parentURL === ${JSON.stringify(storeModuleUrl)}) {`,
    `    return { url: ${JSON.stringify(pauseAfterEmptyReadUrl)}, shortCircuit: true };`,
    "  }",
    "  return nextResolve(specifier, context);",
    "}",
  ].join("\n");
  const registerA2Loader = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(a2Loader)}`)});`;
  const a2Script = `
    import assert from "node:assert/strict";
    import { appendHistoryEntry } from ${JSON.stringify(storeModuleUrl)};
    const [targetCwd, rootDir] = process.argv.slice(1);
    const res = await appendHistoryEntry(targetCwd, "repeat-A", { rootDir });
    assert.equal(res.status, "saved");
  `;

  const childA2 = spawn(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(registerA2Loader)}`,
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      a2Script,
      triCwd,
      storeDir,
    ],
    { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => {
    if (childA2.exitCode === null) childA2.kill("SIGKILL");
  });
  let a2Stderr = "";
  childA2.stderr.on("data", (chunk: Buffer) => {
    a2Stderr += chunk.toString("utf8");
  });

  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = "";
    childA2.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("A2_SCANNED_EMPTY")) resolveReady();
    });
    childA2.once("error", rejectReady);
    childA2.once("close", (code) => {
      if (!stdout.includes("A2_SCANNED_EMPTY")) {
        rejectReady(new Error(`A2 exited early (${code}): ${a2Stderr}`));
      }
    });
  });

  // Writer A1 commits first.
  assert.equal(
    (await appendHistoryEntry(triCwd, "repeat-A", { rootDir: storeDir })).status,
    "saved",
  );
  const [a1FileName] = await readdir(triDir);
  assert.ok(a1FileName);
  const a1Seq = Number(a1FileName.slice(0, 15));

  // Writer B allocates a sequence after A1, stages its temp file, and pauses before rename.
  const bSeq = Math.max(Date.now(), a1Seq + 1);
  const bTmpPath = join(triDir, ".tmp-staged-writer-b");
  const bFinalPath = join(triDir, `${String(bSeq).padStart(15, "0")}-bbbbbbbbbbbb.json`);
  await writeFile(
    bTmpPath,
    `${JSON.stringify({ version: HISTORY_VERSION, cwd: triNormalizedCwd, text: "middle-B" })}\n`,
    "utf8",
  );

  // Ensure wall clock advances past bSeq before A2 resumes so A2 orders after B.
  while (Date.now() <= bSeq) {
    await new Promise((r) => setTimeout(r, 2));
  }

  childA2.stdin.end("GO\n");
  await new Promise<void>((resolveA2, rejectA2) => {
    childA2.once("error", rejectA2);
    childA2.once("close", (code) => {
      if (code === 0) resolveA2();
      else rejectA2(new Error(`A2 failed (${code}): ${a2Stderr}`));
    });
  });

  // Before B publishes, readHistory folds the two adjacent physical "repeat-A" files in memory.
  const beforeBPublished = await readHistory(triCwd, { rootDir: storeDir });
  assert.equal(beforeBPublished.status, "ok");
  assert.deepEqual(beforeBPublished.entries, ["repeat-A"]);

  // Once B renames into place between A1 and A2, both non-consecutive "repeat-A" entries exist.
  await rename(bTmpPath, bFinalPath);
  const afterBPublished = await readHistory(triCwd, { rootDir: storeDir });
  assert.equal(afterBPublished.status, "ok");
  assert.deepEqual(afterBPublished.entries, ["repeat-A", "middle-B", "repeat-A"]);
});

test("concurrent OS processes in the same cwd preserve completed writes and converge on retention limits", async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-history-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const storeDir = join(root, "store");
  const workerCount = 4;

  const workerScript = `
    import { appendHistoryEntry } from ${JSON.stringify(storeModuleUrl)};
    const [cwd, storeDir, workerId, countStr] = process.argv.slice(1);
    const count = Number(countStr);
    for (let i = 0; i < count; i++) {
      const result = await appendHistoryEntry(
        cwd,
        \`worker-\${workerId}-prompt-\${i}\`,
        { rootDir: storeDir },
      );
      if (result.status !== "saved") {
        console.error("Unexpected append status:", result);
        process.exit(1);
      }
    }
  `;

  const runWorkers = (targetCwd: string, writesPerWorker: number) =>
    Promise.all(
      Array.from({ length: workerCount }, (_, workerId) => {
        return new Promise<void>((resolveWorker, rejectWorker) => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              "tsx",
              "--input-type=module",
              "-e",
              workerScript,
              targetCwd,
              storeDir,
              String(workerId),
              String(writesPerWorker),
            ],
            { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
          );
          t.after(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
          });
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          child.once("error", rejectWorker);
          child.once("close", (code) => {
            if (code === 0) resolveWorker();
            else rejectWorker(new Error(`Worker ${workerId} failed (${code}): ${stderr}`));
          });
        });
      }),
    );

  // 1. Within retention limit (4 * 10 = 40): every completed write must survive.
  const underLimitCwd = join(root, "under-limit");
  await runWorkers(underLimitCwd, 10);

  const underLoaded = await readHistory(underLimitCwd, { rootDir: storeDir });
  assert.equal(underLoaded.status, "ok");
  assert.equal(underLoaded.entries.length, 40);
  const expectedAll = new Set<string>();
  for (let w = 0; w < workerCount; w++) {
    for (let i = 0; i < 10; i++) {
      expectedAll.add(`worker-${w}-prompt-${i}`);
    }
  }
  assert.deepEqual(new Set(underLoaded.entries), expectedAll);
  const underFiles = await readdir(historyCwdDir(underLimitCwd, storeDir));
  assert.ok(underFiles.every((name) => name.endsWith(".json")));

  // 2. Above retention limit (4 * 30 = 120): concurrent pruning stays bounded to 100 entries with no errors.
  const overLimitCwd = join(root, "over-limit");
  await runWorkers(overLimitCwd, 30);

  const overLoaded = await readHistory(overLimitCwd, { rootDir: storeDir });
  assert.equal(overLoaded.status, "ok");
  assert.equal(overLoaded.entries.length, MAX_HISTORY_ENTRIES);
  const overFiles = await readdir(historyCwdDir(overLimitCwd, storeDir));
  assert.ok(overFiles.every((name) => name.endsWith(".json")));
});
