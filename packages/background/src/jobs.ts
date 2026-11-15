import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Raw output bytes kept in memory per job for notification tails. */
const TAIL_BYTES = 16 * 1024;
/**
 * Raw output bytes kept per job for seeding the log at backgrounding time.
 * Larger than the notification tail so early output of a chatty command
 * (for example a compile error seconds into a build) survives in the log.
 */
export const SEED_BYTES = 256 * 1024;
/** Maximum raw output persisted or queued per job; metadata is written separately. */
export const LOG_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Log files whose mtime is older than this are pruned at session start. */
export const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

export type JobState = "running" | "ended";

export interface JobRecord {
  readonly id: string;
  readonly command: string;
  /**
   * Per-job abort handle. Aborting it runs pi's built-in process-tree kill.
   * The spawning turn's abort signal is forwarded to it only while the call
   * is still in its foreground window, so backgrounded jobs survive Esc.
   */
  readonly controller: AbortController;
  readonly startedAtMs: number;
  /** Set by SessionJobs.openLog; null until the log exists, or when the agent dir is unwritable. */
  logPath: string | null;
  log: WriteStream | null;
  /** Raw output bytes admitted to the log, including its seed. */
  logBytes: number;
  /** Last 16KB of raw output, for notification tails and mid-flight previews. */
  readonly tail: TailBuffer;
  /** Last 256KB before log creation; released once the seed is written. */
  readonly seed: TailBuffer;
  state: JobState;
}

/** Bounded last-N-bytes buffer of a job's raw output. */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = false;
  private readonly capacity: number;

  constructor(capacity: number = TAIL_BYTES) {
    this.capacity = capacity;
  }

  append(data: Buffer): void {
    this.chunks.push(data);
    this.size += data.length;
    if (this.size > this.capacity) this.dropped = true;
    while (this.size > this.capacity && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (!first) break;
      const overflow = this.size - this.capacity;
      if (overflow >= first.length) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.size -= overflow;
      }
    }
  }

  get bytes(): number {
    return this.size;
  }

  get truncated(): boolean {
    return this.dropped;
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
    this.dropped = false;
  }

  raw(): Buffer {
    return Buffer.concat(this.chunks);
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function endLog(log: WriteStream): Promise<void> {
  if (log.closed || log.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    log.once("error", () => resolve());
    log.end(resolve);
  });
}

export interface SessionJobs {
  readonly sessionId: string;
  readonly dir: string;
  readonly jobs: Map<string, JobRecord>;
  shuttingDown: boolean;
  runningCount(): number;
  newJobId(): string;
  ensureDir(): Promise<string>;
  /**
   * Create the job's log file, seeded with the output so far. Logs are created
   * lazily — foreground commands never touch disk. Returns false (and the job
   * runs on with only its in-memory tail) when the agent dir is unwritable.
   */
  openLog(job: JobRecord): Promise<boolean>;
  /** Write raw output within the per-job budget without blocking the command. */
  writeOutput(job: JobRecord, data: Buffer): void;
  /** Append lifecycle metadata outside the output budget; no-op without a log. */
  appendLog(job: JobRecord, line: string): Promise<void>;
  closeLog(job: JobRecord): Promise<void>;
  /** Kill every running job's process tree and close its log. */
  killAll(reason: string): Promise<void>;
}

export function createSessionJobs(
  sessionId: string,
  rootDir = join(getAgentDir(), "bash-jobs"),
): SessionJobs {
  // Session ids are pi-generated and already name the session's own files.
  const dir = join(rootDir, sessionId);
  const jobs = new Map<string, JobRecord>();
  const state: SessionJobs = {
    sessionId,
    dir,
    jobs,
    shuttingDown: false,
    runningCount() {
      let count = 0;
      for (const job of jobs.values()) if (job.state === "running") count += 1;
      return count;
    },
    newJobId() {
      let id = "";
      do {
        id = `bg_${randomBytes(4).toString("hex")}`;
      } while (jobs.has(id));
      return id;
    },
    async ensureDir() {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    async openLog(job) {
      if (job.log) return true;
      try {
        await state.ensureDir();
      } catch {
        return false;
      }
      // Shutdown can end the job while mkdir is pending. Never open a stream
      // after its lifecycle owner has already closed it.
      if (job.state !== "running" || state.shuttingDown) return false;
      const logPath = join(dir, `${job.id}.log`);
      const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
      log.on("error", () => {}); // A log failure must not break command execution.
      job.logPath = logPath;
      job.log = log;
      if (job.seed.truncated) log.write("[pi-background] earlier output omitted\n");
      if (job.seed.bytes > 0) state.writeOutput(job, job.seed.raw());
      job.seed.clear();
      return true;
    },
    writeOutput(job, data) {
      const { log } = job;
      if (!log || log.destroyed || log.closed || !log.writable) return;
      const remaining = LOG_OUTPUT_BYTES - job.logBytes;
      if (remaining <= 0) return;
      const chunk = data.subarray(0, remaining);
      job.logBytes += chunk.length;
      // The total admitted bytes also bound the stream's pending write queue,
      // even if disk throughput never catches up with command output.
      log.write(chunk);
      if (job.logBytes === LOG_OUTPUT_BYTES) {
        log.write(
          `\n[pi-background] output limit reached (${LOG_OUTPUT_BYTES} bytes); further output omitted, command continues\n`,
        );
      }
    },
    appendLog(job, line) {
      const { log } = job;
      if (!log || log.destroyed || log.closed || !log.writable) return Promise.resolve();
      return new Promise((resolve) => {
        log.write(line, () => resolve());
      });
    },
    closeLog(job) {
      return job.log ? endLog(job.log) : Promise.resolve();
    },
    async killAll(reason) {
      const pending: Promise<unknown>[] = [];
      for (const job of jobs.values()) {
        // Mark first so the in-flight execution's settle handler skips the
        // completion notification for a job the session itself is ending.
        if (job.state !== "running") continue;
        job.state = "ended";
        job.controller.abort();
        pending.push(
          state
            .appendLog(job, `\n[pi-background] job ${job.id} killed: ${reason}\n`)
            .then(() => state.closeLog(job)),
        );
      }
      await Promise.allSettled(pending);
    },
  };
  return state;
}

/** Remove log files older than maxAgeMs and now-empty session directories. */
export async function pruneOldLogs(
  rootDir = join(getAgentDir(), "bash-jobs"),
  maxAgeMs = LOG_RETENTION_MS,
  now = Date.now(),
): Promise<void> {
  let sessionDirs: string[];
  try {
    sessionDirs = await readdir(rootDir);
  } catch {
    return; // No jobs directory yet.
  }
  for (const sessionDir of sessionDirs) {
    const dirPath = join(rootDir, sessionDir);
    let files: string[];
    try {
      if (!(await stat(dirPath)).isDirectory()) continue;
      files = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".log")) continue;
      const filePath = join(dirPath, file);
      try {
        if (now - (await stat(filePath)).mtimeMs > maxAgeMs) {
          await rm(filePath, { force: true });
        }
      } catch {
        // Best-effort cleanup only.
      }
    }
    await rmdir(dirPath).catch(() => {}); // Succeeds only when empty.
  }
}
