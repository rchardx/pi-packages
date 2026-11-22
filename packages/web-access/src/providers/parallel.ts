import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { PARALLEL_API_ORIGIN, resolveParallelHeaders } from "../auth.ts";
import {
  DEFAULT_PARALLEL_SEARCH_MODE,
  PARALLEL_SEARCH_MODES,
  type ParallelFetchConfig,
  type ParallelSearchConfig,
  type ParallelSearchMode,
  supportedParallelMode,
} from "../config.ts";
import {
  type FetchStructuredOutput,
  formatFetchOutput,
  formatSearchOutput,
  type SearchStructuredOutput,
  singleLine,
} from "../output.ts";
import { postJson, type WebToolKind, withDeadline } from "../request.ts";
import { normalizeFetchUrl, normalizeSearchFilters, normalizeSourceUrl } from "../url.ts";
import {
  DEFAULT_SEARCH_COUNT,
  FETCH_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_MS,
  type SearchInput,
} from "./deepseek.ts";

export const PARALLEL_MAX_QUERY_CHARACTERS = 200;
export const PARALLEL_MIN_MAX_AGE_SECONDS = 600;

const LABELS = { search: "Parallel Search", fetch: "Parallel Fetch" } as const;

function parallelErrorOptions(tool: WebToolKind) {
  return {
    label: LABELS[tool],
    providerLabel: "Parallel",
    tool,
    reasons: {
      401: "Missing or invalid Parallel API key.",
      402: "Insufficient Parallel account credits.",
      403: "Parallel access denied for the requested mode or account.",
    },
  };
}

const ExtractErrorSchema = Type.Object({
  url: Type.Optional(Type.String()),
  error_type: Type.Optional(Type.String()),
  http_status_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
});

const ExtractResultSchema = Type.Object({
  url: Type.Optional(Type.String()),
  title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  publish_date: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  excerpts: Type.Array(Type.String()),
  full_content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const ExtractResponse = Type.Object({
  results: Type.Array(ExtractResultSchema),
  errors: Type.Array(ExtractErrorSchema),
});

const SearchResultSchema = Type.Object({
  url: Type.String(),
  title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  publish_date: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  excerpts: Type.Array(Type.String()),
});

const SearchResponse = Type.Object({
  results: Type.Array(SearchResultSchema),
});

function toFetchPolicy(maxAgeHours: number): { max_age_seconds: number } {
  return {
    max_age_seconds: Math.max(PARALLEL_MIN_MAX_AGE_SECONDS, maxAgeHours * 3600),
  };
}

function parallelExtractFailureMessage(
  errors: Static<typeof ExtractResponse>["errors"],
  hasObjective: boolean,
): string {
  const failed = errors[0];
  const status = failed?.http_status_code ?? undefined;
  const errorType = failed?.error_type;
  if (status === 403) {
    return "Parallel Fetch could not access the target URL (access restricted or unavailable).";
  }
  if (status === 404) {
    return "Parallel Fetch could not find the target page (HTTP 404).";
  }
  if (errorType === "timeout" || status === 408 || status === 504) {
    return "Parallel Fetch timed out while retrieving the target page. This may be transient; retry later.";
  }
  if (failed) {
    return status !== undefined
      ? `Parallel Fetch could not retrieve the target page (upstream HTTP ${status}).`
      : "Parallel Fetch could not retrieve usable page content.";
  }
  if (hasObjective) {
    return "Parallel Fetch found no excerpts matching the requested objective.";
  }
  return "Parallel Fetch returned no readable page content.";
}

export async function fetchParallel(
  input: string,
  resolveHeaders: () => Headers = resolveParallelHeaders,
  options: ParallelFetchConfig & { objective?: string } = {},
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch,
) {
  return withDeadline(LABELS.fetch, FETCH_TIMEOUT_MS, signal, async (combined) => {
    const url = normalizeFetchUrl(input, LABELS.fetch);
    const maxAgeHours = options.maxAgeHours;
    if (maxAgeHours === -1) {
      throw new Error(
        "Parallel Fetch does not support cache-only mode (-1); omit max_age_hours or use 0 or a positive hour limit.",
      );
    }
    const objective = options.objective !== undefined ? singleLine(options.objective) : undefined;
    if (objective === "") {
      throw new Error(
        "Parallel Fetch objective must not be blank; omit objective for full page content.",
      );
    }
    const fetchPolicy = maxAgeHours !== undefined ? toFetchPolicy(maxAgeHours) : undefined;
    const advancedSettings =
      objective !== undefined
        ? fetchPolicy
          ? { fetch_policy: fetchPolicy }
          : undefined
        : {
            full_content: true,
            ...(fetchPolicy ? { fetch_policy: fetchPolicy } : {}),
          };
    const data = await postJson({
      endpoint: `${PARALLEL_API_ORIGIN}/v1/extract`,
      resolveHeaders,
      body: {
        urls: [url],
        ...(objective !== undefined ? { objective } : {}),
        ...(advancedSettings ? { advanced_settings: advancedSettings } : {}),
      },
      signal: combined,
      maxBytes: MAX_RESPONSE_BYTES,
      request,
      errorOptions: parallelErrorOptions("fetch"),
    });
    if (!Check(ExtractResponse, data)) {
      throw new Error("Parallel Fetch returned an invalid page schema.");
    }
    const page = data.results[0];
    const excerptsText = (page?.excerpts ?? [])
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n");
    const fullContent = page?.full_content?.trim() ? page.full_content : "";
    const isExcerpts = objective !== undefined || !fullContent;
    const content = isExcerpts ? excerptsText : fullContent;
    if (!content) {
      throw new Error(parallelExtractFailureMessage(data.errors, objective !== undefined));
    }
    const title = singleLine(page?.title ?? "");
    const publishedDate = page?.publish_date ? singleLine(page.publish_date) : "";
    const result = await formatFetchOutput({
      headerLabel: LABELS.fetch,
      url,
      title,
      ...(publishedDate ? { publishedDate } : {}),
      content,
      ...(objective !== undefined ? { objective } : {}),
      ...(isExcerpts ? { excerpts: true } : {}),
      signal: combined,
    });
    const structuredContent: FetchStructuredOutput = {
      provider: "parallel",
      url,
      title,
      ...(publishedDate ? { publishedDate } : {}),
      ...(objective !== undefined ? { objective } : {}),
      content,
    };
    return {
      ...result,
      details: {
        provider: "parallel",
        url,
        title,
        ...(publishedDate ? { publishedDate } : {}),
        ...(objective !== undefined ? { objective } : {}),
        ...(isExcerpts ? { excerpts: true } : {}),
        ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
        ...result.details,
      },
      structuredContent,
    };
  });
}

export async function searchParallel(
  args: SearchInput,
  resolveHeaders: () => Headers = resolveParallelHeaders,
  options: ParallelSearchConfig = {},
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch,
) {
  return withDeadline(LABELS.search, SEARCH_TIMEOUT_MS, signal, async (combined) => {
    let mode: ParallelSearchMode;
    if (args.mode !== undefined) {
      const parsedMode = supportedParallelMode(args.mode);
      if (!parsedMode) {
        throw new Error(
          `Parallel Search mode must be one of ${PARALLEL_SEARCH_MODES.join(", ")}; got "${args.mode}".`,
        );
      }
      mode = parsedMode;
    } else {
      mode = options.mode ?? DEFAULT_PARALLEL_SEARCH_MODE;
    }
    if (args.need_content) {
      throw new Error(
        "Parallel Search returns Markdown excerpts by default and does not support need_content; omit need_content (or use web_fetch for full page content).",
      );
    }
    const trimmedQuery = args.query.trim();
    if (!trimmedQuery || [...trimmedQuery].length > PARALLEL_MAX_QUERY_CHARACTERS) {
      throw new Error(
        `Parallel Search requires 1–${PARALLEL_MAX_QUERY_CHARACTERS} Unicode characters; shorten the search terms.`,
      );
    }
    const filters = normalizeSearchFilters(args, LABELS.search, {
      allowBareExtensions: true,
      allowPathPrefixes: mode !== "turbo",
      stripWwwOnConflict: true,
    });
    const maxAgeHours = args.max_age_hours ?? options.maxAgeHours;
    const count = args.count ?? DEFAULT_SEARCH_COUNT;
    // Omitting fetch_policy returns cached index results without live site fetches (covering -1).
    const fetchPolicy =
      maxAgeHours !== undefined && maxAgeHours >= 0 ? toFetchPolicy(maxAgeHours) : undefined;
    const sourcePolicy =
      filters.includeDomains || filters.excludeDomains || filters.afterDate
        ? {
            ...(filters.includeDomains ? { include_domains: filters.includeDomains } : {}),
            ...(filters.excludeDomains ? { exclude_domains: filters.excludeDomains } : {}),
            ...(filters.afterDate ? { after_date: filters.afterDate } : {}),
          }
        : undefined;
    const data = await postJson({
      endpoint: `${PARALLEL_API_ORIGIN}/v1/search`,
      resolveHeaders,
      body: {
        mode,
        search_queries: [trimmedQuery],
        advanced_settings: {
          max_results: count,
          ...(sourcePolicy ? { source_policy: sourcePolicy } : {}),
          ...(fetchPolicy ? { fetch_policy: fetchPolicy } : {}),
        },
      },
      signal: combined,
      maxBytes: MAX_RESPONSE_BYTES,
      request,
      errorOptions: parallelErrorOptions("search"),
    });
    if (!Check(SearchResponse, data)) {
      throw new Error("Parallel Search returned an invalid results schema.");
    }
    const usable = data.results.flatMap(
      (item): Array<Static<typeof SearchResponse>["results"][number]> => {
        const normalizedUrl = normalizeSourceUrl(item.url);
        return normalizedUrl ? [{ ...item, url: normalizedUrl }] : [];
      },
    );
    const omittedInvalidUrls = data.results.length - usable.length;
    const entries = usable.slice(0, count);
    const results = entries.map((item) => {
      const publishedDate = item.publish_date ? singleLine(item.publish_date) : "";
      const summary = item.excerpts
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n\n");
      return {
        title: singleLine(item.title ?? "") || item.url,
        url: item.url,
        ...(publishedDate ? { publishedDate } : {}),
        ...(summary ? { summary } : {}),
      };
    });
    const result = await formatSearchOutput({
      headerLabel: `${LABELS.search} (mode: ${mode})`,
      query: args.query,
      requestedCount: count,
      omittedInvalidUrls,
      results,
      includeSummary: true,
      summaryLabel: "Excerpts",
      includeContent: false,
      filters,
      signal: combined,
    });
    const structuredContent: SearchStructuredOutput = {
      provider: "parallel",
      query: args.query,
      results,
      omittedInvalidUrls,
    };
    return {
      ...result,
      details: {
        provider: "parallel",
        mode,
        ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
        ...(filters.includeDomains ? { includeDomains: filters.includeDomains } : {}),
        ...(filters.excludeDomains ? { excludeDomains: filters.excludeDomains } : {}),
        ...(filters.afterDate ? { afterDate: filters.afterDate } : {}),
        query: args.query,
        requestedCount: count,
        resultCount: entries.length,
        omittedInvalidUrls,
        needContent: false,
        ...result.details,
      },
      structuredContent,
    };
  });
}
