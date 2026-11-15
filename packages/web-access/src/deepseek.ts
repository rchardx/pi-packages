import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const DEEPSEEK_API_ORIGIN = "https://api.deepseek.com";
const MISSING_AUTH =
  "Configure DeepSeek authentication in Pi (/login deepseek or DEEPSEEK_API_KEY).";

type Registry = Pick<ModelRegistry, "getProvider" | "getProviderAuth">;

function isSearchOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).origin === DEEPSEEK_API_ORIGIN;
  } catch {
    return false;
  }
}

// Pi owns configuration validity and credential resolution. This adapter only binds
// its effective auth origin to our fixed endpoint and prepares HTTP authentication.
export async function resolveDeepSeekHeaders(registry: Registry): Promise<Headers> {
  let resolved: Awaited<ReturnType<Registry["getProviderAuth"]>>;
  let provider: ReturnType<Registry["getProvider"]>;
  try {
    resolved = await registry.getProviderAuth("deepseek");
    provider = registry.getProvider("deepseek");
  } catch {
    // SDK errors may contain secret-manager output or credential/configuration details.
    throw new Error("Cannot resolve DeepSeek credentials through Pi; check the provider setup.");
  }
  if (!resolved) throw new Error(MISSING_AUTH);
  if (!isSearchOrigin(resolved.auth.baseUrl ?? provider?.baseUrl)) {
    throw new Error(
      `DeepSeek Search requires Pi's effective auth origin to be ${DEEPSEEK_API_ORIGIN}.`,
    );
  }
  const headers = new Headers();
  try {
    if (resolved.auth.apiKey) headers.set("Authorization", `Bearer ${resolved.auth.apiKey}`);
    // Pi headers override defaults; null suppresses a header, case-insensitively.
    for (const source of [provider?.headers, resolved.auth.headers]) {
      for (const [name, value] of Object.entries(source ?? {})) {
        if (value === null) headers.delete(name);
        else headers.set(name, value);
      }
    }
  } catch {
    throw new Error("Cannot prepare DeepSeek authentication headers returned by Pi.");
  }
  if (!headers.get("Authorization")) {
    throw new Error(MISSING_AUTH);
  }
  return headers;
}
