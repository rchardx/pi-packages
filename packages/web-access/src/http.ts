import dns from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import type { AllowRange } from "./config.ts";

export const MAX_URL_LENGTH = 2048;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const TIMEOUT_MS = 20_000;
export const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface Address {
  address: string;
  family: number;
}

export interface Network {
  lookup: (hostname: string) => Promise<Address[]>;
  open: (url: URL, address: Address, signal: AbortSignal) => Promise<IncomingMessage>;
}

const network: Network = {
  lookup: (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  open: openResponse,
};

export function parseUrl(input: string): URL {
  if (input.length > MAX_URL_LENGTH) throw new Error(`URL exceeds ${MAX_URL_LENGTH} characters.`);
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  if (url.username || url.password)
    throw new Error("URLs with embedded credentials are not allowed.");
  url.hash = "";
  return url;
}

export function assertAllowedAddress(
  address: string,
  allowRanges: readonly AllowRange[] = [],
): void {
  if (!ipaddr.isValid(address)) throw new Error("Invalid network destination address.");
  const parsed = ipaddr.process(address);
  if (parsed.range() === "unicast") return;
  if (
    allowRanges.some(
      ([network, prefix]) => parsed.kind() === network.kind() && parsed.match(network, prefix),
    )
  )
    return;
  throw new Error(
    `Blocked non-public network destination: ${address}. To allow a trusted network, configure allowRanges in your user web-access.json.`,
  );
}

// Waiters cancel promptly even though the OS DNS lookup itself cannot be cancelled.
async function resolveAddress(
  url: URL,
  signal: AbortSignal,
  transport: Network,
  allowRanges: readonly AllowRange[],
): Promise<Address> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const family = isIP(hostname);
  if (family) {
    assertAllowedAddress(hostname, allowRanges);
    return { address: hostname, family };
  }
  signal.throwIfAborted();
  const addresses = await new Promise<Address[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    transport
      .lookup(hostname)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", abort);
      });
  });
  signal.throwIfAborted();
  // Every answer must be public or explicitly allowed, not just the chosen one.
  for (const entry of addresses) assertAllowedAddress(entry.address, allowRanges);
  const first = addresses[0];
  if (!first) throw new Error("DNS returned no addresses.");
  return first;
}

export function openResponse(
  url: URL,
  address: Address,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(
      url,
      {
        signal,
        agent: false,
        family: address.family,
        // Pin the validated address at connection time; retain Host and TLS SNI.
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        headers: {
          "User-Agent": "pi-web-access/0.1",
          Accept: "text/html, text/plain, text/markdown, application/json, application/xml;q=0.9",
          "Accept-Encoding": "identity",
        },
      },
      resolve,
    );
    request.on("error", reject);
  });
}

async function readBody(response: IncomingMessage): Promise<Buffer> {
  if (Number(response.headers["content-length"]) > MAX_RESPONSE_BYTES) {
    throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected response stream encoding.");
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function download(
  input: string,
  signal?: AbortSignal,
  transport: Network = network,
  allowRanges: readonly AllowRange[] = [],
) {
  let url = parseUrl(input);
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error(`Request timed out after ${TIMEOUT_MS} ms.`)),
    TIMEOUT_MS,
  );
  timer.unref();
  const activeSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    for (let redirects = 0; ; redirects++) {
      activeSignal.throwIfAborted();
      const address = await resolveAddress(url, activeSignal, transport, allowRanges);
      activeSignal.throwIfAborted();
      const response = await transport.open(url, address, activeSignal);
      try {
        const status = response.statusCode ?? 0;
        if (REDIRECTS.has(status)) {
          if (redirects >= MAX_REDIRECTS)
            throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS}).`);
          const location = response.headers.location;
          if (!location) throw new Error("Redirect response has no Location header.");
          const next = parseUrl(new URL(location, url).href);
          if (url.protocol === "https:" && next.protocol === "http:") {
            throw new Error("HTTPS to HTTP redirects are not allowed.");
          }
          url = next;
          continue;
        }
        if (status < 200 || status >= 300)
          throw new Error(`HTTP ${status}. The page could not be read.`);
        if (status === 206)
          throw new Error("Server returned partial content; refusing an incomplete page.");
        const contentType = response.headers["content-type"] ?? "";
        const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        if (
          !/^(text\/(html|plain|markdown|csv|xml)|application\/(json|[\w.+-]+\+json|xml|xhtml\+xml))$/u.test(
            mediaType,
          )
        ) {
          throw new Error(
            `Unsupported Content-Type: ${mediaType || "missing"}. Only HTML and supported text formats can be read.`,
          );
        }
        const encoding = response.headers["content-encoding"]?.toLowerCase();
        if (encoding && encoding !== "identity") {
          throw new Error(
            `Unsupported Content-Encoding: ${encoding}. The server must honor Accept-Encoding: identity.`,
          );
        }
        const body = await readBody(response);
        activeSignal.throwIfAborted();
        const charset = /charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType)?.[1] ?? "utf-8";
        const text = new TextDecoder(charset, { fatal: true }).decode(body);
        return { url: url.href, mediaType, text };
      } finally {
        response.destroy();
      }
    }
  } catch (error) {
    if (activeSignal.aborted) throw activeSignal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
