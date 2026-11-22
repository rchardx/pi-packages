import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const DEEPSEEK_API_ORIGIN = "https://api.deepseek.com";

const MISSING_DEEPSEEK_AUTH =
  "Configure DeepSeek authentication in Pi (/login deepseek or DEEPSEEK_API_KEY).";

export type AuthRegistry = Pick<ModelRegistry, "getProvider" | "getProviderAuth">;

function hasOrigin(value: string | undefined, expectedOrigin: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).origin === expectedOrigin;
  } catch {
    return false;
  }
}

type HeaderOverrides = ReadonlyMap<string, { name: string; value: string | null }>;

interface ProviderAuthSpec<TResult> {
  id: string;
  label: string;
  origin: string;
  missingAuthMessage: string;
  build: (apiKey: string | undefined, overrides: HeaderOverrides) => TResult | undefined;
}

function collectHeaderOverrides(
  sources: ReadonlyArray<Record<string, string | null> | undefined>,
): HeaderOverrides {
  const overrides = new Map<string, { name: string; value: string | null }>();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      overrides.set(name.toLowerCase(), { name, value });
    }
  }
  return overrides;
}

function applyHeaderOverrides(headers: Headers, overrides: HeaderOverrides): void {
  for (const { name, value } of overrides.values()) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
}

async function resolveProviderAuth<TResult>(
  registry: AuthRegistry,
  spec: ProviderAuthSpec<TResult>,
): Promise<TResult> {
  let resolved: Awaited<ReturnType<AuthRegistry["getProviderAuth"]>>;
  let provider: ReturnType<AuthRegistry["getProvider"]>;
  try {
    resolved = await registry.getProviderAuth(spec.id);
    provider = registry.getProvider(spec.id);
  } catch {
    // SDK errors may contain secret-manager output or credential/configuration details.
    throw new Error(
      `Cannot resolve ${spec.label} credentials through Pi; check the provider setup.`,
    );
  }
  if (!resolved) throw new Error(spec.missingAuthMessage);
  if (!hasOrigin(resolved.auth.baseUrl ?? provider?.baseUrl, spec.origin)) {
    throw new Error(
      `${spec.label} web tools require Pi's effective auth origin to be ${spec.origin}.`,
    );
  }
  let built: TResult | undefined;
  try {
    const overrides = collectHeaderOverrides([provider?.headers, resolved.auth.headers]);
    built = spec.build(resolved.auth.apiKey, overrides);
  } catch {
    throw new Error(`Cannot prepare ${spec.label} authentication headers returned by Pi.`);
  }
  if (!built) throw new Error(spec.missingAuthMessage);
  return built;
}

function bearerHeaders(apiKey: string | undefined, overrides: HeaderOverrides) {
  const headers = new Headers();
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  applyHeaderOverrides(headers, overrides);
  return headers.get("Authorization")?.trim() ? headers : undefined;
}

// Pi owns configuration validity and credential resolution. These adapters only bind
// its effective auth origin to fixed endpoints and prepare HTTP authentication.
export async function resolveDeepSeekHeaders(registry: AuthRegistry): Promise<Headers> {
  return resolveProviderAuth(registry, {
    id: "deepseek",
    label: "DeepSeek",
    origin: DEEPSEEK_API_ORIGIN,
    missingAuthMessage: MISSING_DEEPSEEK_AUTH,
    build: bearerHeaders,
  });
}
