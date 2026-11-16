import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Capability = "search" | "fetch";
export type WebProviderId = "deepseek" | "anthropic";

export type DeepSeekProviderConfig = Record<string, never>;

export interface ModelProviderConfig {
  readonly model?: string;
}

export interface CapabilityProvidersConfig {
  deepseek?: DeepSeekProviderConfig;
  anthropic?: ModelProviderConfig;
}

export interface CapabilityConfig {
  providers: CapabilityProvidersConfig;
  defaultProvider?: WebProviderId;
}

export interface Config {
  search?: CapabilityConfig;
  fetch?: CapabilityConfig;
}

export type ResolvedCapabilityTarget =
  | { provider: "deepseek" }
  | { provider: "anthropic"; model?: string };

const SUPPORTED_PROVIDERS = new Set<string>(["deepseek", "anthropic"]);
const CAPABILITY_FIELDS = new Set<string>(["providers", "defaultProvider"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isWebProviderId(value: string): value is WebProviderId {
  return SUPPORTED_PROVIDERS.has(value);
}

function parseDeepSeekEntry(capability: Capability, value: unknown): DeepSeekProviderConfig {
  if (!isPlainObject(value)) {
    throw new Error(`${capability}.providers.deepseek must be a JSON object.`);
  }
  if (Object.keys(value).length > 0) {
    throw new Error(
      `${capability}.providers.deepseek must be {}; DeepSeek uses standalone endpoints and accepts no options.`,
    );
  }
  return {};
}

function parseAnthropicEntry(capability: Capability, value: unknown): ModelProviderConfig {
  if (!isPlainObject(value)) {
    throw new Error(`${capability}.providers.anthropic must be a JSON object.`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "model") {
      throw new Error(
        `Unknown field in ${capability}.providers.anthropic: only model is supported.`,
      );
    }
  }
  if (!("model" in value)) return {};
  const { model } = value;
  if (typeof model !== "string" || model.length === 0 || /[\s\p{Cc}]/u.test(model)) {
    throw new Error(`${capability}.providers.anthropic.model must be a non-empty model ID.`);
  }
  return { model };
}

function parseCapabilityConfig(capability: Capability, value: unknown): CapabilityConfig {
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
  const providers: CapabilityProvidersConfig = {};
  for (const [id, entry] of providerEntries) {
    if (!isWebProviderId(id)) {
      throw new Error(
        `Unsupported ${capability} provider "${id}"; supported providers are deepseek and anthropic.`,
      );
    }
    if (id === "deepseek") {
      providers.deepseek = parseDeepSeekEntry(capability, entry);
    } else {
      providers.anthropic = parseAnthropicEntry(capability, entry);
    }
  }
  if (!("defaultProvider" in value)) {
    return { providers };
  }
  const { defaultProvider } = value;
  if (typeof defaultProvider !== "string" || !isWebProviderId(defaultProvider)) {
    throw new Error(
      `${capability}.defaultProvider must be one of the supported providers (deepseek, anthropic).`,
    );
  }
  if (!Object.hasOwn(providers, defaultProvider)) {
    throw new Error(
      `${capability}.defaultProvider "${defaultProvider}" must also be enabled in ${capability}.providers.`,
    );
  }
  return { providers, defaultProvider };
}

export function parseConfig(value: unknown): Config {
  if (!isPlainObject(value)) {
    throw new Error("Expected a JSON object.");
  }
  const config: Config = {};
  for (const [key, setting] of Object.entries(value)) {
    if (key !== "search" && key !== "fetch") {
      throw new Error("Unknown configuration field; only search and fetch are supported.");
    }
    config[key] = parseCapabilityConfig(key, setting);
  }
  return config;
}

export function resolveCapabilityTarget(
  capability: Capability,
  setting: CapabilityConfig | undefined,
  activeProvider: string | undefined,
): ResolvedCapabilityTarget {
  if (!setting) {
    throw new Error(
      capability === "search"
        ? "Search is disabled. Configure search.providers in the user web-access.json."
        : "Fetch is disabled. Configure fetch.providers in the user web-access.json to authorize URL disclosure and provider charges.",
    );
  }
  const select = (provider: WebProviderId): ResolvedCapabilityTarget => {
    if (provider === "deepseek") return { provider: "deepseek" };
    const model = setting.providers.anthropic?.model;
    return model ? { provider: "anthropic", model } : { provider: "anthropic" };
  };
  if (
    activeProvider &&
    isWebProviderId(activeProvider) &&
    Object.hasOwn(setting.providers, activeProvider)
  ) {
    return select(activeProvider);
  }
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
