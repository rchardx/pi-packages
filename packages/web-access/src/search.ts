import { type Static, Type } from "typebox";
import { type AuthRegistry, resolveAnthropicAuth, resolveDeepSeekHeaders } from "./auth.ts";
import type { ResolvedCapabilityTarget } from "./config.ts";
import { ANTHROPIC_MAX_QUERY_CHARACTERS, searchAnthropic } from "./providers/anthropic.ts";
import {
  DEEPSEEK_MAX_QUERY_CHARACTERS,
  DEFAULT_SEARCH_COUNT,
  MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_MS,
  searchDeepSeek,
} from "./providers/deepseek.ts";

export {
  ANTHROPIC_MAX_QUERY_CHARACTERS,
  DEEPSEEK_MAX_QUERY_CHARACTERS,
  DEFAULT_SEARCH_COUNT,
  MAX_RESPONSE_BYTES as MAX_SEARCH_RESPONSE_BYTES,
  SEARCH_TIMEOUT_MS,
  searchAnthropic,
  searchDeepSeek,
};

const MAX_SEARCH_COUNT = 50;

export const SearchParameters = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      description: "Concise search terms with optional operators such as site:nodejs.org",
    }),
    count: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
        description: `Maximum results (default: ${DEFAULT_SEARCH_COUNT}); use fewer with need_content`,
      }),
    ),
    need_content: Type.Optional(
      Type.Boolean({
        description:
          "Include available page content when supported by the provider (DeepSeek only; default: false)",
      }),
    ),
  },
  { additionalProperties: false },
);

export function executeSearch(
  target: ResolvedCapabilityTarget,
  args: Static<typeof SearchParameters>,
  registry: AuthRegistry,
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch,
) {
  if (target.provider === "deepseek") {
    return searchDeepSeek(args, () => resolveDeepSeekHeaders(registry), signal, request);
  }
  return searchAnthropic(
    args,
    () => resolveAnthropicAuth(registry),
    target.model ? { model: target.model } : {},
    signal,
    request,
  );
}
