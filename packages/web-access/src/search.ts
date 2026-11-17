import { type Static, Type } from "typebox";
import {
  type AuthRegistry,
  resolveAnthropicAuth,
  resolveDeepSeekHeaders,
  resolveOpenAICodexHeaders,
  resolveOpenAIHeaders,
} from "./auth.ts";
import type { ResolvedCapabilityTarget, SearchProviderId } from "./config.ts";
import { ANTHROPIC_MAX_QUERY_CHARACTERS, searchAnthropic } from "./providers/anthropic.ts";
import {
  DEEPSEEK_MAX_QUERY_CHARACTERS,
  DEFAULT_SEARCH_COUNT,
  MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_MS,
  searchDeepSeek,
} from "./providers/deepseek.ts";
import { searchOpenAI } from "./providers/openai.ts";

export {
  ANTHROPIC_MAX_QUERY_CHARACTERS,
  DEEPSEEK_MAX_QUERY_CHARACTERS,
  DEFAULT_SEARCH_COUNT,
  MAX_RESPONSE_BYTES as MAX_SEARCH_RESPONSE_BYTES,
  SEARCH_TIMEOUT_MS,
  searchAnthropic,
  searchDeepSeek,
  searchOpenAI,
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
        description: `Maximum results (default: ${DEFAULT_SEARCH_COUNT}); request fewer with need_content`,
      }),
    ),
    need_content: Type.Optional(
      Type.Boolean({
        description:
          "Request available page content (default: false); when unsupported, results say to use web_fetch",
      }),
    ),
  },
  { additionalProperties: false },
);

export function executeSearch(
  target: ResolvedCapabilityTarget<SearchProviderId>,
  args: Static<typeof SearchParameters>,
  registry: AuthRegistry,
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch,
) {
  const options = target.model ? { model: target.model } : {};
  switch (target.provider) {
    case "deepseek":
      return searchDeepSeek(args, () => resolveDeepSeekHeaders(registry), signal, request);
    case "anthropic":
      return searchAnthropic(args, () => resolveAnthropicAuth(registry), options, signal, request);
    case "openai":
      return searchOpenAI(
        "openai",
        args,
        () => resolveOpenAIHeaders(registry),
        options,
        signal,
        request,
      );
    case "openai-codex":
      return searchOpenAI(
        "openai-codex",
        args,
        () => resolveOpenAICodexHeaders(registry),
        options,
        signal,
        request,
      );
  }
}
