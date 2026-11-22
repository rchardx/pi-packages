import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { EXA_API_ORIGIN, resolveExaHeaders } from "../auth.ts";
import {
  DEFAULT_EXA_SEARCH_MODE,
  EXA_SEARCH_MODES,
  type ExaFetchConfig,
  type ExaSearchConfig,
  type ExaSearchMode,
  supportedExaMode,
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

export const EXA_MAX_FETCH_URL_CHARACTERS = 2048;

const LABELS = { search: "Exa Search", fetch: "Exa Fetch" } as const;

function exaErrorOptions(tool: WebToolKind) {
  return {
    label: LABELS[tool],
    providerLabel: "Exa",
    tool,
    reasons: {
      401: "Missing or invalid Exa API key.",
      402: "Insufficient Exa credits or spending budget exceeded.",
      403: "Exa account access denied or feature disabled.",
    },
  };
}

const CrawlErrorSchema = Type.Object({
  tag: Type.Optional(Type.String()),
  httpStatusCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
});

const StatusEntrySchema = Type.Object({
  id: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  error: Type.Optional(Type.Union([CrawlErrorSchema, Type.Null()])),
});

const ContentItemSchema = Type.Object({
  url: Type.Optional(Type.String()),
  title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  publishedDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  text: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  highlights: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
});

const ContentsResponse = Type.Object({
  results: Type.Array(ContentItemSchema),
  statuses: Type.Optional(Type.Array(StatusEntrySchema)),
});

const SearchResultSchema = Type.Object({
  url: Type.String(),
  title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  publishedDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  highlights: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  text: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const SearchResponse = Type.Object({
  results: Type.Array(SearchResultSchema),
});

function exaCrawlFailureMessage(
  statuses: Static<typeof ContentsResponse>["statuses"],
  maxAgeHours: number | undefined,
  hasPage: boolean,
  hasObjective: boolean,
): string {
  const failed = statuses?.find((entry) => entry.status === "error" || Boolean(entry.error));
  const tag = failed?.error?.tag;
  const tagStatus =
    tag && /^CRAWL_HTTP_\d{3}$/u.test(tag) ? Number(tag.slice("CRAWL_HTTP_".length)) : undefined;
  const status = failed?.error?.httpStatusCode ?? tagStatus;
  if (tag === "SOURCE_NOT_AVAILABLE" || status === 403) {
    return "Exa Fetch could not access the target URL (access restricted or unavailable).";
  }
  if (tag === "CRAWL_NOT_FOUND" || status === 404) {
    return "Exa Fetch could not find the target page (HTTP 404).";
  }
  if (
    tag === "CRAWL_TIMEOUT" ||
    tag === "CRAWL_LIVECRAWL_TIMEOUT" ||
    status === 408 ||
    status === 504
  ) {
    return "Exa Fetch timed out while retrieving the target page. This may be transient; retry later.";
  }
  if (failed) {
    return status !== undefined
      ? `Exa Fetch could not retrieve the target page (upstream HTTP ${status}).`
      : "Exa Fetch could not retrieve usable page content.";
  }
  if (maxAgeHours === -1 && (!hasObjective || !hasPage)) {
    return "Exa Fetch found no cached content for the requested URL (max_age_hours: -1); pass max_age_hours: 0 (or a positive hour limit) to allow a live fetch.";
  }
  if (hasObjective) {
    return "Exa Fetch found no excerpts matching the requested objective.";
  }
  return "Exa Fetch returned no readable page content.";
}

export async function fetchExa(
  input: string,
  resolveHeaders: () => Headers = resolveExaHeaders,
  options: ExaFetchConfig & { objective?: string } = {},
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch,
) {
  return withDeadline(LABELS.fetch, FETCH_TIMEOUT_MS, signal, async (combined) => {
    const url = normalizeFetchUrl(input, LABELS.fetch, EXA_MAX_FETCH_URL_CHARACTERS);
    const objective = options.objective !== undefined ? singleLine(options.objective) : undefined;
    if (objective === "") {
      throw new Error(
        "Exa Fetch objective must not be blank; omit objective for full page content.",
      );
    }
    const maxAgeHours = options.maxAgeHours;
    const data = await postJson({
      endpoint: `${EXA_API_ORIGIN}/contents`,
      resolveHeaders,
      body: {
        urls: [url],
        ...(objective !== undefined ? { highlights: { query: objective } } : { text: true }),
        ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
      },
      signal: combined,
      maxBytes: MAX_RESPONSE_BYTES,
      request,
      errorOptions: exaErrorOptions("fetch"),
    });
    if (!Check(ContentsResponse, data)) {
      throw new Error("Exa Fetch returned an invalid page schema.");
    }
    const page = data.results[0];
    const content =
      objective !== undefined
        ? (page?.highlights ?? [])
            .map((part) => part.trim())
            .filter(Boolean)
            .join("\n\n")
        : page?.text?.trim()
          ? page.text
          : "";
    if (!content) {
      throw new Error(
        exaCrawlFailureMessage(
          data.statuses,
          maxAgeHours,
          page !== undefined,
          objective !== undefined,
        ),
      );
    }
    const title = singleLine(page?.title ?? "");
    const publishedDate = page?.publishedDate ? singleLine(page.publishedDate) : "";
    const isExcerpts = objective !== undefined;
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
      provider: "exa",
      url,
      title,
      ...(publishedDate ? { publishedDate } : {}),
      ...(objective !== undefined ? { objective } : {}),
      content,
    };
    return {
      ...result,
      details: {
        provider: "exa",
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

export async function searchExa(
  args: SearchInput,
  resolveHeaders: () => Headers = resolveExaHeaders,
  options: ExaSearchConfig = {},
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch,
) {
  return withDeadline(LABELS.search, SEARCH_TIMEOUT_MS, signal, async (combined) => {
    if (!args.query.trim()) {
      throw new Error("Exa Search requires a non-blank query.");
    }
    let mode: ExaSearchMode;
    if (args.mode !== undefined) {
      const parsedMode = supportedExaMode(args.mode);
      if (!parsedMode) {
        throw new Error(
          `Exa Search mode must be one of ${EXA_SEARCH_MODES.join(", ")}; got "${args.mode}".`,
        );
      }
      mode = parsedMode;
    } else {
      mode = options.mode ?? DEFAULT_EXA_SEARCH_MODE;
    }
    const callMaxAge = args.max_age_hours;
    if (callMaxAge !== undefined && mode === "lite") {
      throw new Error(
        'Exa Search mode "lite" uses cached content only and cannot be combined with max_age_hours.',
      );
    }
    const filters = normalizeSearchFilters(args, LABELS.search);
    // Per-call mode="lite" ignores a configured maxAgeHours default so cached fast-path overrides work.
    const maxAgeHours = mode === "lite" ? undefined : (callMaxAge ?? options.maxAgeHours);
    const count = args.count ?? DEFAULT_SEARCH_COUNT;
    const needContent = args.need_content ?? false;
    // Request a single content view per call (highlights or page text) rather than downloading both.
    const contents = needContent
      ? { text: true, ...(maxAgeHours !== undefined ? { maxAgeHours } : {}) }
      : { highlights: true, ...(maxAgeHours !== undefined ? { maxAgeHours } : {}) };
    const data = await postJson({
      endpoint: `${EXA_API_ORIGIN}/search`,
      resolveHeaders,
      body: {
        query: args.query,
        type: mode,
        numResults: count,
        ...(filters.includeDomains ? { includeDomains: filters.includeDomains } : {}),
        ...(filters.excludeDomains ? { excludeDomains: filters.excludeDomains } : {}),
        ...(filters.afterDate ? { startPublishedDate: `${filters.afterDate}T00:00:00.000Z` } : {}),
        contents,
      },
      signal: combined,
      maxBytes: MAX_RESPONSE_BYTES,
      request,
      errorOptions: exaErrorOptions("search"),
    });
    if (!Check(SearchResponse, data)) {
      throw new Error("Exa Search returned an invalid results schema.");
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
      const publishedDate = item.publishedDate ? singleLine(item.publishedDate) : "";
      const highlights = (item.highlights ?? [])
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n\n");
      const content = item.text?.trim() ? item.text : "";
      return {
        title: singleLine(item.title ?? "") || item.url,
        url: item.url,
        ...(publishedDate ? { publishedDate } : {}),
        ...(!needContent && highlights ? { summary: highlights } : {}),
        ...(needContent && content ? { content } : {}),
      };
    });
    const result = await formatSearchOutput({
      headerLabel: `${LABELS.search} (mode: ${mode})`,
      query: args.query,
      requestedCount: count,
      omittedInvalidUrls,
      results,
      includeSummary: !needContent,
      summaryLabel: "Highlights",
      includeContent: needContent,
      filters,
      signal: combined,
    });
    const structuredContent: SearchStructuredOutput = {
      provider: "exa",
      query: args.query,
      results,
      omittedInvalidUrls,
    };
    return {
      ...result,
      details: {
        provider: "exa",
        mode,
        ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
        ...(filters.includeDomains ? { includeDomains: filters.includeDomains } : {}),
        ...(filters.excludeDomains ? { excludeDomains: filters.excludeDomains } : {}),
        ...(filters.afterDate ? { afterDate: filters.afterDate } : {}),
        query: args.query,
        requestedCount: count,
        resultCount: entries.length,
        omittedInvalidUrls,
        needContent,
        ...result.details,
      },
      structuredContent,
    };
  });
}
