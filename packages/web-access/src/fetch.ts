import { Type } from "typebox";
import { type AuthRegistry, resolveAnthropicAuth, resolveDeepSeekHeaders } from "./auth.ts";
import type { FetchProviderId, ResolvedCapabilityTarget } from "./config.ts";
import { fetchAnthropic } from "./providers/anthropic.ts";
import { FETCH_TIMEOUT_MS, fetchDeepSeek, MAX_RESPONSE_BYTES } from "./providers/deepseek.ts";
import { MAX_FETCH_URL_CHARACTERS } from "./url.ts";

export {
  FETCH_TIMEOUT_MS,
  fetchAnthropic,
  fetchDeepSeek,
  MAX_FETCH_URL_CHARACTERS,
  MAX_RESPONSE_BYTES as MAX_FETCH_RESPONSE_BYTES,
};

export const FetchParameters = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: MAX_FETCH_URL_CHARACTERS,
      description:
        "HTTP(S) page URL to disclose to the configured provider and fetch as Markdown or text",
    }),
  },
  { additionalProperties: false },
);

export function executeFetch(
  target: ResolvedCapabilityTarget<FetchProviderId>,
  url: string,
  registry: AuthRegistry,
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch,
) {
  if (target.provider === "deepseek") {
    return fetchDeepSeek(url, () => resolveDeepSeekHeaders(registry), signal, request);
  }
  return fetchAnthropic(
    url,
    () => resolveAnthropicAuth(registry),
    target.model ? { model: target.model } : {},
    signal,
    request,
  );
}
