import { type Static, Type } from "typebox";
import { type AuthRegistry, resolveDeepSeekHeaders } from "./auth.ts";
import type { ResolvedCapabilityTarget } from "./config.ts";
import {
  DEEPSEEK_MAX_QUERY_CHARACTERS,
  DEFAULT_SEARCH_COUNT,
  MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_MS,
  searchDeepSeek,
} from "./providers/deepseek.ts";

export {
  DEEPSEEK_MAX_QUERY_CHARACTERS,
  DEFAULT_SEARCH_COUNT,
  MAX_RESPONSE_BYTES as MAX_SEARCH_RESPONSE_BYTES,
  SEARCH_TIMEOUT_MS,
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
        description: `Maximum results (default: ${DEFAULT_SEARCH_COUNT}); request fewer with need_content`,
      }),
    ),
    need_content: Type.Optional(
      Type.Boolean({
        description:
          "Request available page content alongside results (default: false); prefer fewer results when true",
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
  switch (target.provider) {
    case "deepseek":
      return searchDeepSeek(args, () => resolveDeepSeekHeaders(registry), signal, request);
  }
}
