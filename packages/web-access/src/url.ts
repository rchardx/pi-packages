export const MAX_FETCH_URL_CHARACTERS = 8192;
export const MAX_DOMAIN_FILTERS = 100;

export interface SearchFilterInput {
  readonly include_domains?: readonly string[];
  readonly exclude_domains?: readonly string[];
  readonly after_date?: string;
}

export interface SearchFilterOptions {
  readonly allowBareExtensions?: boolean;
  readonly allowPathPrefixes?: boolean;
  readonly stripWwwOnConflict?: boolean;
}

export interface NormalizedSearchFilters {
  readonly includeDomains?: string[];
  readonly excludeDomains?: string[];
  readonly afterDate?: string;
}

export function normalizeFetchUrl(
  input: string,
  label = "Fetch",
  maxCharacters = MAX_FETCH_URL_CHARACTERS,
): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid URL; provide an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }
  url.hash = "";
  // Normalization can expand non-ASCII input beyond the registered input limit.
  if (url.href.length > maxCharacters) {
    throw new Error(`${label} URL exceeds ${maxCharacters} characters after normalization.`);
  }
  return url.href;
}

export function normalizeSourceUrl(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    return undefined;
  }
  return url.href;
}

function invalidDomainFilterError(
  label: string,
  field: "include_domains" | "exclude_domains",
  raw: string,
  allowBareExtensions: boolean,
): Error {
  const accepted = allowBareExtensions
    ? 'bare domains, domain/path prefixes, or domain extensions without schemes, wildcards, ports, queries, or fragments (for example "nodejs.org", "github.com/nodejs/node", or ".edu")'
    : 'bare domains or domain/path prefixes without schemes, wildcards, ports, queries, or fragments (for example "nodejs.org" or "github.com/nodejs/node")';
  return new Error(`${label} ${field} entries must be ${accepted}; got "${raw}".`);
}

function normalizeDomainFilterEntry(
  raw: string,
  field: "include_domains" | "exclude_domains",
  label: string,
  options: Required<SearchFilterOptions>,
): string {
  const trimmed = raw.trim();
  if (!trimmed || /[\s\p{Cc}?#\\*]/u.test(trimmed) || trimmed.includes("://")) {
    throw invalidDomainFilterError(label, field, raw, options.allowBareExtensions);
  }
  const slashIndex = trimmed.indexOf("/");
  const rawHost = slashIndex === -1 ? trimmed : trimmed.slice(0, slashIndex);
  const rawPath = slashIndex === -1 ? "" : trimmed.slice(slashIndex);
  if (!rawHost || rawHost.includes(":") || rawHost.includes("@")) {
    throw invalidDomainFilterError(label, field, raw, options.allowBareExtensions);
  }
  let host: string;
  if (rawHost.startsWith(".")) {
    if (
      !options.allowBareExtensions ||
      rawPath !== "" ||
      !/^(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu.test(rawHost)
    ) {
      throw invalidDomainFilterError(label, field, raw, options.allowBareExtensions);
    }
    host = rawHost.toLowerCase();
  } else {
    if (rawHost.endsWith(".")) {
      throw invalidDomainFilterError(label, field, raw, options.allowBareExtensions);
    }
    let parsed: URL;
    try {
      parsed = new URL(`http://${rawHost}`);
    } catch {
      throw invalidDomainFilterError(label, field, raw, options.allowBareExtensions);
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      /^\d+(?:\.\d+){3}$|^\[/u.test(parsed.hostname) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
        parsed.hostname,
      )
    ) {
      throw invalidDomainFilterError(label, field, raw, options.allowBareExtensions);
    }
    host = parsed.hostname;
  }
  const cleanPath = rawPath.replace(/\/+$/u, "");
  if (cleanPath) {
    if (/\/\/|(?:^|\/)\.\.?(?:\/|$)/u.test(cleanPath)) {
      throw invalidDomainFilterError(label, field, raw, options.allowBareExtensions);
    }
    if (!options.allowPathPrefixes) {
      throw new Error(
        `${label} mode "turbo" does not support domain/path prefix filters ("${host}${cleanPath}"); use mode "fast", "basic", or "advanced", or filter by bare domain.`,
      );
    }
  }
  return `${host}${cleanPath}`;
}

function normalizeDomainFilterList(
  entries: readonly string[],
  field: "include_domains" | "exclude_domains",
  label: string,
  options: Required<SearchFilterOptions>,
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of entries) {
    const clean = normalizeDomainFilterEntry(entry, field, label, options);
    if (!seen.has(clean)) {
      seen.add(clean);
      normalized.push(clean);
    }
  }
  return normalized;
}

function canonicalDomainFilterKey(entry: string, stripWww: boolean): string {
  if (!stripWww || !entry.startsWith("www.")) return entry;
  const rest = entry.slice(4);
  const slashIndex = rest.indexOf("/");
  const host = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  return host.includes(".") ? rest : entry;
}

function parseIsoCalendarDate(value: string, label: string): string {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${label} after_date "${value}" is not a valid calendar date.`);
  }
  return value;
}

export function normalizeSearchFilters(
  input: SearchFilterInput,
  label: string,
  options: SearchFilterOptions = {},
): NormalizedSearchFilters {
  const resolvedOptions: Required<SearchFilterOptions> = {
    allowBareExtensions: options.allowBareExtensions ?? false,
    allowPathPrefixes: options.allowPathPrefixes ?? true,
    stripWwwOnConflict: options.stripWwwOnConflict ?? false,
  };
  const includeDomains =
    input.include_domains !== undefined
      ? normalizeDomainFilterList(input.include_domains, "include_domains", label, resolvedOptions)
      : undefined;
  const excludeDomains =
    input.exclude_domains !== undefined
      ? normalizeDomainFilterList(input.exclude_domains, "exclude_domains", label, resolvedOptions)
      : undefined;
  if (includeDomains && excludeDomains) {
    const includedKeys = new Set(
      includeDomains.map((entry) =>
        canonicalDomainFilterKey(entry, resolvedOptions.stripWwwOnConflict),
      ),
    );
    for (const excluded of excludeDomains) {
      if (
        includedKeys.has(canonicalDomainFilterKey(excluded, resolvedOptions.stripWwwOnConflict))
      ) {
        throw new Error(
          `${label} cannot include and exclude the same domain or path ("${excluded}").`,
        );
      }
    }
  }
  const afterDate =
    input.after_date !== undefined ? parseIsoCalendarDate(input.after_date, label) : undefined;
  return {
    ...(includeDomains ? { includeDomains } : {}),
    ...(excludeDomains ? { excludeDomains } : {}),
    ...(afterDate ? { afterDate } : {}),
  };
}
