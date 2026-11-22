import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Capability = "search" | "fetch";
export const WEB_PROVIDERS = ["deepseek"] as const;
export type WebProviderId = (typeof WEB_PROVIDERS)[number];

export type ProviderConfig = Readonly<Record<string, never>>;

export interface CapabilityConfig {
  providers: Partial<Record<WebProviderId, ProviderConfig>>;
  defaultProvider?: WebProviderId;
}

export interface Config {
  search?: CapabilityConfig;
  fetch?: CapabilityConfig;
}

export interface ResolvedCapabilityTarget {
  provider: WebProviderId;
}

const CAPABILITY_FIELDS = new Set<string>(["providers", "defaultProvider"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function supportedProvider(value: unknown): WebProviderId | undefined {
  return WEB_PROVIDERS.find((id) => id === value);
}

function parseProviderEntry(
  capability: Capability,
  provider: WebProviderId,
  value: unknown,
): ProviderConfig {
  if (!isPlainObject(value)) {
    throw new Error(`${capability}.providers.${provider} must be a JSON object.`);
  }
  if (Object.keys(value).length > 0) {
    throw new Error(
      `${capability}.providers.${provider} must be {}; standalone tool endpoints accept no options.`,
    );
  }
  return {};
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
  const supported = WEB_PROVIDERS.join(", ");
  const providers: CapabilityConfig["providers"] = {};
  for (const [id, entry] of providerEntries) {
    const provider = supportedProvider(id);
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
  const provider = supportedProvider(value.defaultProvider);
  if (!provider) {
    throw new Error(
      `${capability}.defaultProvider must be one of the supported providers (${supported}).`,
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
    if (key === "search" || key === "fetch") {
      config[key] = parseCapabilityConfig(key, setting);
    } else {
      throw new Error("Unknown configuration field; only search and fetch are supported.");
    }
  }
  return config;
}

export function resolveCapabilityTarget(
  capability: Capability,
  setting: CapabilityConfig | undefined,
): ResolvedCapabilityTarget {
  if (!setting) {
    throw new Error(
      capability === "search"
        ? "Search is disabled. Configure search.providers in the user web-access.json."
        : "Fetch is disabled. Configure fetch.providers in the user web-access.json to authorize URL disclosure and provider charges.",
    );
  }
  return { provider: setting.defaultProvider ?? "deepseek" };
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
