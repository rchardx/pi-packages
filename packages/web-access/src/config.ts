import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Capability = "search" | "fetch";
export type SearchProviderId = "deepseek" | "anthropic" | "openai" | "openai-codex";
export type FetchProviderId = "deepseek" | "anthropic";
export type WebProviderId = SearchProviderId;

export interface ProviderConfig {
  readonly model?: string;
}

export interface CapabilityConfig<P extends WebProviderId = WebProviderId> {
  providers: Partial<Record<P, ProviderConfig>>;
  defaultProvider?: P;
}

export interface Config {
  search?: CapabilityConfig<SearchProviderId>;
  fetch?: CapabilityConfig<FetchProviderId>;
}

export interface ResolvedCapabilityTarget<P extends WebProviderId = WebProviderId> {
  provider: P;
  model?: string;
}

// The authority for which providers implement each capability. OpenAI has no
// deterministic page-fetch tool, so its providers are search-only.
const SEARCH_PROVIDERS: readonly SearchProviderId[] = [
  "deepseek",
  "anthropic",
  "openai",
  "openai-codex",
];
const FETCH_PROVIDERS: readonly FetchProviderId[] = ["deepseek", "anthropic"];
const CAPABILITY_FIELDS = new Set<string>(["providers", "defaultProvider"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function supportedProvider<P extends WebProviderId>(
  supported: readonly P[],
  value: unknown,
): P | undefined {
  return supported.find((id) => id === value);
}

function parseProviderEntry(
  capability: Capability,
  provider: WebProviderId,
  value: unknown,
): ProviderConfig {
  if (!isPlainObject(value)) {
    throw new Error(`${capability}.providers.${provider} must be a JSON object.`);
  }
  if (provider === "deepseek") {
    if (Object.keys(value).length > 0) {
      throw new Error(
        `${capability}.providers.deepseek must be {}; DeepSeek uses standalone endpoints and accepts no options.`,
      );
    }
    return {};
  }
  for (const key of Object.keys(value)) {
    if (key !== "model") {
      throw new Error(
        `Unknown field in ${capability}.providers.${provider}: only model is supported.`,
      );
    }
  }
  if (!("model" in value)) return {};
  const { model } = value;
  if (typeof model !== "string" || model.length === 0 || /[\s\p{Cc}]/u.test(model)) {
    throw new Error(`${capability}.providers.${provider}.model must be a non-empty model ID.`);
  }
  return { model };
}

function parseCapabilityConfig<P extends WebProviderId>(
  capability: Capability,
  supportedIds: readonly P[],
  value: unknown,
): CapabilityConfig<P> {
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
  const providerEntries = Object.entries(rawProviders);
  if (providerEntries.length === 0) {
    throw new Error(
      `${capability}.providers must enable at least one provider; omit ${capability} to disable it.`,
    );
  }
  const supported = supportedIds.join(", ");
  const providers: CapabilityConfig<P>["providers"] = {};
  for (const [id, entry] of providerEntries) {
    const provider = supportedProvider(supportedIds, id);
    if (!provider) {
      throw new Error(
        `Unsupported ${capability} provider "${id}"; supported providers are ${supported}.`,
      );
    }
    providers[provider] = parseProviderEntry(capability, provider, entry);
  }
  if (!("defaultProvider" in value)) {
    return { providers };
  }
  const { defaultProvider } = value;
  const provider = supportedProvider(supportedIds, defaultProvider);
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
  return { providers, defaultProvider: provider };
}

export function parseConfig(value: unknown): Config {
  if (!isPlainObject(value)) {
    throw new Error("Expected a JSON object.");
  }
  const config: Config = {};
  for (const [key, setting] of Object.entries(value)) {
    if (key === "search") {
      config.search = parseCapabilityConfig(key, SEARCH_PROVIDERS, setting);
    } else if (key === "fetch") {
      config.fetch = parseCapabilityConfig(key, FETCH_PROVIDERS, setting);
    } else {
      throw new Error("Unknown configuration field; only search and fetch are supported.");
    }
  }
  return config;
}

export function resolveCapabilityTarget<P extends WebProviderId>(
  capability: Capability,
  setting: CapabilityConfig<P> | undefined,
  activeProvider: string | undefined,
): ResolvedCapabilityTarget<P> {
  if (!setting) {
    throw new Error(
      capability === "search"
        ? "Search is disabled. Configure search.providers in the user web-access.json."
        : "Fetch is disabled. Configure fetch.providers in the user web-access.json to authorize URL disclosure and provider charges.",
    );
  }
  const select = (provider: P): ResolvedCapabilityTarget<P> => {
    const model = setting.providers[provider]?.model;
    return model ? { provider, model } : { provider };
  };
  const active = Object.keys(setting.providers).find((id): id is P => id === activeProvider);
  if (active) return select(active);
  if (setting.defaultProvider) {
    return select(setting.defaultProvider);
  }
  if (activeProvider) {
    throw new Error(
      `Active model provider "${activeProvider}" is not enabled in ${capability}.providers, and ${capability}.defaultProvider is not set in web-access.json.`,
    );
  }
  throw new Error(
    `No active model is selected to match ${capability}.providers, and ${capability}.defaultProvider is not set in web-access.json.`,
  );
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
