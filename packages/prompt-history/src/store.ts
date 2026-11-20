import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const HISTORY_DIR_NAME = "prompt-history";
export const HISTORY_VERSION = 1;
export const MAX_HISTORY_ENTRIES = 100;
export const MAX_ENTRY_BYTES = 256 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const ENTRY_FILE_PATTERN = /^(\d{15})-[0-9a-f]{12}\.json$/u;
const MAX_ENTRY_SEQ = 999_999_999_999_999;
const TMP_FILE_PREFIX = ".tmp-";
const OWN_TMP_FILE_PATTERN =
  /^\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STALE_TMP_MS = 60_000;

export interface StoreOptions {
  rootDir?: string | undefined;
}

export type ReadHistoryResult =
  | { status: "ok"; dirPath: string; entries: string[] }
  | { status: "corrupt"; path: string; message: string }
  | { status: "io_error"; path: string; message: string };

export type AppendHistoryResult =
  | { status: "saved" }
  | { status: "deduplicated" }
  | { status: "ignored_blank" }
  | { status: "skipped_oversized"; byteLength: number; maxBytes: number }
  | { status: "corrupt"; path: string; message: string }
  | { status: "io_error"; path: string; message: string }
  | { status: "prune_error"; path: string; message: string };

interface ScannedEntry {
  name: string;
  filePath: string;
  seq: number;
  size: number;
  text: string;
}

type ScanResult =
  | { status: "ok"; entries: ScannedEntry[]; tmpFiles: string[] }
  | { status: "corrupt"; path: string; message: string }
  | { status: "io_error"; path: string; message: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function defaultHistoryDir(): string {
  return join(getAgentDir(), HISTORY_DIR_NAME);
}

export function normalizeHistoryCwd(cwd: string): string {
  return resolve(cwd);
}

function cwdHash(normalizedCwd: string): string {
  return createHash("sha256").update(normalizedCwd, "utf8").digest("hex");
}

export function historyCwdDir(cwd: string, rootDir = defaultHistoryDir()): string {
  return join(rootDir, cwdHash(normalizeHistoryCwd(cwd)));
}

function formatEntryFileName(seq: number): string {
  const clamped = Math.min(Math.max(0, Math.trunc(seq)), MAX_ENTRY_SEQ);
  return `${String(clamped).padStart(15, "0")}-${randomBytes(6).toString("hex")}.json`;
}

type ReadSingleEntryResult =
  | { status: "ok"; size: number; text: string }
  | { status: "missing" }
  | { status: "corrupt"; path: string; message: string }
  | { status: "io_error"; path: string; message: string };

async function readEntryFile(
  normalizedCwd: string,
  filePath: string,
): Promise<ReadSingleEntryResult> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return { status: "missing" };
    }
    if (code === "EISDIR") {
      return { status: "corrupt", path: filePath, message: "History entry is not a regular file." };
    }
    return { status: "io_error", path: filePath, message: errorMessage(error) };
  }

  let raw: string;
  let size: number;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return { status: "corrupt", path: filePath, message: "History entry is not a regular file." };
    }
    if (stats.size > MAX_FILE_BYTES) {
      return {
        status: "corrupt",
        path: filePath,
        message: `History entry file exceeds ${MAX_FILE_BYTES} bytes (${stats.size} bytes).`,
      };
    }
    size = stats.size;
    raw = await handle.readFile("utf8");
  } catch (error) {
    return { status: "io_error", path: filePath, message: errorMessage(error) };
  } finally {
    await handle.close();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: "corrupt", path: filePath, message: `Invalid JSON: ${errorMessage(error)}` };
  }

  if (!isPlainRecord(parsed)) {
    return { status: "corrupt", path: filePath, message: "Expected top-level JSON object." };
  }
  if (parsed.version !== HISTORY_VERSION) {
    return {
      status: "corrupt",
      path: filePath,
      message: `Unsupported history version: ${String(parsed.version)}.`,
    };
  }
  if (parsed.cwd !== normalizedCwd) {
    return {
      status: "corrupt",
      path: filePath,
      message: "Stored cwd does not match target working directory.",
    };
  }
  if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
    return {
      status: "corrupt",
      path: filePath,
      message: "History entry text must be a non-blank string.",
    };
  }
  if (Buffer.byteLength(parsed.text, "utf8") > MAX_ENTRY_BYTES) {
    return {
      status: "corrupt",
      path: filePath,
      message: `History entry exceeds ${MAX_ENTRY_BYTES} bytes.`,
    };
  }

  return { status: "ok", size, text: parsed.text };
}

async function scanHistoryDir(
  normalizedCwd: string,
  dirPath: string,
  knownByName?: ReadonlyMap<string, ScannedEntry>,
): Promise<ScanResult> {
  let names: string[];
  try {
    names = await readdir(dirPath);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return { status: "ok", entries: [], tmpFiles: [] };
    }
    if (code === "ENOTDIR") {
      const targetStats = await stat(dirPath).catch(() => null);
      if (targetStats && !targetStats.isDirectory()) {
        return { status: "corrupt", path: dirPath, message: "History path is not a directory." };
      }
    }
    return { status: "io_error", path: dirPath, message: errorMessage(error) };
  }

  names.sort();
  const entries: ScannedEntry[] = [];
  const tmpFiles: string[] = [];

  for (const name of names) {
    const filePath = join(dirPath, name);
    if (OWN_TMP_FILE_PATTERN.test(name)) {
      tmpFiles.push(filePath);
      continue;
    }

    const match = ENTRY_FILE_PATTERN.exec(name);
    if (!match?.[1]) {
      // Ignore unrelated files (such as .DS_Store) without reading or deleting them.
      continue;
    }

    const known = knownByName?.get(name);
    if (known) {
      entries.push(known);
      continue;
    }

    const loaded = await readEntryFile(normalizedCwd, filePath);
    if (loaded.status === "missing") {
      continue;
    }
    if (loaded.status !== "ok") {
      return loaded;
    }

    entries.push({
      name,
      filePath,
      seq: Number(match[1]),
      size: loaded.size,
      text: loaded.text,
    });
  }

  return { status: "ok", entries, tmpFiles };
}

function selectRetainedWindow(entries: readonly ScannedEntry[]): {
  retainedTexts: string[];
  obsoletePaths: string[];
} {
  const keptReverse: string[] = [];
  const obsoletePaths: string[] = [];
  let keptBytes = 0;
  let evicting = false;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry) continue;

    if (evicting) {
      obsoletePaths.push(entry.filePath);
      continue;
    }

    if (
      keptReverse.length >= MAX_HISTORY_ENTRIES ||
      (keptReverse.length > 0 && keptBytes + entry.size > MAX_FILE_BYTES)
    ) {
      evicting = true;
      obsoletePaths.push(entry.filePath);
      continue;
    }

    keptReverse.push(entry.text);
    keptBytes += entry.size;
  }

  keptReverse.reverse();
  return { retainedTexts: keptReverse, obsoletePaths };
}

function collapseConsecutiveDuplicates(texts: readonly string[]): string[] {
  const collapsed: string[] = [];
  for (const text of texts) {
    if (collapsed.at(-1) !== text) {
      collapsed.push(text);
    }
  }
  return collapsed;
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
}

async function cleanupStaleTmpFiles(tmpFiles: readonly string[]): Promise<void> {
  const now = Date.now();
  await Promise.all(
    tmpFiles.map(async (tmpPath) => {
      try {
        const stats = await stat(tmpPath);
        if (now - stats.mtimeMs > STALE_TMP_MS) {
          await unlink(tmpPath);
        }
      } catch {
        // Ignore concurrent completion or removal.
      }
    }),
  );
}

async function writeEntryAtomically(
  dirPath: string,
  entryPath: string,
  content: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmpPath = join(dirPath, `${TMP_FILE_PREFIX}${process.pid}-${randomUUID()}`);
    try {
      await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(tmpPath, entryPath);
      return;
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => {});
      if (attempt === 0 && errorCode(error) === "ENOENT") {
        // Another writer pruned our aged temp file while this process was paused; retry once.
        continue;
      }
      throw error;
    }
  }
}

export async function readHistory(cwd: string, options?: StoreOptions): Promise<ReadHistoryResult> {
  const normalizedCwd = normalizeHistoryCwd(cwd);
  const rootDir = options?.rootDir ?? defaultHistoryDir();
  const dirPath = join(rootDir, cwdHash(normalizedCwd));
  const scanned = await scanHistoryDir(normalizedCwd, dirPath);
  if (scanned.status !== "ok") {
    return scanned;
  }
  const { retainedTexts } = selectRetainedWindow(scanned.entries);
  return { status: "ok", dirPath, entries: collapseConsecutiveDuplicates(retainedTexts) };
}

export async function appendHistoryEntry(
  cwd: string,
  text: string,
  options?: StoreOptions,
): Promise<AppendHistoryResult> {
  if (text.trim().length === 0) {
    return { status: "ignored_blank" };
  }

  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > MAX_ENTRY_BYTES) {
    return { status: "skipped_oversized", byteLength, maxBytes: MAX_ENTRY_BYTES };
  }

  const normalizedCwd = normalizeHistoryCwd(cwd);
  const rootDir = options?.rootDir ?? defaultHistoryDir();
  const dirPath = join(rootDir, cwdHash(normalizedCwd));

  try {
    return await withFileMutationQueue(dirPath, async () => {
      const before = await scanHistoryDir(normalizedCwd, dirPath);
      if (before.status !== "ok") {
        return before;
      }

      if (before.entries.at(-1)?.text === text) {
        return { status: "deduplicated" };
      }

      await mkdir(rootDir, { recursive: true, mode: 0o700 });
      await mkdir(dirPath, { recursive: true, mode: 0o700 });

      const nextSeq = Math.max(Date.now(), (before.entries.at(-1)?.seq ?? 0) + 1);
      const entryName = formatEntryFileName(nextSeq);
      const entryPath = join(dirPath, entryName);
      const serialized = `${JSON.stringify({ version: HISTORY_VERSION, cwd: normalizedCwd, text })}\n`;

      await writeEntryAtomically(dirPath, entryPath, serialized);

      const knownByName = new Map<string, ScannedEntry>(
        before.entries.map((entry) => [entry.name, entry]),
      );
      knownByName.set(entryName, {
        name: entryName,
        filePath: entryPath,
        seq: Math.min(nextSeq, MAX_ENTRY_SEQ),
        size: Buffer.byteLength(serialized, "utf8"),
        text,
      });

      const after = await scanHistoryDir(normalizedCwd, dirPath, knownByName);
      if (after.status === "corrupt") {
        return after;
      }
      if (after.status === "io_error") {
        return { status: "prune_error", path: after.path, message: after.message };
      }

      const { obsoletePaths } = selectRetainedWindow(after.entries);
      let pruneFailureMessage: string | undefined;
      if (obsoletePaths.length > 0) {
        const pruneResults = await Promise.allSettled(obsoletePaths.map(unlinkIfPresent));
        const failed = pruneResults.find(
          (item): item is PromiseRejectedResult => item.status === "rejected",
        );
        if (failed) {
          pruneFailureMessage = errorMessage(failed.reason);
        }
      }
      if (after.tmpFiles.length > 0) {
        await cleanupStaleTmpFiles(after.tmpFiles);
      }

      if (pruneFailureMessage !== undefined) {
        return { status: "prune_error", path: dirPath, message: pruneFailureMessage };
      }

      return { status: "saved" };
    });
  } catch (error) {
    return { status: "io_error", path: dirPath, message: errorMessage(error) };
  }
}
