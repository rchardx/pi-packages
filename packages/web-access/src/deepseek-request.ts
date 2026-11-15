import { DEEPSEEK_API_ORIGIN } from "./deepseek.ts";

type Tool = "search" | "fetch";
const LABELS = { search: "DeepSeek Search", fetch: "DeepSeek Fetch" };

function httpError(tool: Tool, status: number) {
  const reasons: Record<number, string> = {
    400: `Invalid ${tool} request.`,
    401: "Missing or invalid DeepSeek API key.",
    402: "Insufficient DeepSeek account balance.",
    403: tool === "fetch" ? "Fetch denied by the security policy." : "Search access denied.",
    408: "Request timed out.",
    422: `Invalid ${tool} parameters.`,
    429: `DeepSeek ${tool} rate limit exceeded.`,
    504: `Upstream ${tool} timed out.`,
    ...(tool === "fetch"
      ? {
          404: "No usable page content could be retrieved.",
          413: "Fetch request body is too large.",
        }
      : {}),
  };
  // Return stable, sanitized diagnostics rather than forwarding raw error bodies.
  const reason =
    reasons[status] ?? (tool === "search" ? "Search request failed." : "Fetch request failed.");
  const retry =
    status === 408 || status === 429 || (status >= 500 && status < 600)
      ? " This may be transient; retry later."
      : "";
  return new Error(`${LABELS[tool]} HTTP ${status}: ${reason}${retry}`);
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

function transportError(error: unknown, message: string): Error {
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

async function readResponse(tool: Tool, response: Response, maxBytes: number): Promise<unknown> {
  const label = LABELS[tool];
  if (response.status !== 200) throw httpError(tool, response.status);
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new Error(`${label} returned a non-JSON response.`);
  }
  const limitError = () =>
    new Error(`${label} response exceeds the ${maxBytes / (1024 * 1024)} MiB limit.`);
  const length = response.headers.get("content-length");
  if (length && Number(length) > maxBytes) throw limitError();
  if (!response.body) throw new Error(`${label} returned an empty response body.`);
  const reader = response.body.getReader();
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

export async function withDeepSeekDeadline<T>(
  tool: Tool,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(
    () =>
      controller.abort(new Error(`${LABELS[tool]} timed out after ${timeoutMs / 1000} seconds.`)),
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

export async function requestDeepSeek(
  tool: Tool,
  body: object,
  resolveHeaders: () => Promise<Headers>,
  signal: AbortSignal,
  maxBytes: number,
  request: typeof fetch,
): Promise<unknown> {
  // Pi auth takes no signal. Race the wait; fetch owns request/body cancellation
  // through the same signal, including when credential completion races an abort.
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let authHeaders: Headers;
  try {
    authHeaders = await Promise.race([resolveHeaders(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const headers = new Headers(authHeaders);
  // Authentication belongs to Pi; the JSON payload format belongs to this tool.
  headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await request(`${DEEPSEEK_API_ORIGIN}/v1/tools/${tool}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
  } catch (error) {
    throw transportError(error, `Cannot reach ${LABELS[tool]}; network or redirect failure`);
  }
  return readResponse(tool, response, maxBytes);
}
