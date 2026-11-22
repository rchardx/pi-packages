import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Capability = "search" | "fetch";
export const WEB_PROVIDERS = ["deepseek", "exa"] as const;
export type WebProviderId = (typeof WEB_PROVIDERS)[number];

export const EXA_SEARCH_MODES = ["lite", "auto", "deep-lite", "deep"] as const;
export type ExaSearchMode = (typeof EXA_SEARCH_MODES)[number];
export const DEFAULT_EXA_SEARCH_MODE: ExaSearchMode = "auto";

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

export interface SearchProvidersConfig {
  deepseek?: DeepSeekConfig;
  exa?: ExaSearchConfig;
}

export interface FetchProvidersConfig {
  deepseek?: DeepSeekConfig;
  exa?: ExaFetchConfig;
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
  | { provider: "exa"; options: ExaSearchConfig };

export type ResolvedFetchTarget =
  | { provider: "deepseek" }
  | { provider: "exa"; options: ExaFetchConfig };

const CAPABILITY_FIELDS = new Set<string>(["providers", "defaultProvider"]);
const EXA_SEARCH_FIELDS = new Set<string>(["mode", "maxAgeHours"]);
const EXA_FETCH_FIELDS = new Set<string>(["maxAgeHours"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function supportedProvider(value: unknown): WebProviderId | undefined {
  return WEB_PROVIDERS.find((id) => id === value);
}

function supportedExaMode(value: unknown): ExaSearchMode | undefined {
  return EXA_SEARCH_MODES.find((mode) => mode === value);
}

function parseMaxAgeHours(label: string, value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_MAX_AGE_HOURS ||
    value > MAX_MAX_AGE_HOURS
  ) {
    throw new Error(
      `${label} must be an integer between ${MIN_MAX_AGE_HOURS} and ${MAX_MAX_AGE_HOURS}.`,
    );
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
    if (!EXA_SEARCH_FIELDS.has(key)) {
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
    if (!EXA_FETCH_FIELDS.has(key)) {
      throw new Error("Unknown field in fetch.providers.exa: only maxAgeHours is supported.");
    }
  }
  if (!("maxAgeHours" in value)) return {};
  return {
    maxAgeHours: parseMaxAgeHours("fetch.providers.exa.maxAgeHours", value.maxAgeHours),
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
    } else {
      providers.exa = parseExaSearchEntry(entry);
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
    } else {
      providers.exa = parseExaFetchEntry(entry);
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
