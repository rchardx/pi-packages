import { type Static, Type } from "typebox";
import { resolveDeepSeekHeaders, resolveExaHeaders, resolveParallelHeaders } from "./auth.ts";
import {
  MAX_MAX_AGE_HOURS,
  MIN_MAX_AGE_HOURS,
  type ResolvedSearchTarget,
  SEARCH_MODES,
} from "./config.ts";
import {
  DEEPSEEK_MAX_QUERY_CHARACTERS,
  DEFAULT_SEARCH_COUNT,
  MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_MS,
  searchDeepSeek,
} from "./providers/deepseek.ts";
import { searchExa } from "./providers/exa.ts";
import { PARALLEL_MAX_QUERY_CHARACTERS, searchParallel } from "./providers/parallel.ts";

export {
  DEEPSEEK_MAX_QUERY_CHARACTERS,
  DEFAULT_SEARCH_COUNT,
  MAX_RESPONSE_BYTES as MAX_SEARCH_RESPONSE_BYTES,
  PARALLEL_MAX_QUERY_CHARACTERS,
  SEARCH_TIMEOUT_MS,
  searchDeepSeek,
  searchExa,
  searchParallel,
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
      Type.Enum([...SEARCH_MODES], {
        description:
          'Optional search tier override matching the active provider (Exa: "lite", "auto", "deep-lite", "deep"; Parallel: "turbo", "fast", "basic", "advanced")',
      }),
    ),
    max_age_hours: Type.Optional(
      Type.Integer({
        minimum: MIN_MAX_AGE_HOURS,
        maximum: MAX_MAX_AGE_HOURS,
        description:
          "Optional content freshness target in hours when supported (0 requests a live fetch on Exa or a 600-second freshness window on Parallel, -1 uses cached/indexed content only, 1–720 sets target max cache age)",
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
    case "parallel":
      return searchParallel(args, resolveParallelHeaders, target.options, signal, request);
  }
}
