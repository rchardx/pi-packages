// Scriptable language server for tests: `node mock-lsp-server.mjs [mode] [delayMs]`.
//
// Diagnostics modes
//   pull             static pull diagnostics (default)
//   pull-null        pull answers alternate between null and { kind: "unchanged" }
//   pull-retry       every other pull is refused with ServerCancelled or ContentModified
//   pull-busy        every pull is refused with ServerCancelled
//   pull-disk-cache  like pyright: other files are read from a disk snapshot that only
//                    workspace/didChangeWatchedFiles refreshes
//   pull-slow-init   answers initialize after delayMs
//   late-pull        like basedpyright: registers pull diagnostics after startup, never pushes
//   push             publishes without a version after delayMs (default 15)
//   push-versioned   publishes with the document version
//   push-dedupe      like typescript-language-server: an unchanged empty report is not republished
//   push-two-wave    an empty syntax report, then the full report 80ms later
//   push-stale       the report for this version, then a late empty one for the previous version
//   silent           never publishes
//   tsserver         like typescript-language-server: answers tsserver's synchronous diagnostics
//                    through an executeCommand, and pushes an unversioned report for the
//                    PREVIOUS contents after every change
// Lifecycle modes
//   hang-on-initialize, corrupt-after-init, hang-on-shutdown
import { spawn } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const mode = process.argv[2] ?? "pull";
const delayMs = Number(process.argv[3] ?? 15);
const pullModes = [
  "pull",
  "pull-null",
  "pull-retry",
  "pull-busy",
  "pull-disk-cache",
  "pull-slow-init",
  "corrupt-after-init",
  "hang-on-shutdown",
];
const pushes = mode.startsWith("push");

if (process.env.MOCK_LSP_PID_FILE) {
  appendFileSync(process.env.MOCK_LSP_PID_FILE, `${process.pid}\n`);
}
if (process.env.MOCK_LSP_GRANDCHILD_PID_FILE) {
  // A worker in the server's process group that outlives the server unless the group is ended.
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000);"], {
    stdio: "ignore",
  });
  writeFileSync(process.env.MOCK_LSP_GRANDCHILD_PID_FILE, String(worker.pid));
}
if (mode === "hang-on-shutdown") {
  process.on("SIGTERM", () => {});
}

const docs = new Map();
const lastPublishedEmpty = new Map();
const diskCache = new Map();
let nextRequestId = 1000;
let pullCount = 0;

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function peerResolved() {
  if (mode !== "pull-disk-cache") {
    return [...docs.values()].some((text) => text.includes("PEER_OK"));
  }
  if (diskCache.size === 0) {
    for (const name of readdirSync(process.cwd())) {
      if (name.endsWith(".ts")) {
        const filePath = join(process.cwd(), name);
        diskCache.set(pathToFileURL(filePath).href, readFileSync(filePath, "utf8"));
      }
    }
  }
  return [...diskCache.values()].some((text) => text.includes("PEER_OK"));
}

// Markers in the text produce diagnostics: TYPE_ERROR, UNUSED_WARN, HINT_ONLY (per line), and
// NEEDS_PEER (an error until another document contains PEER_OK).
function diagnose(text) {
  const diagnostics = [];
  const add = (line, character, severity, code, message) =>
    diagnostics.push({
      range: { start: { line, character }, end: { line, character: character + 5 } },
      severity,
      code,
      source: "mock",
      message,
    });
  for (const [line, lineText] of text.split(/\r?\n/u).entries()) {
    const marks = [
      ["TYPE_ERROR", 1, "TS2322", "Type 'string' is not assignable to type 'number'."],
      ["UNUSED_WARN", 2, "TS6133", "Declared symbol is never read."],
      ["HINT_ONLY", 4, "TS80001", "File is a CommonJS module."],
      ["POSITIONLESS", 1, "TS9999", "No position."],
    ];
    for (const [mark, severity, code, message] of marks) {
      const index = lineText.indexOf(mark);
      if (index !== -1) add(line, index, severity, code, message);
    }
    const peer = lineText.indexOf("NEEDS_PEER");
    if (peer !== -1 && !peerResolved()) {
      add(line, peer, 1, "TS2305", "Module has no exported member 'peer'.");
    }
  }
  return diagnostics;
}

function publish(uri, diagnostics, version) {
  send({
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics, ...(version === undefined ? {} : { version }) },
  });
}

function documentChanged(uri, version, text) {
  if (mode === "tsserver" && docs.has(uri)) {
    const stale = diagnose(docs.get(uri));
    setTimeout(() => publish(uri, stale), 10);
  }
  docs.set(uri, text);
  if (!pushes) return;
  const full = diagnose(text);
  if (mode === "push-versioned") {
    setTimeout(() => publish(uri, full, version), delayMs);
  } else if (mode === "push-two-wave") {
    setTimeout(() => publish(uri, []), 10);
    setTimeout(() => publish(uri, full), 90);
  } else if (mode === "push-stale") {
    setTimeout(() => publish(uri, full, version), 10);
    if (version > 1) setTimeout(() => publish(uri, [], version - 1), 40);
  } else {
    const empty = full.length === 0;
    if (mode === "push-dedupe" && empty && lastPublishedEmpty.get(uri)) return;
    lastPublishedEmpty.set(uri, empty);
    setTimeout(() => publish(uri, full), delayMs);
  }
}

function handle(message) {
  const { id, method, params } = message;
  const reply = (result) => send({ id, result });
  switch (method) {
    case "initialize": {
      if (mode === "hang-on-initialize") return;
      const capabilities = {
        textDocumentSync: { openClose: true, change: 1, save: { includeText: true } },
        definitionProvider: true,
        referencesProvider: true,
        hoverProvider: true,
        ...(pullModes.includes(mode) ? { diagnosticProvider: {} } : {}),
        ...(mode === "tsserver"
          ? { executeCommandProvider: { commands: ["typescript.tsserverRequest"] } }
          : {}),
      };
      setTimeout(() => reply({ capabilities }), mode === "pull-slow-init" ? delayMs : 0);
      return;
    }
    case "initialized":
      if (mode === "corrupt-after-init") {
        // Break the RPC channel with an invalid frame while the process keeps running.
        setTimeout(() => process.stdout.write("Content-Length: 5\r\n\r\n{bad}"), 100);
        setInterval(() => {}, 10_000);
      }
      if (mode === "late-pull") {
        setTimeout(() => {
          send({
            id: nextRequestId++,
            method: "client/registerCapability",
            params: { registrations: [{ id: "diagnostics", method: "textDocument/diagnostic" }] },
          });
        }, 150);
      }
      return;
    case "shutdown":
      if (mode !== "hang-on-shutdown") reply(null);
      return;
    case "exit":
      if (mode !== "hang-on-shutdown") process.exit(0);
      return;
    case "textDocument/didOpen":
      documentChanged(
        params.textDocument.uri,
        params.textDocument.version,
        params.textDocument.text,
      );
      return;
    case "textDocument/didChange":
      documentChanged(
        params.textDocument.uri,
        params.textDocument.version,
        params.contentChanges[0].text,
      );
      return;
    case "workspace/didChangeWatchedFiles":
      if (process.env.MOCK_LSP_WATCHED_LOG) {
        appendFileSync(process.env.MOCK_LSP_WATCHED_LOG, `${params.changes.length}\n`);
      }
      for (const change of params.changes) {
        // Like basedpyright, disk changes to a file that is already open are ignored.
        if (docs.has(change.uri)) continue;
        diskCache.set(change.uri, readFileSync(fileURLToPath(change.uri), "utf8"));
      }
      return;
    case "textDocument/diagnostic": {
      if (!pullModes.includes(mode) && mode !== "late-pull") {
        send({ id, error: { code: -32601, message: "Unhandled method" } });
      } else if (mode === "pull-busy" || (mode === "pull-retry" && pullCount++ % 2 === 0)) {
        const code = mode === "pull-busy" || pullCount % 4 === 1 ? -32802 : -32801;
        send({ id, error: { code, message: "try again" } });
      } else if (mode === "pull-null") {
        reply(pullCount++ % 2 === 0 ? null : { kind: "unchanged" });
      } else {
        reply({ kind: "full", items: diagnose(docs.get(params.textDocument.uri) ?? "") });
      }
      return;
    }
    case "workspace/executeCommand": {
      // tsserver's format: 1-based line and offset, category names, numeric codes.
      const [command, { file }] = params.arguments;
      // POSITIONLESS produces a diagnostic without a start, as a malformed response would.
      const all = diagnose(docs.get(pathToFileURL(file).href) ?? "").map((item) => ({
        start:
          item.code === "TS9999"
            ? {}
            : { line: item.range.start.line + 1, offset: item.range.start.character + 1 },
        text: item.message,
        code: Number(item.code.slice(2)),
        category: ["error", "warning", "message", "suggestion"][item.severity - 1],
      }));
      // Warnings stand in for syntax errors so that both requests contribute.
      const syntactic = command === "syntacticDiagnosticsSync";
      reply({ body: all.filter((item) => (item.category === "warning") === syntactic) });
      return;
    }
    case "textDocument/definition": {
      // A LocationLink to line 1 of the same file, at the requested column.
      const { character } = params.position;
      const range = { start: { line: 0, character }, end: { line: 0, character: character + 5 } };
      reply([
        { targetUri: params.textDocument.uri, targetRange: range, targetSelectionRange: range },
      ]);
      return;
    }
    case "textDocument/references": {
      const at = (line, character) => ({
        uri: params.textDocument.uri,
        range: { start: { line, character }, end: { line, character: character + 5 } },
      });
      reply([at(0, 16), at(1, 13)]);
      return;
    }
    case "textDocument/hover":
      reply({
        contents: {
          kind: "markdown",
          value: `\`\`\`ts\nfunction greet(col_${params.position.character}: number): string\n\`\`\`\nGreets caller.`,
        },
      });
      return;
    default:
      if (id !== undefined && method) {
        send({ id, error: { code: -32601, message: "Unhandled method" } });
      }
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const length = Number(/content-length:\s*(\d+)/iu.exec(buffer.subarray(0, headerEnd))?.[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length));
    buffer = buffer.subarray(headerEnd + 4 + length);
    if (message.method) handle(message);
  }
});
