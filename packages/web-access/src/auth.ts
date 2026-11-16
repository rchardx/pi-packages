import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const DEEPSEEK_API_ORIGIN = "https://api.deepseek.com";
export const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";
export const OPENAI_API_ORIGIN = "https://api.openai.com";
export const OPENAI_CODEX_ORIGIN = "https://chatgpt.com";
export const GOOGLE_API_ORIGIN = "https://generativelanguage.googleapis.com";

const MISSING_DEEPSEEK_AUTH =
  "Configure DeepSeek authentication in Pi (/login deepseek or DEEPSEEK_API_KEY).";
const MISSING_ANTHROPIC_AUTH =
  "Configure Anthropic authentication in Pi (/login anthropic, ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN).";
const MISSING_OPENAI_AUTH =
  "Configure OpenAI authentication in Pi (/login openai or OPENAI_API_KEY).";
const MISSING_OPENAI_CODEX_AUTH =
  "Configure OpenAI Codex authentication in Pi (/login openai-codex).";
const MISSING_GOOGLE_AUTH =
  "Configure Google authentication in Pi (/login google or GEMINI_API_KEY).";
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_OAUTH_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ["anthropic-beta", "claude-code-20250219,oauth-2025-04-20"],
  ["anthropic-dangerous-direct-browser-access", "true"],
  ["user-agent", "claude-cli/2.1.322"],
  ["x-app", "cli"],
];

export type AuthRegistry = Pick<ModelRegistry, "getProvider" | "getProviderAuth">;

export interface AnthropicRequestAuth {
  headers: Headers;
  isOAuth: boolean;
}

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

// Accepts both OpenAI API keys and Sign in with ChatGPT access tokens, as Pi does.
export async function resolveOpenAIHeaders(registry: AuthRegistry): Promise<Headers> {
  return resolveProviderAuth(registry, {
    id: "openai",
    label: "OpenAI",
    origin: OPENAI_API_ORIGIN,
    missingAuthMessage: MISSING_OPENAI_AUTH,
    build: bearerHeaders,
  });
}

// Gemini API keys use x-goog-api-key; an explicit credential header replaces that default
// rather than sending two credentials.
export async function resolveGoogleHeaders(registry: AuthRegistry): Promise<Headers> {
  return resolveProviderAuth(registry, {
    id: "google",
    label: "Google",
    origin: GOOGLE_API_ORIGIN,
    missingAuthMessage: MISSING_GOOGLE_AUTH,
    build: (apiKey, overrides) => {
      const explicit =
        Boolean(overrides.get("authorization")?.value?.trim()) ||
        Boolean(overrides.get("x-goog-api-key")?.value?.trim());
      const headers = new Headers();
      if (apiKey && !explicit) headers.set("x-goog-api-key", apiKey);
      applyHeaderOverrides(headers, overrides);
      return headers.get("x-goog-api-key")?.trim() || headers.get("authorization")?.trim()
        ? headers
        : undefined;
    },
  });
}

function codexAccountId(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!claims || typeof claims !== "object") return undefined;
  const auth = (claims as Record<string, unknown>)[CODEX_ACCOUNT_CLAIM];
  if (!auth || typeof auth !== "object") return undefined;
  const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === "string" && accountId ? accountId : undefined;
}

// Like Pi's Codex transport, the ChatGPT access token and its account always win over
// configured headers; the account is read from the token's own claims.
export async function resolveOpenAICodexHeaders(registry: AuthRegistry): Promise<Headers> {
  return resolveProviderAuth(registry, {
    id: "openai-codex",
    label: "OpenAI Codex",
    origin: OPENAI_CODEX_ORIGIN,
    missingAuthMessage: MISSING_OPENAI_CODEX_AUTH,
    build: (apiKey, overrides) => {
      if (!apiKey) return undefined;
      const accountId = codexAccountId(apiKey);
      if (!accountId) throw new Error("Missing ChatGPT account claim.");
      const headers = new Headers({ originator: "pi" });
      applyHeaderOverrides(headers, overrides);
      headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("chatgpt-account-id", accountId);
      headers.set("OpenAI-Beta", "responses=experimental");
      return headers;
    },
  });
}

export function isAnthropicOAuthToken(value: string | undefined): boolean {
  return Boolean(value?.includes("sk-ant-oat"));
}

export async function resolveAnthropicAuth(registry: AuthRegistry): Promise<AnthropicRequestAuth> {
  return resolveProviderAuth(registry, {
    id: "anthropic",
    label: "Anthropic",
    origin: ANTHROPIC_API_ORIGIN,
    missingAuthMessage: MISSING_ANTHROPIC_AUTH,
    build: (apiKey, overrides) => {
      const headers = new Headers();
      headers.set("anthropic-version", ANTHROPIC_VERSION);

      // Explicit credential headers (including Pi's authHeader: true) replace the default
      // scheme rather than sending both x-api-key and Authorization on the same request.
      const hasExplicitAuthHeader =
        Boolean(overrides.get("authorization")?.value?.trim()) ||
        Boolean(overrides.get("x-api-key")?.value?.trim());
      if (!hasExplicitAuthHeader && apiKey) {
        if (isAnthropicOAuthToken(apiKey)) {
          headers.set("Authorization", `Bearer ${apiKey}`);
        } else {
          headers.set("x-api-key", apiKey);
        }
      }

      applyHeaderOverrides(headers, overrides);

      const authorization = headers.get("authorization")?.trim();
      const xApiKey = headers.get("x-api-key")?.trim();
      if (!authorization && !xApiKey) return undefined;

      const isOAuth = !xApiKey && isAnthropicOAuthToken(authorization);
      if (isOAuth) {
        for (const [name, value] of ANTHROPIC_OAUTH_DEFAULTS) {
          if (!overrides.has(name)) headers.set(name, value);
        }
      }
      return { headers, isOAuth };
    },
  });
}
