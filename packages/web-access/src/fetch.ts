import { Type } from "typebox";
import { type AuthRegistry, resolveDeepSeekHeaders } from "./auth.ts";
import type { ResolvedCapabilityTarget } from "./config.ts";
import { FETCH_TIMEOUT_MS, fetchDeepSeek, MAX_RESPONSE_BYTES } from "./providers/deepseek.ts";
import { MAX_FETCH_URL_CHARACTERS } from "./url.ts";

export {
  FETCH_TIMEOUT_MS,
  fetchDeepSeek,
  MAX_FETCH_URL_CHARACTERS,
  MAX_RESPONSE_BYTES as MAX_FETCH_RESPONSE_BYTES,
};

export const FetchParameters = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: MAX_FETCH_URL_CHARACTERS,
      description: "Absolute public HTTP(S) URL",
    }),
  },
  { additionalProperties: false },
);

export function executeFetch(
  target: ResolvedCapabilityTarget,
  url: string,
  registry: AuthRegistry,
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch,
) {
  switch (target.provider) {
    case "deepseek":
      return fetchDeepSeek(url, () => resolveDeepSeekHeaders(registry), signal, request);
  }
}
