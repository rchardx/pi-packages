import type { Readable, Writable } from "node:stream";

export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export interface JsonRpcHandlers {
  onRequest: (method: string, params: unknown) => unknown;
  onNotification: (method: string, params: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseContentLength(headerBlock: string): number {
  let contentLength: number | undefined;
  for (const rawLine of headerBlock.split("\r\n")) {
    const colon = rawLine.indexOf(":");
    if (colon === -1) continue;
    const name = rawLine.slice(0, colon).trim().toLowerCase();
    const value = rawLine.slice(colon + 1).trim();
    if (name === "content-length") {
      if (!/^\d+$/u.test(value)) {
        throw new Error(`Invalid Content-Length header: "${rawLine}".`);
      }
      contentLength = Number.parseInt(value, 10);
    }
  }
  if (contentLength === undefined) {
    throw new Error("Missing Content-Length header in JSON-RPC frame.");
  }
  if (contentLength > MAX_FRAME_BYTES) {
    throw new Error(
      `JSON-RPC frame length ${contentLength} exceeds ${MAX_FRAME_BYTES} byte limit.`,
    );
  }
  return contentLength;
}

export function encodeJsonRpcFrame(payload: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

export class JsonRpcConnection {
  private readonly readable: Readable;
  private readonly writable: Writable;
  private readonly handlers: JsonRpcHandlers;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer: Buffer = Buffer.alloc(0);
  private expectedBytes: number | undefined;
  private nextId = 1;
  private closed = false;
  private closeReason: Error | undefined;

  constructor(readable: Readable, writable: Writable, handlers: JsonRpcHandlers) {
    this.readable = readable;
    this.writable = writable;
    this.handlers = handlers;

    this.readable.on("data", (chunk: Buffer) => {
      this.onData(chunk);
    });
    this.readable.on("error", (err: Error) => {
      this.failConnection(err);
    });
    this.readable.on("close", () => {
      this.failConnection(new Error("LSP transport closed."));
    });
    this.writable.on("error", (err: Error) => {
      this.failConnection(err);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.writeFrame(message);
  }

  request(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal | undefined; timeoutMs?: number },
  ): Promise<unknown> {
    options?.signal?.throwIfAborted();
    if (this.closed) {
      return Promise.reject(this.closeReason ?? new Error("LSP connection is closed."));
    }

    const id = this.nextId++;
    const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;

      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        cleanup();
        this.notify("$/cancelRequest", { id });
        const reason: unknown = options?.signal?.reason;
        reject(
          reason instanceof Error
            ? reason
            : new DOMException("The operation was aborted.", "AbortError"),
        );
      };

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        options?.signal?.removeEventListener("abort", onAbort);
      };

      if (options?.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          cleanup();
          this.notify("$/cancelRequest", { id });
          reject(new Error(`LSP request "${method}" timed out after ${options.timeoutMs}ms.`));
        }, options.timeoutMs);
        timer.unref();
      }

      options?.signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, { method, resolve, reject, cleanup });
      this.writeFrame(message);
    });
  }

  close(reason = new Error("LSP connection closed.")): void {
    this.failConnection(reason);
  }

  private writeFrame(payload: Record<string, unknown>): void {
    if (this.closed) return;
    this.writable.write(encodeJsonRpcFrame(payload));
  }

  private onData(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    try {
      for (;;) {
        if (this.expectedBytes === undefined) {
          const sepIndex = this.buffer.indexOf(HEADER_SEPARATOR);
          if (sepIndex === -1) {
            if (this.buffer.length > MAX_HEADER_BYTES) {
              throw new Error(`JSON-RPC header exceeded ${MAX_HEADER_BYTES} bytes.`);
            }
            return;
          }
          const headerText = this.buffer.subarray(0, sepIndex).toString("ascii");
          this.expectedBytes = parseContentLength(headerText);
          this.buffer = this.buffer.subarray(sepIndex + HEADER_SEPARATOR.length);
        }

        if (this.buffer.length < this.expectedBytes) {
          return;
        }

        const bodyBytes = this.buffer.subarray(0, this.expectedBytes);
        this.buffer = this.buffer.subarray(this.expectedBytes);
        this.expectedBytes = undefined;

        const parsed: unknown = JSON.parse(bodyBytes.toString("utf8"));
        if (!isRecord(parsed)) {
          throw new Error("JSON-RPC frame body must be a JSON object.");
        }
        this.dispatchMessage(parsed);
      }
    } catch (error) {
      this.failConnection(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private dispatchMessage(msg: Record<string, unknown>): void {
    const rawId = msg.id;
    const method = typeof msg.method === "string" ? msg.method : undefined;

    // Server -> client request
    if (method !== undefined && (typeof rawId === "number" || typeof rawId === "string")) {
      this.handleServerRequest(rawId, method, msg.params);
      return;
    }

    // Server -> client notification
    if (method !== undefined && (rawId === undefined || rawId === null)) {
      this.handlers.onNotification(method, msg.params);
      return;
    }

    // Response to client request
    if (typeof rawId === "number") {
      const entry = this.pending.get(rawId);
      if (!entry) return;
      this.pending.delete(rawId);
      entry.cleanup();
      if (isRecord(msg.error)) {
        const code = typeof msg.error.code === "number" ? msg.error.code : -32603;
        const text =
          typeof msg.error.message === "string"
            ? msg.error.message
            : `LSP error (${code}) on ${entry.method}`;
        entry.reject(new JsonRpcError(code, text, msg.error.data));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const result = this.handlers.onRequest(method, params);
    this.writeFrame({ jsonrpc: "2.0", id, result: result ?? null });
  }

  private failConnection(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = error;
    this.buffer = Buffer.alloc(0);

    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      entry.cleanup();
      entry.reject(error);
    }

    this.readable.destroy();
    this.writable.end();
  }
}
