export type WebToolKind = "search" | "fetch";

export interface HttpErrorOptions {
  label: string;
  providerLabel: string;
  tool: WebToolKind;
  reasons?: Readonly<Record<number, string>>;
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

function openBody(response: Response, maxBytes: number, errorOptions: HttpErrorOptions) {
  const { label } = errorOptions;
  if (response.status !== 200) throw httpError(response.status, errorOptions);
  const effectiveType = response.headers.get("content-type");
  if (effectiveType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new Error(`${label} returned a non-JSON response.`);
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
  const { reader, limitError } = openBody(response, maxBytes, errorOptions);
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

export interface JsonPostOptions {
  endpoint: string;
  resolveHeaders: () => Headers;
  body: object;
  signal: AbortSignal;
  maxBytes: number;
  request: typeof fetch;
  errorOptions: HttpErrorOptions;
}

async function sendPost(options: JsonPostOptions): Promise<Response> {
  options.signal.throwIfAborted();
  const headers = new Headers(options.resolveHeaders());
  headers.set("Content-Type", "application/json");
  try {
    return await options.request(options.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(options.body),
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

export async function postJson(options: JsonPostOptions): Promise<unknown> {
  return readJsonResponse(await sendPost(options), options.maxBytes, options.errorOptions);
}
