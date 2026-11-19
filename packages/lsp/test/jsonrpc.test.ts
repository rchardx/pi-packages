import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  encodeJsonRpcFrame,
  JsonRpcConnection,
  JsonRpcError,
  MAX_FRAME_BYTES,
} from "../src/jsonrpc.ts";

/** Minimal raw JSON-RPC peer standing in for a language server. */
function rawPeer(input: PassThrough, output: PassThrough) {
  const messages: Array<Record<string, unknown>> = [];
  const listeners = new Set<() => void>();
  let buffer = Buffer.alloc(0);
  input.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const sep = buffer.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const length = Number(
        /Content-Length: (\d+)/iu.exec(buffer.subarray(0, sep).toString())?.[1],
      );
      if (buffer.length < sep + 4 + length) return;
      messages.push(JSON.parse(buffer.subarray(sep + 4, sep + 4 + length).toString("utf8")));
      buffer = buffer.subarray(sep + 4 + length);
      for (const listener of listeners) listener();
    }
  });
  return {
    messages,
    send(message: Record<string, unknown>) {
      output.write(encodeJsonRpcFrame(message));
    },
    async next(predicate: (message: Record<string, unknown>) => boolean) {
      for (;;) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise<void>((resolve) => {
          const listener = () => {
            listeners.delete(listener);
            resolve();
          };
          listeners.add(listener);
        });
      }
    },
  };
}

test("JsonRpcConnection parses split UTF-8 byte chunks, coalesced frames, bidirectional RPC, and cancel/timeout", async () => {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const server = rawPeer(clientOut, clientIn);

  let serverToClientReqSeen = false;
  const clientNotifications: Array<{ method: string; params: unknown }> = [];
  const clientConn = new JsonRpcConnection(clientIn, clientOut, {
    onRequest(method) {
      if (method === "workspace/configuration") {
        serverToClientReqSeen = true;
        return [{ strict: true }];
      }
      return null;
    },
    onNotification(method, params) {
      clientNotifications.push({ method, params });
    },
  });

  // 1. Multibyte UTF-8 frame fed 3 bytes at a time alongside a second coalesced frame
  const manualRead = new PassThrough();
  const manualWrite = new PassThrough();
  const received: unknown[] = [];
  const manualConn = new JsonRpcConnection(manualRead, manualWrite, {
    onRequest: () => null,
    onNotification(_method, params) {
      received.push(params);
    },
  });
  const frame1 = encodeJsonRpcFrame({
    jsonrpc: "2.0",
    method: "note",
    params: { text: "中文👩‍💻诊断" },
  });
  const frame2 = encodeJsonRpcFrame({
    jsonrpc: "2.0",
    method: "note",
    params: { text: "second" },
  });
  const combined = Buffer.concat([frame1, frame2]);
  for (let offset = 0; offset < combined.length; offset += 3) {
    manualRead.write(combined.subarray(offset, offset + 3));
  }
  assert.deepEqual(received, [{ text: "中文👩‍💻诊断" }, { text: "second" }]);
  manualConn.close();

  // 2. Client round-trip & structured JsonRpcError
  const echoPromise = clientConn.request("echo", { symbol: "αβγ" });
  const echoReq = await server.next((m) => m.method === "echo");
  server.send({ jsonrpc: "2.0", id: echoReq.id, result: echoReq.params });
  assert.deepEqual(await echoPromise, { symbol: "αβγ" });

  const failPromise = clientConn.request("fail");
  const failReq = await server.next((m) => m.method === "fail");
  server.send({
    jsonrpc: "2.0",
    id: failReq.id,
    error: { code: -32601, message: "No such method" },
  });
  await assert.rejects(
    failPromise,
    (err: unknown) => err instanceof JsonRpcError && err.code === -32601,
  );

  // 3. Server -> client request is answered from onRequest
  server.send({
    jsonrpc: "2.0",
    id: 99,
    method: "workspace/configuration",
    params: { items: [{}] },
  });
  const cfg = await server.next((m) => m.id === 99 && m.method === undefined);
  assert.equal(serverToClientReqSeen, true);
  assert.deepEqual(cfg.result, [{ strict: true }]);

  server.send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri: "file:///a.ts", diagnostics: [] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clientNotifications.length, 1);

  // 4. AbortSignal and timeout both emit $/cancelRequest for requests the server never answers
  const controller = new AbortController();
  const abortedPromise = clientConn.request("slow", {}, { signal: controller.signal });
  controller.abort(new Error("user pressed Esc"));
  await assert.rejects(abortedPromise, /user pressed Esc/u);

  // Request timers are unref'd by design; hold the event loop open while waiting for one to fire.
  const keepAlive = setTimeout(() => {}, 1_000);
  await assert.rejects(clientConn.request("slow", {}, { timeoutMs: 30 }), /timed out after 30ms/u);
  clearTimeout(keepAlive);
  await new Promise((resolve) => setImmediate(resolve));
  const cancelCount = server.messages.filter((m) => m.method === "$/cancelRequest").length;
  assert.equal(cancelCount, 2);

  clientConn.close();
});

test("JsonRpcConnection fails closed on oversized frames and malformed headers", async () => {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const conn = new JsonRpcConnection(readable, writable, {
    onRequest: () => null,
    onNotification: () => {},
  });

  const pending = conn.request("initialize", {});
  readable.write(`Content-Length: ${MAX_FRAME_BYTES + 1}\r\n\r\n{}`);

  await assert.rejects(pending, /exceeds .* byte limit/u);
  assert.equal(conn.isClosed, true);
});
