import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Capability = "search" | "fetch";
export const WEB_PROVIDERS = ["deepseek", "exa", "parallel"] as const;
export type WebProviderId = (typeof WEB_PROVIDERS)[number];

export const EXA_SEARCH_MODES = ["lite", "auto", "deep-lite", "deep"] as const;
export type ExaSearchMode = (typeof EXA_SEARCH_MODES)[number];
export const DEFAULT_EXA_SEARCH_MODE: ExaSearchMode = "auto";

export const PARALLEL_SEARCH_MODES = ["turbo", "fast", "basic", "advanced"] as const;
export type ParallelSearchMode = (typeof PARALLEL_SEARCH_MODES)[number];
export const DEFAULT_PARALLEL_SEARCH_MODE: ParallelSearchMode = "fast";

export const SEARCH_MODES = [...EXA_SEARCH_MODES, ...PARALLEL_SEARCH_MODES] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const MIN_MAX_AGE_HOURS = -1;
export const MAX_MAX_AGE_HOURS = 720;

export type DeepSeekConfig = Readonly<Record<string, never>>;

export interface ExaSearchConfig {
  readonly mode?: ExaSearchMode;
  readonly maxAgeHours?: number;
}

export interface ExaFetchConfig {
  readonly maxAgeHours?: number;
}

export interface ParallelSearchConfig {
  readonly mode?: ParallelSearchMode;
  readonly maxAgeHours?: number;
}

export interface ParallelFetchConfig {
  readonly maxAgeHours?: number;
}

export interface SearchProvidersConfig {
  deepseek?: DeepSeekConfig;
  exa?: ExaSearchConfig;
  parallel?: ParallelSearchConfig;
}

export interface FetchProvidersConfig {
  deepseek?: DeepSeekConfig;
  exa?: ExaFetchConfig;
  parallel?: ParallelFetchConfig;
}

export interface SearchCapabilityConfig {
  providers: SearchProvidersConfig;
  defaultProvider?: WebProviderId;
}

export interface FetchCapabilityConfig {
  providers: FetchProvidersConfig;
  defaultProvider?: WebProviderId;
}

export interface Config {
  search?: SearchCapabilityConfig;
  fetch?: FetchCapabilityConfig;
}

export type ResolvedSearchTarget =
  | { provider: "deepseek" }
  | { provider: "exa"; options: ExaSearchConfig }
  | { provider: "parallel"; options: ParallelSearchConfig };

export type ResolvedFetchTarget =
  | { provider: "deepseek" }
  | { provider: "exa"; options: ExaFetchConfig }
  | { provider: "parallel"; options: ParallelFetchConfig };

const CAPABILITY_FIELDS = new Set<string>(["providers", "defaultProvider"]);
const SEARCH_PROVIDER_FIELDS = new Set<string>(["mode", "maxAgeHours"]);
const FETCH_PROVIDER_FIELDS = new Set<string>(["maxAgeHours"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function supportedProvider(value: unknown): WebProviderId | undefined {
  return WEB_PROVIDERS.find((id) => id === value);
}

export function supportedExaMode(value: unknown): ExaSearchMode | undefined {
  return EXA_SEARCH_MODES.find((mode) => mode === value);
}

export function supportedParallelMode(value: unknown): ParallelSearchMode | undefined {
  return PARALLEL_SEARCH_MODES.find((mode) => mode === value);
}

function parseMaxAgeHours(label: string, value: unknown, min = MIN_MAX_AGE_HOURS): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > MAX_MAX_AGE_HOURS
  ) {
    throw new Error(`${label} must be an integer between ${min} and ${MAX_MAX_AGE_HOURS}.`);
  }
  return value;
}

function parseDeepSeekEntry(capability: Capability, value: unknown): DeepSeekConfig {
  if (!isPlainObject(value)) {
    throw new Error(`${capability}.providers.deepseek must be a JSON object.`);
  }
  if (Object.keys(value).length > 0) {
    throw new Error(
      `${capability}.providers.deepseek must be {}; DeepSeek accepts no provider options.`,
    );
  }
  return {};
}

function parseExaSearchEntry(value: unknown): ExaSearchConfig {
  if (!isPlainObject(value)) {
    throw new Error("search.providers.exa must be a JSON object.");
  }
  for (const key of Object.keys(value)) {
    if (!SEARCH_PROVIDER_FIELDS.has(key)) {
      throw new Error(
        "Unknown field in search.providers.exa: only mode and maxAgeHours are supported.",
      );
    }
  }
  let mode: ExaSearchMode | undefined;
  if ("mode" in value) {
    mode = supportedExaMode(value.mode);
    if (!mode) {
      throw new Error(`search.providers.exa.mode must be one of ${EXA_SEARCH_MODES.join(", ")}.`);
    }
  }
  let maxAgeHours: number | undefined;
  if ("maxAgeHours" in value) {
    maxAgeHours = parseMaxAgeHours("search.providers.exa.maxAgeHours", value.maxAgeHours);
  }
  if (mode === "lite" && maxAgeHours !== undefined) {
    throw new Error(
      'search.providers.exa cannot combine mode "lite" with maxAgeHours; "lite" uses cached content only.',
    );
  }
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
  };
}

function parseExaFetchEntry(value: unknown): ExaFetchConfig {
  if (!isPlainObject(value)) {
    throw new Error("fetch.providers.exa must be a JSON object.");
  }
  for (const key of Object.keys(value)) {
    if (!FETCH_PROVIDER_FIELDS.has(key)) {
      throw new Error("Unknown field in fetch.providers.exa: only maxAgeHours is supported.");
    }
  }
  if (!("maxAgeHours" in value)) return {};
  return {
    maxAgeHours: parseMaxAgeHours("fetch.providers.exa.maxAgeHours", value.maxAgeHours),
  };
}

function parseParallelSearchEntry(value: unknown): ParallelSearchConfig {
  if (!isPlainObject(value)) {
    throw new Error("search.providers.parallel must be a JSON object.");
  }
  for (const key of Object.keys(value)) {
    if (!SEARCH_PROVIDER_FIELDS.has(key)) {
      throw new Error(
        "Unknown field in search.providers.parallel: only mode and maxAgeHours are supported.",
      );
    }
  }
  let mode: ParallelSearchMode | undefined;
  if ("mode" in value) {
    mode = supportedParallelMode(value.mode);
    if (!mode) {
      throw new Error(
        `search.providers.parallel.mode must be one of ${PARALLEL_SEARCH_MODES.join(", ")}.`,
      );
    }
  }
  let maxAgeHours: number | undefined;
  if ("maxAgeHours" in value) {
    maxAgeHours = parseMaxAgeHours("search.providers.parallel.maxAgeHours", value.maxAgeHours);
  }
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
  };
}

function parseParallelFetchEntry(value: unknown): ParallelFetchConfig {
  if (!isPlainObject(value)) {
    throw new Error("fetch.providers.parallel must be a JSON object.");
  }
  for (const key of Object.keys(value)) {
    if (!FETCH_PROVIDER_FIELDS.has(key)) {
      throw new Error("Unknown field in fetch.providers.parallel: only maxAgeHours is supported.");
    }
  }
  if (!("maxAgeHours" in value)) return {};
  return {
    maxAgeHours: parseMaxAgeHours("fetch.providers.parallel.maxAgeHours", value.maxAgeHours, 0),
  };
}

function parseCapabilityEnvelope(
  capability: Capability,
  value: unknown,
): { entries: Array<[string, unknown]>; rawDefault: unknown; hasDefault: boolean } {
  if (!isPlainObject(value)) {
    throw new Error(
      `${capability} must be an object with a providers map; omit ${capability} to disable it.`,
    );
  }
  for (const key of Object.keys(value)) {
    if (!CAPABILITY_FIELDS.has(key)) {
      throw new Error(
        `Unknown field in ${capability}: only providers and defaultProvider are supported.`,
      );
    }
  }
  const rawProviders = value.providers;
  if (!isPlainObject(rawProviders)) {
    throw new Error(
      `${capability}.providers must be a non-empty object mapping consented providers; omit ${capability} to disable it.`,
    );
  }
  const entries = Object.entries(rawProviders);
  if (entries.length === 0) {
    throw new Error(
      `${capability}.providers must enable at least one provider; omit ${capability} to disable it.`,
    );
  }
  return {
    entries,
    rawDefault: value.defaultProvider,
    hasDefault: "defaultProvider" in value,
  };
}

function parseDefaultProvider(
  capability: Capability,
  providers: object,
  count: number,
  hasDefault: boolean,
  rawDefault: unknown,
): WebProviderId | undefined {
  const supported = WEB_PROVIDERS.join(", ");
  if (!hasDefault) {
    if (count > 1) {
      throw new Error(
        `${capability}.defaultProvider is required when multiple providers are enabled in ${capability}.providers.`,
      );
    }
    return undefined;
  }
  const provider = supportedProvider(rawDefault);
  if (!provider) {
    throw new Error(
      `${capability}.defaultProvider must be one of the supported providers (${supported}).`,
    );
  }
  if (!Object.hasOwn(providers, provider)) {
    throw new Error(
      `${capability}.defaultProvider "${provider}" must also be enabled in ${capability}.providers.`,
    );
  }
  return provider;
}

function parseSearchCapability(value: unknown): SearchCapabilityConfig {
  const { entries, rawDefault, hasDefault } = parseCapabilityEnvelope("search", value);
  const supported = WEB_PROVIDERS.join(", ");
  const providers: SearchProvidersConfig = {};
  for (const [id, entry] of entries) {
    const provider = supportedProvider(id);
    if (!provider) {
      throw new Error(`Unsupported search provider "${id}"; supported providers are ${supported}.`);
    }
    if (provider === "deepseek") {
      providers.deepseek = parseDeepSeekEntry("search", entry);
    } else if (provider === "exa") {
      providers.exa = parseExaSearchEntry(entry);
    } else {
      providers.parallel = parseParallelSearchEntry(entry);
    }
  }
  const defaultProvider = parseDefaultProvider(
    "search",
    providers,
    entries.length,
    hasDefault,
    rawDefault,
  );
  return defaultProvider ? { providers, defaultProvider } : { providers };
}

function parseFetchCapability(value: unknown): FetchCapabilityConfig {
  const { entries, rawDefault, hasDefault } = parseCapabilityEnvelope("fetch", value);
  const supported = WEB_PROVIDERS.join(", ");
  const providers: FetchProvidersConfig = {};
  for (const [id, entry] of entries) {
    const provider = supportedProvider(id);
    if (!provider) {
      throw new Error(`Unsupported fetch provider "${id}"; supported providers are ${supported}.`);
    }
    if (provider === "deepseek") {
      providers.deepseek = parseDeepSeekEntry("fetch", entry);
    } else if (provider === "exa") {
      providers.exa = parseExaFetchEntry(entry);
    } else {
      providers.parallel = parseParallelFetchEntry(entry);
    }
  }
  const defaultProvider = parseDefaultProvider(
    "fetch",
    providers,
    entries.length,
    hasDefault,
    rawDefault,
  );
  return defaultProvider ? { providers, defaultProvider } : { providers };
}

export function parseConfig(value: unknown): Config {
  if (!isPlainObject(value)) {
    throw new Error("Expected a JSON object.");
  }
  const config: Config = {};
  for (const [key, setting] of Object.entries(value)) {
    if (key === "search") {
      config.search = parseSearchCapability(setting);
    } else if (key === "fetch") {
      config.fetch = parseFetchCapability(setting);
    } else {
      throw new Error("Unknown configuration field; only search and fetch are supported.");
    }
  }
  return config;
}

export function resolveSearchTarget(
  setting: SearchCapabilityConfig | undefined,
): ResolvedSearchTarget {
  if (!setting) {
    throw new Error("Search is disabled. Configure search.providers in the user web-access.json.");
  }
  if (setting.providers.exa && (setting.defaultProvider ?? "exa") === "exa") {
    return { provider: "exa", options: setting.providers.exa };
  }
  if (setting.providers.parallel && (setting.defaultProvider ?? "parallel") === "parallel") {
    return { provider: "parallel", options: setting.providers.parallel };
  }
  return { provider: "deepseek" };
}

export function resolveFetchTarget(
  setting: FetchCapabilityConfig | undefined,
): ResolvedFetchTarget {
  if (!setting) {
    throw new Error(
      "Fetch is disabled. Configure fetch.providers in the user web-access.json to authorize URL disclosure and provider charges.",
    );
  }
  if (setting.providers.exa && (setting.defaultProvider ?? "exa") === "exa") {
    return { provider: "exa", options: setting.providers.exa };
  }
  if (setting.providers.parallel && (setting.defaultProvider ?? "parallel") === "parallel") {
    return { provider: "parallel", options: setting.providers.parallel };
  }
  return { provider: "deepseek" };
}

// User configuration only, re-read per invocation. Never let project settings
// or tool arguments authorize credential use or hosted URL/query disclosure.
export async function loadConfig(path = join(getAgentDir(), "web-access.json")): Promise<Config> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new Error(`Cannot read web access configuration: ${path}`, { cause: error });
  }
  try {
    const value: unknown = JSON.parse(source);
    return parseConfig(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid web access configuration (${path}): ${message}`, { cause: error });
  }
}
