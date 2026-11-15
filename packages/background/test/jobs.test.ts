import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createSessionJobs,
  type JobRecord,
  LOG_OUTPUT_BYTES,
  pruneOldLogs,
  SEED_BYTES,
  TailBuffer,
} from "../src/jobs.ts";
import { createTeeOperations } from "../src/operations.ts";

function nodeScript(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

async function tempDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-background-jobs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startJob(
  session: ReturnType<typeof createSessionJobs>,
  command: string,
): Promise<JobRecord> {
  const job: JobRecord = {
    id: session.newJobId(),
    command,
    controller: new AbortController(),
    startedAtMs: Date.now(),
    logPath: null,
    log: null,
    logBytes: 0,
    tail: new TailBuffer(),
    seed: new TailBuffer(),
    state: "running",
  };
  const tapping = createTeeOperations((data) => {
    job.tail.append(data);
    job.seed.append(data);
  });
  session.jobs.set(job.id, job);
  // The caller does not await execution; swallow the settlement after killAll.
  tapping.operations
    .exec(command, process.cwd(), { onData: () => {}, signal: job.controller.signal })
    .then(
      () => {},
      () => {},
    );
  return job;
}

test("TailBuffer keeps only the last bytes", () => {
  const buffer = new TailBuffer();
  buffer.append(Buffer.alloc(20 * 1024, 97));
  buffer.append(Buffer.from("tail-end", "utf8"));
  assert.ok(buffer.bytes <= 16 * 1024);
  assert.ok(buffer.text().endsWith("tail-end"));
});

test("TailBuffer tracks discarded bytes and clear releases its contents", () => {
  const buffer = new TailBuffer(4);
  assert.equal(buffer.truncated, false);
  buffer.append(Buffer.from("abc"));
  assert.equal(buffer.truncated, false);
  buffer.append(Buffer.from("d"));
  assert.equal(buffer.truncated, false, "exact capacity does not discard output");
  buffer.append(Buffer.from("e"));
  assert.equal(buffer.truncated, true);
  assert.equal(buffer.text(), "bcde");
  buffer.clear();
  assert.equal(buffer.bytes, 0);
  assert.equal(buffer.raw().length, 0);
  assert.equal(buffer.truncated, false);
  buffer.append(Buffer.from("new"));
  assert.equal(buffer.text(), "new");
  assert.equal(buffer.truncated, false);
});

test("job ids are random, fixed-width, and unique per session", async (t) => {
  const session = createSessionJobs("ids", await tempDir(t));
  const ids = new Set(Array.from({ length: 64 }, () => session.newJobId()));
  assert.equal(ids.size, 64);
  for (const id of ids) assert.match(id, /^bg_[0-9a-f]{8}$/u);
});

// The actual process-tree kill is pi's built-in backend behavior, covered by
// operations.test.ts; here we verify killAll aborts every running job exactly
// once and records the reason in its log.
test("openLog creates the log lazily, seeded with prior output", async (t) => {
  const session = createSessionJobs("lazy", await tempDir(t));
  const job = await startJob(
    session,
    nodeScript('process.stdout.write("early\\n"); setTimeout(() => {}, 30000)'),
  );
  assert.equal(job.log, null); // Nothing on disk before backgrounding.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await session.openLog(job), true);
  assert.ok(job.logPath?.endsWith(`${job.id}.log`));
  session.killAll("session ended");
  await session.closeLog(job);
  assert.match(await readFile(job.logPath as string, "utf8"), /early/u);
});

test("openLog degrades to tail-only when the directory is unwritable", async (t) => {
  const root = await tempDir(t);
  const blocker = join(root, "not-a-directory");
  await writeFile(blocker, "file");
  const session = createSessionJobs("unwritable", join(blocker, "bash-jobs"));
  const job = await startJob(session, nodeScript("setTimeout(() => {}, 30000)"));
  assert.equal(await session.openLog(job), false);
  assert.equal(job.logPath, null);
  // Logging operations stay safe no-ops without a log file.
  await session.appendLog(job, "ignored");
  await session.closeLog(job);
  await session.killAll("session ended");
});

test("the log seed keeps more than the notification tail but is bounded", async (t) => {
  const session = createSessionJobs("seed", await tempDir(t));
  await session.ensureDir();
  const job: JobRecord = {
    id: session.newJobId(),
    command: "true",
    controller: new AbortController(),
    startedAtMs: Date.now(),
    logPath: null,
    log: null,
    logBytes: 0,
    tail: new TailBuffer(),
    seed: new TailBuffer(SEED_BYTES),
    state: "running",
  };
  session.jobs.set(job.id, job);
  const marker = Buffer.from("early-compile-error\n", "utf8");
  job.seed.append(marker);
  job.tail.append(marker);
  const filler = Buffer.alloc(100 * 1024, 98); // 100KB: past the tail, within the seed
  job.seed.append(filler);
  job.tail.append(filler);
  assert.equal(await session.openLog(job), true);
  assert.equal(job.seed.bytes, 0);
  assert.equal(job.seed.raw().length, 0);
  await session.closeLog(job);
  const log = await readFile(job.logPath as string, "utf8");
  assert.ok(log.startsWith("early-compile-error"), "the seed keeps early output");
  assert.ok(log.length >= 100 * 1024);
  assert.ok(job.tail.bytes <= 16 * 1024, "the notification tail stays small");

  assert.doesNotMatch(log, /earlier output omitted/u);

  // Beyond the seed capacity, mark the missing prefix before the retained bytes.
  const huge: JobRecord = {
    ...job,
    id: session.newJobId(),
    log: null,
    logBytes: 0,
    logPath: null,
    seed: new TailBuffer(SEED_BYTES),
    tail: new TailBuffer(),
  };
  huge.seed.append(Buffer.alloc(SEED_BYTES + 1024, 99));
  assert.equal(await session.openLog(huge), true);
  assert.equal(huge.seed.bytes, 0);
  assert.equal(huge.seed.raw().length, 0);
  assert.equal(huge.logBytes, 256 * 1024, "the header is outside the raw-output budget");
  assert.equal(await session.openLog(huge), true); // Reopening must not duplicate the header.
  session.writeOutput(huge, Buffer.from("later output"));
  await session.closeLog(huge);
  assert.ok(huge.logPath);
  const truncatedLog = await readFile(huge.logPath, "utf8");
  assert.equal(
    truncatedLog,
    `[pi-background] earlier output omitted\n${"c".repeat(256 * 1024)}later output`,
  );
});

test("shutdown during log initialization never opens a late stream", async (t) => {
  const session = createSessionJobs("shutdown-open", await tempDir(t));
  const job = await startJob(session, nodeScript("setTimeout(() => {}, 30000)"));
  const gate = new EventEmitter();
  const entered = once(gate, "entered");
  const released = once(gate, "release");
  t.mock.method(session, "ensureDir", async () => {
    gate.emit("entered");
    await released;
    return session.dir;
  });
  const opening = session.openLog(job);
  await entered;
  session.shuttingDown = true;
  await session.killAll("session ended");
  gate.emit("release");
  assert.equal(await opening, false);
  assert.equal(job.log, null);
  assert.equal(job.logPath, null);
  assert.ok(job.controller.signal.aborted);
});

test("raw log output and pending writes are bounded, including the seed", async (t) => {
  const session = createSessionJobs("bounded", await tempDir(t));
  const job: JobRecord = {
    id: session.newJobId(),
    command: "chatty command",
    controller: new AbortController(),
    startedAtMs: Date.now(),
    logPath: null,
    log: null,
    logBytes: 0,
    tail: new TailBuffer(),
    seed: new TailBuffer(SEED_BYTES),
    state: "running",
  };
  job.seed.append(Buffer.from("seed\n"));
  assert.equal(await session.openLog(job), true);
  assert.ok(job.log && job.logPath);
  const chunk = Buffer.alloc(64 * 1024, 120);
  // No event-loop yield: the real write stream cannot drain these writes yet.
  for (let i = 0; i < 256; i++) session.writeOutput(job, chunk);
  assert.equal(job.logBytes, 8 * 1024 * 1024);
  assert.equal(LOG_OUTPUT_BYTES, 8 * 1024 * 1024);
  assert.ok(job.log.writableLength < 8 * 1024 * 1024 + 256);
  const queued = job.log.writableLength;
  session.writeOutput(job, Buffer.from("discarded output"));
  assert.equal(job.log.writableLength, queued);
  assert.equal(job.controller.signal.aborted, false);
  await session.appendLog(job, "\n[pi-background] completed (exit 0)\n");
  await session.closeLog(job);
  assert.equal(job.log.writableFinished, true);
  const log = await readFile(job.logPath, "utf8");
  assert.ok(log.startsWith("seed\n"));
  assert.equal(log.indexOf("\n[pi-background] output limit reached"), 8 * 1024 * 1024);
  assert.equal(log.match(/output limit reached/gu)?.length, 1);
  assert.doesNotMatch(log, /discarded output/u);
  assert.match(log, /command continues/u);
  assert.ok(log.endsWith("completed (exit 0)\n"));
});

test("killAll aborts running jobs, marks them, and appends a trailer", async (t) => {
  const session = createSessionJobs("kill", await tempDir(t));
  const job = await startJob(session, nodeScript("setTimeout(() => {}, 30000)"));
  assert.equal(await session.openLog(job), true);
  await new Promise((resolve) => setTimeout(resolve, 200));

  await session.killAll("session ended");
  assert.equal(job.state, "ended");
  assert.ok(job.controller.signal.aborted);
  const logPath = job.logPath;
  assert.ok(logPath);
  const log = await readFile(logPath, "utf8");
  assert.match(log, /\[pi-background\] job bg_[0-9a-f]{8} killed: session ended/u);
  assert.equal(session.runningCount(), 0);

  // Idempotent: a second killAll does nothing.
  await session.killAll("again");
});

test("killAll skips jobs that already settled", async (t) => {
  const session = createSessionJobs("settled", await tempDir(t));
  const job: JobRecord = {
    id: session.newJobId(),
    command: "true",
    controller: new AbortController(),
    startedAtMs: Date.now(),
    logPath: null,
    log: null,
    logBytes: 0,
    tail: new TailBuffer(),
    seed: new TailBuffer(),
    state: "ended",
  };
  session.jobs.set(job.id, job);
  await session.killAll("session ended");
  assert.equal(job.state, "ended");
  assert.ok(!job.controller.signal.aborted);
});

test("pruneOldLogs removes old logs and empty dirs but keeps recent files", async (t) => {
  const root = await tempDir(t);
  const oldDir = join(root, "old-session");
  const newDir = join(root, "new-session");
  await mkdir(oldDir, { recursive: true });
  await mkdir(newDir, { recursive: true });
  const now = Date.now();
  const oldFile = join(oldDir, "bg_old.log");
  await writeFile(oldFile, "old");
  const { utimes } = await import("node:fs/promises");
  const longAgo = new Date(now - 48 * 60 * 60 * 1000);
  await utimes(oldFile, longAgo, longAgo);
  const newFile = join(newDir, "bg_new.log");
  await writeFile(newFile, "new");

  await pruneOldLogs(root, 24 * 60 * 60 * 1000, now);
  await assert.rejects(readFile(oldFile), /ENOENT/u);
  assert.equal(await readFile(newFile, "utf8"), "new");
  await assert.rejects(readFile(join(oldDir, ".keep")), /ENOENT/u);
  // The empty old session directory is removed; the non-empty one stays.
  await assert.rejects(readFile(join(oldDir, "bg_old.log")), /ENOENT/u);
  assert.equal(await readFile(newFile, "utf8"), "new");

  // A missing root directory is not an error.
  await pruneOldLogs(join(root, "does-not-exist"));
});
