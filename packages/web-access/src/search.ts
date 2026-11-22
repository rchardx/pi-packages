import { type Static, Type } from "typebox";
import { resolveDeepSeekHeaders, resolveExaHeaders } from "./auth.ts";
import {
  EXA_SEARCH_MODES,
  MAX_MAX_AGE_HOURS,
  MIN_MAX_AGE_HOURS,
  type ResolvedSearchTarget,
} from "./config.ts";
import {
  DEEPSEEK_MAX_QUERY_CHARACTERS,
  DEFAULT_SEARCH_COUNT,
  MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_MS,
  searchDeepSeek,
} from "./providers/deepseek.ts";
import { searchExa } from "./providers/exa.ts";

export {
  DEEPSEEK_MAX_QUERY_CHARACTERS,
  DEFAULT_SEARCH_COUNT,
  MAX_RESPONSE_BYTES as MAX_SEARCH_RESPONSE_BYTES,
  SEARCH_TIMEOUT_MS,
  searchDeepSeek,
  searchExa,
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
    mode: Type.Optional(
      Type.Enum([...EXA_SEARCH_MODES], {
        description:
          'Optional search tier override when supported ("lite" cached fast-path, "auto" balanced, "deep-lite" or "deep" multi-step)',
      }),
    ),
    max_age_hours: Type.Optional(
      Type.Integer({
        minimum: MIN_MAX_AGE_HOURS,
        maximum: MAX_MAX_AGE_HOURS,
        description:
          "Optional content freshness target in hours when supported (0 requests a live fetch, -1 uses cache only, 1–720 sets target max cache age)",
      }),
    ),
  },
  { additionalProperties: false },
);

export function executeSearch(
  target: ResolvedSearchTarget,
  args: Static<typeof SearchParameters>,
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch,
) {
  switch (target.provider) {
    case "deepseek":
      return searchDeepSeek(args, resolveDeepSeekHeaders, signal, request);
    case "exa":
      return searchExa(args, resolveExaHeaders, target.options, signal, request);
  }
}
