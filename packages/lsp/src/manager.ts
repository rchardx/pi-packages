import { readFile, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { type Diagnostic, type FileLocation, LspClient } from "./client.ts";
import {
  findWorkspaceRoot,
  type LspConfig,
  loadConfig,
  matchServerForFile,
  resolveServerBinary,
  type ServerDefinition,
} from "./config.ts";
import {
  displayRelativePath,
  isSubpath,
  type LspInput,
  resolveInputPath,
  singleLine,
} from "./schema.ts";

/** An edit or write result waits this long for diagnostics, server startup included. */
export const POST_EDIT_WAIT_MS = 800;
/** An explicit diagnostics query waits this long for a push server's report. */
const QUERY_PUSH_WAIT_MS = 2_000;
const MAX_POST_EDIT_DIAGNOSTICS = 20;
const MAX_QUERY_DIAGNOSTICS = 50;
const MAX_LOCATIONS = 50;
const MAX_HOVER_CHARS = 8_000;
const MAX_PREVIEW_CHARS = 160;

export interface ManagerSnapshot {
  servers: Array<{ id: string; workspaceRoot: string; openFiles: number }>;
  unavailable: string[];
}

/** A file that a language server may be asked about, or the reason none can be. */
type Target =
  | { cwd: string; filePath: string; file: string; server: ServerDefinition; root: string }
  | { unavailable: string };

/**
 * Path with symbolic links resolved. The session directory and every input path are made
 * canonical once, on entry; admission to the session directory, workspace-root lookup, and
 * document URIs then all use the same form, so a link cannot make them disagree.
 */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // Missing paths cannot be resolved; the file access that follows reports them.
    return path;
  }
}

/** Resolve with `promise`, or reject as soon as `signal` aborts; the awaited work continues. */
async function waitUnlessAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function plural(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/** Only errors and warnings are reported; informational hints are left to editors. */
function problems(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((item) => item.severity === "error" || item.severity === "warning");
}

function countProblems(items: readonly Diagnostic[]): string {
  const errors = items.filter((item) => item.severity === "error").length;
  const warnings = items.length - errors;
  return [
    errors > 0 ? plural(errors, "error") : "",
    warnings > 0 ? plural(warnings, "warning") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function diagnosticLines(file: string, items: readonly Diagnostic[], limit: number): string[] {
  const lines = items.slice(0, limit).map((item) => {
    const tag = item.code ? `${item.severity} ${item.code}` : item.severity;
    return `- ${file}:${item.line}:${item.column} [${tag}] ${singleLine(item.message)}`;
  });
  if (items.length > limit) lines.push(`- … ${items.length - limit} more not shown`);
  return lines;
}

async function locationLines(locations: readonly FileLocation[], cwd: string): Promise<string[]> {
  const fileLines = new Map<string, string[]>();
  const lines: string[] = [];
  for (const location of locations.slice(0, MAX_LOCATIONS)) {
    let source = fileLines.get(location.filePath);
    if (!source) {
      source = await readFile(location.filePath, "utf8").then(
        (text) => text.split(/\r?\n/u),
        () => [],
      );
      fileLines.set(location.filePath, source);
    }
    const preview = singleLine(source[location.line - 1] ?? "").slice(0, MAX_PREVIEW_CHARS);
    const position = `${displayRelativePath(location.filePath, cwd)}:${location.line}:${location.column}`;
    lines.push(preview ? `- ${position}  ${preview}` : `- ${position}`);
  }
  if (locations.length > MAX_LOCATIONS) {
    lines.push(`- … ${locations.length - MAX_LOCATIONS} more not shown`);
  }
  return lines;
}

/** One replaceable generation of language-server state and configuration. */
class ServerPool {
  private readonly clients = new Map<string, LspClient>();
  /** Starts in progress; they resolve to the reason when the server cannot be used. */
  private readonly starts = new Map<string, Promise<LspClient | string>>();
  /** Servers that are not installed or failed to start; not retried until `/lsp reset`. */
  private readonly unavailable = new Map<string, string>();
  /** Aborts server starts when this pool is stopped. */
  private readonly stop = new AbortController();
  private readonly envPath: string | undefined;
  private retired: Promise<void> = Promise.resolve();
  private configPromise: Promise<LspConfig> | undefined;

  constructor(envPath: string | undefined) {
    this.envPath = envPath;
  }

  getConfig(): Promise<LspConfig> {
    this.configPromise ??= loadConfig();
    return this.configPromise;
  }

  snapshot(): ManagerSnapshot {
    return {
      servers: [...this.clients.values()].map((client) => ({
        id: client.server.id,
        workspaceRoot: client.workspaceRoot,
        openFiles: client.openFileCount,
      })),
      unavailable: [...this.unavailable.values()],
    };
  }

  async close(): Promise<void> {
    // Starts that are still initializing are aborted and reaped before this returns.
    this.stop.abort();
    await Promise.allSettled(this.starts.values());
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled([...clients.map((client) => client.close()), this.retired]);
  }

  private retire(client: LspClient): void {
    this.retired = Promise.all([this.retired, client.close()]).then(() => {});
  }

  /**
   * The running server for `target`, starting it if needed, or the reason it cannot be used. A
   * start belongs to the pool, not to the caller that triggered it: an aborted caller stops
   * waiting while the server keeps starting for later calls.
   */
  clientFor(
    target: { server: ServerDefinition; root: string },
    config: LspConfig,
    signal?: AbortSignal,
  ): Promise<LspClient | string> {
    const key = `${target.server.id}\0${target.root}`;
    const reason = this.unavailable.get(key);
    if (reason) return Promise.resolve(reason);
    const existing = this.clients.get(key);
    if (existing?.isAlive) return Promise.resolve(existing);
    if (existing) {
      // The RPC channel may be dead while the process group is still running.
      this.clients.delete(key);
      this.retire(existing);
    }

    let start = this.starts.get(key);
    if (!start) {
      const launched = this.launch(key, target.server, target.root, config).finally(() => {
        this.starts.delete(key);
      });
      start = launched;
      this.starts.set(key, launched);
    }
    return waitUnlessAborted(start, signal);
  }

  private async launch(
    key: string,
    server: ServerDefinition,
    root: string,
    config: LspConfig,
  ): Promise<LspClient | string> {
    const stopped = "Language servers were stopped.";
    if (this.stop.signal.aborted) return stopped;
    const binary = await resolveServerBinary(server, root, this.envPath);
    if (!binary) {
      const tried = server.candidates.map((candidate) => candidate.command).join(", ");
      const reason = `Language server "${server.id}" is not installed (tried: ${tried}).`;
      this.unavailable.set(key, reason);
      return reason;
    }
    try {
      const client = await LspClient.start(
        {
          server,
          binary,
          workspaceRoot: root,
          requestTimeoutMs: config.requestTimeoutMs,
          onClosed: (ended) => {
            if (this.clients.get(key) === ended) {
              this.clients.delete(key);
              this.retire(ended);
            }
          },
        },
        this.stop.signal,
      );
      this.clients.set(key, client);
      return client;
    } catch (error) {
      if (this.stop.signal.aborted) return stopped;
      // A server that cannot start is not spawned again on every edit.
      const message = error instanceof Error ? error.message : String(error);
      const reason = `Language server "${server.id}" failed to start and is disabled until /lsp reset: ${message}`;
      this.unavailable.set(key, reason);
      return reason;
    }
  }
}

/** Owns the language servers of one session: one per server definition and workspace root. */
export class LspManager {
  private readonly envPath: string | undefined;
  private retired: Promise<void> = Promise.resolve();
  private pool: ServerPool;

  constructor(options?: { envPath?: string }) {
    this.envPath = options?.envPath;
    this.pool = new ServerPool(this.envPath);
  }

  /** Loads `lsp.json` once per pool; a load failure is cached and rethrown until `reset()`. */
  getConfig(): Promise<LspConfig> {
    return this.pool.getConfig();
  }

  snapshot(): ManagerSnapshot {
    return this.pool.snapshot();
  }

  /**
   * Text to append to a successful edit or write result: the file's errors and warnings, or
   * `undefined` when there are none or no report arrived within `POST_EDIT_WAIT_MS`. A check that
   * misses the deadline is dropped, never delivered later; the server keeps starting and the
   * file stays synced, so the next edit finds it ready.
   */
  async checkFileAfterEdit(
    rawPath: string,
    sessionCwd: string,
    trusted: boolean,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!trusted) return undefined;
    const pool = this.pool;
    // Configuration errors are reported once at session start or `/lsp reset`, not on every edit.
    const config = await pool.getConfig().catch(() => undefined);
    if (!config?.diagnosticsOnEdit) return undefined;

    // Not tied to the tool signal: an aborted edit must not leave the server half started.
    const check = this.diagnoseEdited(pool, rawPath, sessionCwd, config).catch(() => undefined);
    const deadline = new AbortController();
    const result = await Promise.race([
      check,
      delay(POST_EDIT_WAIT_MS, undefined, {
        signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
      }).catch(() => undefined),
    ]);
    deadline.abort();

    const found = problems(result?.diagnostics ?? []);
    if (!result || found.length === 0) return undefined;
    return [
      `LSP diagnostics (${countProblems(found)}):`,
      ...diagnosticLines(result.file, found, MAX_POST_EDIT_DIAGNOSTICS),
    ].join("\n");
  }

  /** Run a read-only query and describe the outcome as text; its first line is the summary. */
  async execute(
    input: LspInput,
    sessionCwd: string,
    trusted: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (!trusted) return "Language servers are disabled in untrusted projects.";
    const pool = this.pool;
    const config = await pool.getConfig();
    const target = await this.resolveTarget(input.path, sessionCwd, config);
    if ("unavailable" in target) return target.unavailable;
    const client = await pool.clientFor(target, config, signal);
    if (typeof client === "string") return client;
    const { cwd, filePath, file } = target;
    const id = client.server.id;

    if (input.action === "diagnostics") {
      const diagnostics = await client.diagnostics(filePath, QUERY_PUSH_WAIT_MS, { signal });
      if (!diagnostics) {
        return `${file}: ${id} sent no diagnostics for the current file contents within ${QUERY_PUSH_WAIT_MS / 1000}s.`;
      }
      const found = problems(diagnostics);
      if (found.length === 0) return `${file}: no errors or warnings reported (${id})`;
      return [
        `${file}: ${countProblems(found)} (${id})`,
        ...diagnosticLines(file, found, MAX_QUERY_DIAGNOSTICS),
      ].join("\n");
    }

    if (input.line === undefined) {
      throw new Error(`"line" is required for ${input.action}.`);
    }
    if (input.action === "hover") {
      const text = await client.hover(filePath, input.line, input.symbol, signal);
      if (!text) return `No hover information (${id})`;
      const shown =
        text.length > MAX_HOVER_CHARS ? `${text.slice(0, MAX_HOVER_CHARS)}\n… truncated` : text;
      return `${file}:${input.line} (${id})\n\n${shown}`;
    }
    const locations =
      input.action === "definition"
        ? await client.definition(filePath, input.line, input.symbol, signal)
        : await client.references(filePath, input.line, input.symbol, signal);
    if (locations.length === 0) return `No ${input.action} found (${id})`;
    return [
      `${plural(locations.length, input.action === "definition" ? "definition" : "reference")} (${id})`,
      ...(await locationLines(locations, cwd)),
    ].join("\n");
  }

  /**
   * Replace the active server pool immediately so new calls use fresh state, stop the previous
   * pool's servers, and validate `lsp.json`.
   */
  async reset(): Promise<void> {
    const previous = this.pool;
    const next = new ServerPool(this.envPath);
    this.pool = next;
    const retired = Promise.all([this.retired, previous.close()]).then(() => {});
    this.retired = retired;
    await retired;
    await next.getConfig();
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([this.pool.close(), this.retired]);
  }

  private async diagnoseEdited(
    pool: ServerPool,
    rawPath: string,
    sessionCwd: string,
    config: LspConfig,
  ): Promise<{ file: string; diagnostics: Diagnostic[] } | undefined> {
    const target = await this.resolveTarget(rawPath, sessionCwd, config);
    if ("unavailable" in target) return undefined;
    const client = await pool.clientFor(target, config);
    if (typeof client === "string") return undefined;
    const diagnostics = await client.diagnostics(target.filePath, POST_EDIT_WAIT_MS, {
      edited: true,
    });
    return diagnostics && { file: target.file, diagnostics };
  }

  private async resolveTarget(
    rawPath: string,
    sessionCwd: string,
    config: LspConfig,
  ): Promise<Target> {
    const cwd = await canonicalPath(sessionCwd);
    const filePath = await canonicalPath(resolveInputPath(rawPath, cwd));
    if (!isSubpath(cwd, filePath)) {
      return {
        unavailable: `"${filePath}" is outside the session working directory; language servers only run for files inside it.`,
      };
    }
    const file = displayRelativePath(filePath, cwd);
    const server = matchServerForFile(config, filePath);
    if (!server) return { unavailable: `No language server is configured for "${file}".` };
    const root = await findWorkspaceRoot(filePath, server.rootMarkers, cwd);
    return { cwd, filePath, file, server, root };
  }
}
