import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResolvedBinary, ServerDefinition } from "./config.ts";
import { JsonRpcConnection, JsonRpcError } from "./jsonrpc.ts";
import { resolveSymbolColumn } from "./schema.ts";

const STDERR_TAIL_BYTES = 4 * 1024;
const SHUTDOWN_TIMEOUT_MS = 400;
/**
 * A push report without a version is accepted once no further report followed for this long:
 * servers may publish syntax and semantic results separately.
 */
const PUSH_QUIET_MS = 150;
/** LSP `FileChangeType.Changed`. */
const FILE_CHANGED = 2;
/** LSP error codes that ask the client to send a request again. */
const CONTENT_MODIFIED = -32801;
const SERVER_CANCELLED = -32802;
const RETRY_DELAY_MS = 120;
/**
 * typescript-language-server command that forwards a request to tsserver. Its push reports carry
 * no version and are skipped when nothing changed, so they cannot be matched to file contents;
 * tsserver's synchronous diagnostics answer for the contents at the time of the request.
 */
const TSSERVER_REQUEST = "typescript.tsserverRequest";

export type Severity = "error" | "warning" | "information" | "hint";

export interface Diagnostic {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  severity: Severity;
  message: string;
  code?: string;
}

export interface FileLocation {
  filePath: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

interface OpenDocument {
  uri: string;
  version: number;
  text: string;
  /** The latest report the server sent for `version`; reports for other versions are not kept. */
  report?: { version: number; versioned: boolean; diagnostics: Diagnostic[] };
}

export interface LspClientOptions {
  server: ServerDefinition;
  binary: ResolvedBinary;
  workspaceRoot: string;
  requestTimeoutMs: number;
  onClosed?: (client: LspClient) => void;
}

const SEVERITIES: readonly Severity[] = ["error", "warning", "information", "hint"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 1-based line and column of an untrusted LSP `Range` start, defaulting to 1:1. */
function rangeStart(range: unknown): { line: number; column: number } {
  const start = isRecord(range) && isRecord(range.start) ? range.start : undefined;
  return {
    line: typeof start?.line === "number" ? Math.max(1, start.line + 1) : 1,
    column: typeof start?.character === "number" ? Math.max(1, start.character + 1) : 1,
  };
}

function parseDiagnostics(items: readonly unknown[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.message !== "string" || !item.message.trim()) continue;
    const code =
      typeof item.code === "string" || typeof item.code === "number"
        ? String(item.code)
        : undefined;
    diagnostics.push({
      ...rangeStart(item.range),
      // LSP severities are 1 (error) to 4 (hint); a missing severity is treated as an error.
      severity: (typeof item.severity === "number" && SEVERITIES[item.severity - 1]) || "error",
      message: item.message.trim(),
      ...(code ? { code } : {}),
    });
  }
  return diagnostics.sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      a.line - b.line ||
      a.column - b.column,
  );
}

// tsserver diagnostic categories in LSP severity order; "suggestion" corresponds to a hint.
const TSSERVER_CATEGORIES = ["error", "warning", "message", "suggestion"];

/** Diagnostics from tsserver `*DiagnosticsSync` responses (1-based `line` and `offset`). */
function parseTsserverDiagnostics(responses: readonly unknown[]): Diagnostic[] {
  const items = responses.flatMap((response) =>
    isRecord(response) && Array.isArray(response.body) ? response.body : [],
  );
  return parseDiagnostics(
    items.filter(isRecord).map((item) => ({
      range: {
        start:
          isRecord(item.start) &&
          typeof item.start.line === "number" &&
          typeof item.start.offset === "number"
            ? { line: item.start.line - 1, character: item.start.offset - 1 }
            : undefined,
      },
      severity: TSSERVER_CATEGORIES.indexOf(String(item.category)) + 1,
      code: item.code,
      message: item.text,
    })),
  );
}

function parseLocations(raw: unknown): FileLocation[] {
  const locations: FileLocation[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : [raw]) {
    if (!isRecord(entry)) continue;
    // `Location` uses uri/range; `LocationLink` uses targetUri/targetSelectionRange.
    const uri = typeof entry.uri === "string" ? entry.uri : entry.targetUri;
    if (typeof uri !== "string" || !uri.startsWith("file:")) continue;
    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      continue;
    }
    const location = { filePath, ...rangeStart(entry.targetSelectionRange ?? entry.range) };
    const key = `${filePath}:${location.line}:${location.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push(location);
  }
  return locations;
}

function hoverText(contents: unknown): string {
  if (typeof contents === "string") return contents.trim();
  if (Array.isArray(contents)) {
    return contents.map(hoverText).filter(Boolean).join("\n\n");
  }
  if (isRecord(contents) && typeof contents.value === "string") {
    return typeof contents.language === "string"
      ? `\`\`\`${contents.language}\n${contents.value.trim()}\n\`\`\``
      : contents.value.trim();
  }
  return "";
}

/**
 * Signal the server's process group (the server is spawned as its leader) and report whether the
 * group still has members. Signal 0 only probes. Workers can outlive the server process itself.
 */
function signalProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals | 0,
): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroupExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (signalProcessGroup(child, 0)) {
    if (Date.now() >= deadline) return false;
    await delay(20);
  }
  return true;
}

/** One language server process for one workspace root. */
export class LspClient {
  readonly server: ServerDefinition;
  readonly workspaceRoot: string;

  private readonly requestTimeoutMs: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rpc: JsonRpcConnection;
  private readonly documents = new Map<string, OpenDocument>();
  /** Called when a report arrives, pull diagnostics get registered, or the server ends. */
  private readonly listeners = new Set<() => void>();
  private readonly onClosed: ((client: LspClient) => void) | undefined;

  private stderrTail = "";
  private pullDiagnostics = false;
  private tsserverDiagnostics = false;
  private includeTextOnSave = false;
  private exited = false;
  private closing: Promise<void> | undefined;

  private constructor(options: LspClientOptions, child: ChildProcessWithoutNullStreams) {
    this.server = options.server;
    this.workspaceRoot = options.workspaceRoot;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.onClosed = options.onClosed;
    this.child = child;

    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });

    const onExit = () => {
      if (this.exited) return;
      this.exited = true;
      // Workers left behind by a server that exited or crashed are not kept running.
      signalProcessGroup(child, "SIGTERM");
      const detail = this.stderrTail.trim();
      this.rpc.close(
        new Error(`Language server "${this.server.id}" exited${detail ? `: ${detail}` : ""}`),
      );
      this.notifyListeners();
      this.onClosed?.(this);
    };
    child.once("exit", onExit);
    child.once("error", onExit);

    this.rpc = new JsonRpcConnection(child.stdout, child.stdin, {
      onRequest: (method, params) => this.handleServerRequest(method, params),
      onNotification: (method, params) => this.handleServerNotification(method, params),
    });
  }

  /**
   * Startup is bounded by `requestTimeoutMs`. `signal` belongs to whoever owns the server's
   * lifetime (session shutdown), never to a single caller.
   */
  static async start(options: LspClientOptions, signal?: AbortSignal): Promise<LspClient> {
    signal?.throwIfAborted();
    const child = spawn(options.binary.command, [...options.binary.args], {
      cwd: options.workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        child.removeListener("error", reject);
        resolve();
      });
    });

    const client = new LspClient(options, child);
    try {
      await client.initialize(signal);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get isAlive(): boolean {
    return !this.exited && !this.rpc.isClosed;
  }

  get openFileCount(): number {
    return this.documents.size;
  }

  /**
   * Diagnostics for the file's current contents, or `undefined` when the server sent none for
   * them within `pushWaitMs` (push servers may stay silent when nothing changed, so silence is
   * never reported as a clean file). `edited` says the file was just written, as opposed to
   * merely being looked at.
   */
  async diagnostics(
    filePath: string,
    pushWaitMs: number,
    options?: { edited?: boolean | undefined; signal?: AbortSignal | undefined },
  ): Promise<Diagnostic[] | undefined> {
    const signal = options?.signal;
    const doc = await this.syncFile(filePath, options?.edited);
    // A server may register pull diagnostics while a push report is awaited (basedpyright
    // registers shortly after startup and then never pushes).
    for (;;) {
      if (this.pullDiagnostics) {
        const result = await this.pullDiagnosticReport(doc.uri, signal);
        // A report without items (null or "unchanged") carries no diagnostics.
        return isRecord(result) && Array.isArray(result.items)
          ? parseDiagnostics(result.items)
          : [];
      }
      if (this.tsserverDiagnostics) {
        const responses = await Promise.all(
          ["syntacticDiagnosticsSync", "semanticDiagnosticsSync"].map((command) =>
            this.request(
              "workspace/executeCommand",
              { command: TSSERVER_REQUEST, arguments: [command, { file: filePath }] },
              signal,
            ),
          ),
        );
        return parseTsserverDiagnostics(responses);
      }
      const report = await this.waitForPushReport(doc, pushWaitMs, signal);
      if (report !== "pull") return report;
    }
  }

  async definition(
    filePath: string,
    line: number,
    symbol: string | undefined,
    signal?: AbortSignal,
  ): Promise<FileLocation[]> {
    const target = await this.resolvePosition(filePath, line, symbol);
    return parseLocations(await this.request("textDocument/definition", target, signal));
  }

  async references(
    filePath: string,
    line: number,
    symbol: string | undefined,
    signal?: AbortSignal,
  ): Promise<FileLocation[]> {
    const target = await this.resolvePosition(filePath, line, symbol);
    return parseLocations(
      await this.request(
        "textDocument/references",
        { ...target, context: { includeDeclaration: true } },
        signal,
      ),
    );
  }

  async hover(
    filePath: string,
    line: number,
    symbol: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const target = await this.resolvePosition(filePath, line, symbol);
    const result = await this.request("textDocument/hover", target, signal);
    return isRecord(result) ? hoverText(result.contents) : "";
  }

  close(): Promise<void> {
    this.closing ??= this.performClose();
    return this.closing;
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.rpc.request(method, params, { signal, timeoutMs: this.requestTimeoutMs });
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    const rootUri = pathToFileURL(this.workspaceRoot).href;
    const result = await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: basename(this.workspaceRoot) || "workspace" }],
        ...(this.server.initializationOptions
          ? { initializationOptions: this.server.initializationOptions }
          : {}),
        capabilities: {
          workspace: {
            configuration: true,
            workspaceFolders: true,
            didChangeWatchedFiles: { dynamicRegistration: false },
          },
          textDocument: {
            synchronization: { didSave: true },
            publishDiagnostics: { versionSupport: true },
            diagnostic: { dynamicRegistration: true },
            definition: { linkSupport: true },
            references: {},
            hover: { contentFormat: ["markdown", "plaintext"] },
          },
        },
      },
      signal,
    );

    if (isRecord(result) && isRecord(result.capabilities)) {
      const capabilities = result.capabilities;
      this.pullDiagnostics = Boolean(capabilities.diagnosticProvider);
      const commands = isRecord(capabilities.executeCommandProvider)
        ? capabilities.executeCommandProvider.commands
        : undefined;
      this.tsserverDiagnostics = Array.isArray(commands) && commands.includes(TSSERVER_REQUEST);
      const sync = capabilities.textDocumentSync;
      this.includeTextOnSave =
        isRecord(sync) && isRecord(sync.save) && sync.save.includeText === true;
    }
    this.rpc.notify("initialized", {});
  }

  private async pullDiagnosticReport(uri: string, signal?: AbortSignal): Promise<unknown> {
    const pull = () => this.request("textDocument/diagnostic", { textDocument: { uri } }, signal);
    try {
      return await pull();
    } catch (error) {
      // Servers answer a pull that raced with a change by asking for it to be sent again.
      const retry =
        error instanceof JsonRpcError &&
        (error.code === CONTENT_MODIFIED || error.code === SERVER_CANCELLED);
      if (!retry) throw error;
      await delay(RETRY_DELAY_MS, undefined, { signal });
      return pull();
    }
  }

  /**
   * Bring the server's copy of `filePath` up to date with the disk. Other files are not touched.
   * `edited` marks a file that was just written, even if the server sees it for the first time.
   */
  private async syncFile(filePath: string, edited = false): Promise<OpenDocument> {
    if (!(await stat(filePath)).isFile()) {
      throw new Error(`"${filePath}" is not a regular file.`);
    }
    const text = await readFile(filePath, "utf8");
    const uri = pathToFileURL(filePath).href;
    let doc = this.documents.get(uri);
    if (doc?.text === text) return doc;

    // Opening a file to look at it is not a change; opening one that was just edited is. Servers
    // may have read its old contents from disk while analyzing other files, and must hear about
    // the change before the file is opened: basedpyright ignores disk changes to open files.
    if (edited || doc) {
      this.rpc.notify("workspace/didChangeWatchedFiles", {
        changes: [{ uri, type: FILE_CHANGED }],
      });
    }
    if (!doc) {
      doc = { uri, version: 1, text };
      this.documents.set(uri, doc);
      this.rpc.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.server.languageIdForPath(filePath),
          version: doc.version,
          text,
        },
      });
    } else {
      doc.version += 1;
      doc.text = text;
      this.rpc.notify("textDocument/didChange", {
        textDocument: { uri, version: doc.version },
        contentChanges: [{ text }],
      });
      this.rpc.notify("textDocument/didSave", {
        textDocument: { uri },
        ...(this.includeTextOnSave ? { text } : {}),
      });
    }
    return doc;
  }

  private async resolvePosition(
    filePath: string,
    line: number,
    symbol: string | undefined,
  ): Promise<{ textDocument: { uri: string }; position: { line: number; character: number } }> {
    const doc = await this.syncFile(filePath);
    const lines = doc.text.split(/\r?\n/u);
    const lineText = lines[line - 1];
    if (lineText === undefined) {
      throw new Error(`Line ${line} is out of range for "${filePath}" (${lines.length} lines).`);
    }
    return {
      textDocument: { uri: doc.uri },
      position: { line: line - 1, character: resolveSymbolColumn(lineText, line, symbol) },
    };
  }

  /**
   * Wait for a push report on the document's current version. Resolves `"pull"` when the server
   * registers pull diagnostics meanwhile, and `undefined` when no report arrived in time or the
   * document changed again.
   */
  private waitForPushReport(
    doc: OpenDocument,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<Diagnostic[] | "pull" | undefined> {
    signal?.throwIfAborted();
    const version = doc.version;
    const current = () => (doc.report?.version === version ? doc.report : undefined);
    return new Promise((resolve, reject) => {
      let quietTimer: NodeJS.Timeout | undefined;
      const stop = () => {
        clearTimeout(timeout);
        clearTimeout(quietTimer);
        this.listeners.delete(check);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (value: Diagnostic[] | "pull" | undefined) => {
        stop();
        resolve(value);
      };
      const fail = (error: unknown) => {
        stop();
        reject(error);
      };
      const onAbort = () => fail(signal?.reason);
      const check = () => {
        if (this.pullDiagnostics) return finish("pull");
        if (!this.isAlive) return fail(new Error(`Language server "${this.server.id}" closed.`));
        if (doc.version !== version) return finish(undefined);
        const report = current();
        if (!report) return;
        // A report that names this version is final; one without a version may be followed by more.
        if (report.versioned) return finish(report.diagnostics);
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(current()?.diagnostics), PUSH_QUIET_MS);
        quietTimer.unref();
      };
      // Neither timer keeps the process alive: a wait abandoned by its caller must not delay exit.
      const timeout = setTimeout(() => finish(undefined), waitMs);
      timeout.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.listeners.add(check);
      check();
    });
  }

  private notifyListeners(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private handleServerRequest(method: string, params: unknown): unknown {
    switch (method) {
      case "workspace/configuration":
        return isRecord(params) && Array.isArray(params.items) ? params.items.map(() => ({})) : [];
      case "workspace/workspaceFolders":
        return [
          {
            uri: pathToFileURL(this.workspaceRoot).href,
            name: basename(this.workspaceRoot) || "workspace",
          },
        ];
      case "client/registerCapability":
      case "client/unregisterCapability": {
        // The LSP specification spells the unregistration list "unregisterations".
        const list = isRecord(params) ? (params.registrations ?? params.unregisterations) : [];
        const changesPull =
          Array.isArray(list) &&
          list.some((entry) => isRecord(entry) && entry.method === "textDocument/diagnostic");
        if (changesPull) {
          this.pullDiagnostics = method === "client/registerCapability";
          this.notifyListeners();
        }
        return null;
      }
      default:
        return null;
    }
  }

  private handleServerNotification(method: string, params: unknown): void {
    if (method !== "textDocument/publishDiagnostics" || !isRecord(params)) return;
    const doc = typeof params.uri === "string" ? this.documents.get(params.uri) : undefined;
    if (!doc || !Array.isArray(params.diagnostics)) return;
    const version = typeof params.version === "number" ? params.version : undefined;
    // A report for another version of the document says nothing about the current one.
    if (version !== undefined && version !== doc.version) return;
    doc.report = {
      version: doc.version,
      versioned: version !== undefined,
      diagnostics: parseDiagnostics(params.diagnostics),
    };
    this.notifyListeners();
  }

  private async performClose(): Promise<void> {
    if (this.isAlive) {
      try {
        await this.rpc.request("shutdown", null, { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      } catch {
        // The process group is ended below regardless.
      }
      this.rpc.notify("exit");
      this.rpc.close(new Error(`Language server "${this.server.id}" closed.`));
      this.notifyListeners();
    }
    // The server exiting is not enough: its workers share the process group and must go too.
    if (await waitForProcessGroupExit(this.child, SHUTDOWN_TIMEOUT_MS)) return;
    signalProcessGroup(this.child, "SIGTERM");
    if (await waitForProcessGroupExit(this.child, SHUTDOWN_TIMEOUT_MS)) return;
    signalProcessGroup(this.child, "SIGKILL");
    await waitForProcessGroupExit(this.child, 200);
  }
}
