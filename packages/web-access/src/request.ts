export type WebToolKind = "search" | "fetch";

export interface HttpErrorOptions {
  label: string;
  providerLabel: string;
  tool: WebToolKind;
  reasons?: Readonly<Record<number, string>>;
}

// Built-in defaults can be retired upstream; name the model and the setting that replaces it.
export function modelNotFoundReason(tool: WebToolKind, provider: string, model: string): string {
  return `Requested model "${model}" was not found; set ${tool}.providers.${provider}.model in web-access.json to an available model.`;
}

export function httpError(status: number, options: HttpErrorOptions): Error {
  const { label, providerLabel, tool } = options;
  const defaults: Record<number, string> = {
    400: `Invalid ${tool} request.`,
    401: `Missing or invalid ${providerLabel} credentials.`,
    402: `Insufficient ${providerLabel} account balance.`,
    403: tool === "fetch" ? "Fetch denied by the security policy." : "Search access denied.",
    408: "Request timed out.",
    413: `${tool === "fetch" ? "Fetch" : "Search"} request body is too large.`,
    422: `Invalid ${tool} parameters.`,
    429: `${providerLabel} ${tool} rate limit exceeded.`,
    504: `Upstream ${tool} timed out.`,
    529: `${providerLabel} service is overloaded.`,
  };
  // Return stable, sanitized diagnostics rather than forwarding raw error bodies.
  const reason =
    options.reasons?.[status] ??
    defaults[status] ??
    (tool === "search" ? "Search request failed." : "Fetch request failed.");
  const retry =
    status === 408 || status === 429 || (status >= 500 && status < 600)
      ? " This may be transient; retry later."
      : "";
  return new Error(`${label} HTTP ${status}: ${reason}${retry}`);
}

// Only recognized codes are exposed; messages and arbitrary error properties stay private.
const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function transportError(error: unknown, message: string): Error {
  for (const candidate of [error, error instanceof Error ? error.cause : undefined]) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "code" in candidate &&
      typeof candidate.code === "string" &&
      NETWORK_ERROR_CODES.has(candidate.code)
    ) {
      return new Error(`${message} (${candidate.code}).`);
    }
  }
  return new Error(`${message}.`);
}

function openBody(
  response: Response,
  contentType: "application/json" | "text/event-stream",
  maxBytes: number,
  errorOptions: HttpErrorOptions,
) {
  const { label } = errorOptions;
  if (response.status !== 200) throw httpError(response.status, errorOptions);
  const effectiveType =
    response.headers.get("content-type") ??
    (contentType === "text/event-stream" ? "text/event-stream" : null);
  if (effectiveType?.split(";", 1)[0]?.trim().toLowerCase() !== contentType) {
    throw new Error(
      `${label} returned a ${contentType === "application/json" ? "non-JSON" : "non-event-stream"} response.`,
    );
  }
  const limitError = () =>
    new Error(`${label} response exceeds the ${maxBytes / (1024 * 1024)} MiB limit.`);
  const length = response.headers.get("content-length");
  if (length && Number(length) > maxBytes) throw limitError();
  if (!response.body) throw new Error(`${label} returned an empty response body.`);
  return { reader: response.body.getReader(), limitError };
}

async function readJsonResponse(
  response: Response,
  maxBytes: number,
  errorOptions: HttpErrorOptions,
): Promise<unknown> {
  const { label } = errorOptions;
  const { reader, limitError } = openBody(response, "application/json", maxBytes, errorOptions);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw transportError(error, `${label} response stream failed`);
      }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw limitError();
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error(`${label} returned invalid UTF-8 or JSON.`);
  }
}

export async function withDeadline<T>(
  label: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(
    () => controller.abort(new Error(`${label} timed out after ${timeoutMs / 1000} seconds.`)),
    timeoutMs,
  );
  timer.unref();
  try {
    return await run(combined);
  } catch (error) {
    // Cancellation takes precedence over transport, decoding, and output failures.
    combined.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function resolveWithSignal<T>(
  resolve: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  // Pi auth takes no signal. Race the wait; fetch owns request/body cancellation
  // through the same signal, including when credential completion races an abort.
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const resolved = resolve();
    resolved.catch(() => {});
    return await Promise.race([resolved, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export interface JsonPostOptions<TAuth> {
  endpoint: string;
  resolveAuth: () => Promise<TAuth>;
  buildRequest: (auth: TAuth) => { headers: Headers; body: object };
  signal: AbortSignal;
  maxBytes: number;
  request: typeof fetch;
  errorOptions: HttpErrorOptions;
}

async function sendPost<TAuth>(options: JsonPostOptions<TAuth>): Promise<Response> {
  const auth = await resolveWithSignal(options.resolveAuth, options.signal);
  const built = options.buildRequest(auth);
  const headers = new Headers(built.headers);
  // Authentication belongs to Pi; the JSON payload format belongs to this tool.
  headers.set("Content-Type", "application/json");
  try {
    return await options.request(options.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(built.body),
      redirect: "error",
      signal: options.signal,
    });
  } catch (error) {
    throw transportError(
      error,
      `Cannot reach ${options.errorOptions.label}; network or redirect failure`,
    );
  }
}

export async function postJson<TAuth>(options: JsonPostOptions<TAuth>): Promise<unknown> {
  return readJsonResponse(await sendPost(options), options.maxBytes, options.errorOptions);
}

export interface SsePostOptions<TAuth> extends JsonPostOptions<TAuth> {
  // Reading stops at the first terminal event; the stream must not end before one.
  isTerminal: (event: unknown) => boolean;
}

// Server-sent JSON events share the decoded-size budget and diagnostics of JSON responses.
export async function postSse<TAuth>(options: SsePostOptions<TAuth>): Promise<unknown[]> {
  const response = await sendPost(options);
  const { label } = options.errorOptions;
  const { reader, limitError } = openBody(
    response,
    "text/event-stream",
    options.maxBytes,
    options.errorOptions,
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const events: unknown[] = [];
  let buffer = "";
  let size = 0;
  // Returns true once a terminal event has been parsed.
  const parseBlocks = (final: boolean): boolean => {
    const blocks = buffer.split(/\r?\n\r?\n/u);
    buffer = final ? "" : (blocks.pop() ?? "");
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /u, ""))
        .join("\n");
      if (!data.trim() || data.trim() === "[DONE]") continue;
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        throw new Error(`${label} returned an invalid event stream.`);
      }
      events.push(event);
      if (options.isTerminal(event)) return true;
    }
    return false;
  };
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw transportError(error, `${label} response stream failed`);
      }
      if (!chunk.done) {
        size += chunk.value.byteLength;
        if (size > options.maxBytes) throw limitError();
      }
      try {
        buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new Error(`${label} returned invalid UTF-8.`);
      }
      if (parseBlocks(chunk.done)) {
        await reader.cancel().catch(() => {});
        return events;
      }
      if (chunk.done) break;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`${label} event stream ended before the response completed.`);
}
