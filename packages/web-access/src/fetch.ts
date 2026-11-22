import { type Static, Type } from "typebox";
import { resolveDeepSeekHeaders, resolveExaHeaders, resolveParallelHeaders } from "./auth.ts";
import { MAX_MAX_AGE_HOURS, MIN_MAX_AGE_HOURS, type ResolvedFetchTarget } from "./config.ts";
import { FETCH_TIMEOUT_MS, fetchDeepSeek, MAX_RESPONSE_BYTES } from "./providers/deepseek.ts";
import { EXA_MAX_FETCH_URL_CHARACTERS, fetchExa } from "./providers/exa.ts";
import { fetchParallel, PARALLEL_MIN_MAX_AGE_SECONDS } from "./providers/parallel.ts";
import { MAX_FETCH_URL_CHARACTERS } from "./url.ts";

export {
  EXA_MAX_FETCH_URL_CHARACTERS,
  FETCH_TIMEOUT_MS,
  fetchDeepSeek,
  fetchExa,
  fetchParallel,
  MAX_FETCH_URL_CHARACTERS,
  MAX_RESPONSE_BYTES as MAX_FETCH_RESPONSE_BYTES,
  PARALLEL_MIN_MAX_AGE_SECONDS,
};

export const FetchParameters = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: MAX_FETCH_URL_CHARACTERS,
      description: "Absolute public HTTP(S) URL",
    }),
    max_age_hours: Type.Optional(
      Type.Integer({
        minimum: MIN_MAX_AGE_HOURS,
        maximum: MAX_MAX_AGE_HOURS,
        description:
          "Optional content freshness target in hours when supported (0 requests a live fetch on Exa or a 600-second freshness window on Parallel, -1 uses Exa cache only and is unsupported on Parallel, 1–720 sets target max cache age)",
      }),
    ),
  },
  { additionalProperties: false },
);

export function executeFetch(
  target: ResolvedFetchTarget,
  args: Static<typeof FetchParameters>,
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch,
) {
  switch (target.provider) {
    case "deepseek":
      return fetchDeepSeek(
        args.url,
        resolveDeepSeekHeaders,
        signal,
        request,
        args.max_age_hours !== undefined ? { maxAgeHours: args.max_age_hours } : {},
      );
    case "exa": {
      const maxAgeHours = args.max_age_hours ?? target.options.maxAgeHours;
      return fetchExa(
        args.url,
        resolveExaHeaders,
        maxAgeHours !== undefined ? { maxAgeHours } : {},
        signal,
        request,
      );
    }
    case "parallel": {
      const maxAgeHours = args.max_age_hours ?? target.options.maxAgeHours;
      return fetchParallel(
        args.url,
        resolveParallelHeaders,
        maxAgeHours !== undefined ? { maxAgeHours } : {},
        signal,
        request,
      );
    }
  }
}
