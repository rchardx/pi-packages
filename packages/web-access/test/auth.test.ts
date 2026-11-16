import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type AuthRegistry,
  resolveAnthropicAuth,
  resolveDeepSeekHeaders,
  resolveOpenAICodexHeaders,
  resolveOpenAIHeaders,
} from "../src/auth.ts";

async function deepSeekFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-deepseek-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const provider = runtime.getProvider("deepseek");
  assert.ok(provider);
  const registry: AuthRegistry = {
    getProvider: (id) => {
      assert.equal(id, "deepseek");
      return provider;
    },
    getProviderAuth: async (id) => {
      assert.equal(id, "deepseek");
      return { auth: { apiKey: "test-only-key" } };
    },
  };
  return { provider, registry };
}

async function anthropicFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-anthropic-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const provider = runtime.getProvider("anthropic");
  assert.ok(provider);
  const registry: AuthRegistry = {
    getProvider: (id) => {
      assert.equal(id, "anthropic");
      return provider;
    },
    getProviderAuth: async (id) => {
      assert.equal(id, "anthropic");
      return { auth: { apiKey: "sk-ant-api03-test-only" } };
    },
  };
  return { provider, registry };
}

for (const baseUrl of [
  "https://api.deepseek.com",
  "https://api.deepseek.com/",
  "https://api.deepseek.com/v1",
  "https://api.deepseek.com/v1/",
  "https://api.deepseek.com/beta",
  "https://API.DEEPSEEK.COM:443/anthropic",
  "https://api.deepseek.com/other?version=2#fragment",
  "https://test-user:test-password@api.deepseek.com/v1",
]) {
  test(`DeepSeek accepts the official effective origin regardless of base path: ${baseUrl}`, async (t) => {
    const { registry, provider } = await deepSeekFixture(t);
    registry.getProvider = () => ({ ...provider, baseUrl });
    assert.equal(
      (await resolveDeepSeekHeaders(registry)).get("authorization"),
      "Bearer test-only-key",
    );
    registry.getProvider = () => ({ ...provider, baseUrl: "https://gateway.example.test" });
    registry.getProviderAuth = async () => ({ auth: { apiKey: "test-only-key", baseUrl } });
    assert.equal(
      (await resolveDeepSeekHeaders(registry)).get("authorization"),
      "Bearer test-only-key",
    );
  });
}

for (const baseUrl of [
  "invalid",
  "https://gateway.example.test/v1",
  "https://api.deepseek.com.evil.test/v1",
  "http://api.deepseek.com",
  "https://api.deepseek.com:8443",
]) {
  for (const source of ["provider", "auth"]) {
    test(`DeepSeek rejects a mismatched ${source} origin without exposing the route`, async (t) => {
      const { registry, provider } = await deepSeekFixture(t);
      if (source === "provider") registry.getProvider = () => ({ ...provider, baseUrl });
      else registry.getProviderAuth = async () => ({ auth: { apiKey: "test-only-key", baseUrl } });
      await assert.rejects(resolveDeepSeekHeaders(registry), {
        message:
          "DeepSeek web tools require Pi's effective auth origin to be https://api.deepseek.com.",
      });
    });
  }
}

test("an explicit DeepSeek auth origin is sufficient without provider defaults, but an unknown origin is not", async (t) => {
  const { registry } = await deepSeekFixture(t);
  registry.getProvider = () => undefined;
  await assert.rejects(resolveDeepSeekHeaders(registry), /effective auth origin/u);
  registry.getProviderAuth = async () => ({
    auth: { apiKey: "test-only-key", baseUrl: "https://api.deepseek.com/beta" },
  });
  assert.equal(
    (await resolveDeepSeekHeaders(registry)).get("authorization"),
    "Bearer test-only-key",
  );
});

test("OAuth capability does not prevent use of auth already resolved by Pi", async (t) => {
  const { registry, provider } = await deepSeekFixture(t);
  registry.getProvider = () => ({
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        name: "Test OAuth",
        login: async () => ({
          type: "oauth",
          access: "test-token",
          refresh: "test-refresh",
          expires: 0,
        }),
        refresh: async (credential) => credential,
        toAuth: async () => ({ apiKey: "test-only-key" }),
      },
    },
  });
  assert.equal(
    (await resolveDeepSeekHeaders(registry)).get("authorization"),
    "Bearer test-only-key",
  );
});

test("forwards provider and resolved auth headers with case-insensitive overrides and null suppression", async (t) => {
  const { registry, provider } = await deepSeekFixture(t);
  const providerHeaders = { "X-Provider": "provider", "X-Replace": "old", "X-Remove": "old" };
  const authHeaders = { "x-replace": "new", "x-remove": null, "X-Auth": "resolved" };
  registry.getProvider = () => ({ ...provider, headers: providerHeaders });
  registry.getProviderAuth = async () => ({
    auth: { apiKey: "test-only-key", headers: authHeaders },
  });
  const headers = await resolveDeepSeekHeaders(registry);
  assert.deepEqual(Object.fromEntries(headers), {
    authorization: "Bearer test-only-key",
    "x-auth": "resolved",
    "x-provider": "provider",
    "x-replace": "new",
  });
  assert.equal(providerHeaders["X-Remove"], "old");
  assert.equal(authHeaders["x-remove"], null);
});

test("only final merged header values are validated, so overridden provider values never fail", async (t) => {
  const { registry, provider } = await deepSeekFixture(t);
  registry.getProvider = () => ({
    ...provider,
    headers: { "X-Replaced": "invalid\nvalue", "X-Removed": "invalid\nvalue" },
  });
  registry.getProviderAuth = async () => ({
    auth: { apiKey: "test-only-key", headers: { "x-replaced": "valid", "x-removed": null } },
  });
  assert.deepEqual(Object.fromEntries(await resolveDeepSeekHeaders(registry)), {
    authorization: "Bearer test-only-key",
    "x-replaced": "valid",
  });
});

test("Pi's Authorization header overrides the default bearer key and works without an apiKey field", async (t) => {
  const { registry, provider } = await deepSeekFixture(t);
  registry.getProvider = () => ({
    ...provider,
    headers: { Authorization: "Bearer provider-only-key" },
  });
  registry.getProviderAuth = async () => ({
    auth: { apiKey: "default-key", headers: { authorization: "Bearer resolved-key" } },
  });
  assert.equal(
    (await resolveDeepSeekHeaders(registry)).get("Authorization"),
    "Bearer resolved-key",
  );
  registry.getProviderAuth = async () => ({
    auth: { headers: { authorization: "Bearer header-only-key" } },
  });
  assert.equal(
    (await resolveDeepSeekHeaders(registry)).get("Authorization"),
    "Bearer header-only-key",
  );
});

test("null Authorization suppresses the bearer default instead of restoring a different credential", async (t) => {
  const { registry } = await deepSeekFixture(t);
  registry.getProviderAuth = async () => ({
    auth: { apiKey: "default-key", headers: { authorization: null } },
  });
  await assert.rejects(resolveDeepSeekHeaders(registry), /Configure DeepSeek authentication/u);
});

for (const auth of [
  { apiKey: "private\nkey" },
  { headers: { Authorization: "Bearer private\nkey" } },
  { headers: { "Invalid\nName": "private-value" } },
]) {
  test("HTTP header construction failures are sanitized without validating credential formats", async (t) => {
    const { registry } = await deepSeekFixture(t);
    registry.getProviderAuth = async () => ({ auth });
    await assert.rejects(resolveDeepSeekHeaders(registry), {
      message: "Cannot prepare DeepSeek authentication headers returned by Pi.",
    });
  });
}

test("missing credentials are not replaced and SDK failures do not disclose their cause", async (t) => {
  const { registry, provider } = await deepSeekFixture(t);
  registry.getProvider = () => ({
    ...provider,
    headers: { Authorization: "must-not-be-a-fallback" },
  });
  registry.getProviderAuth = async () => undefined;
  await assert.rejects(resolveDeepSeekHeaders(registry), /Configure DeepSeek authentication/u);
  registry.getProviderAuth = async () => {
    throw new Error("secret-manager-output");
  };
  await assert.rejects(resolveDeepSeekHeaders(registry), {
    message: "Cannot resolve DeepSeek credentials through Pi; check the provider setup.",
  });
});

test("provider lookup failures are also sanitized", async (t) => {
  const { registry } = await deepSeekFixture(t);
  registry.getProvider = () => {
    throw new Error("private-provider-configuration");
  };
  await assert.rejects(resolveDeepSeekHeaders(registry), {
    message: "Cannot resolve DeepSeek credentials through Pi; check the provider setup.",
  });
});

test("a resolved auth result without HTTP authorization gives a configuration error", async (t) => {
  const { registry } = await deepSeekFixture(t);
  registry.getProviderAuth = async () => ({ auth: {} });
  await assert.rejects(resolveDeepSeekHeaders(registry), /Configure DeepSeek authentication/u);
});

test("Anthropic prepares x-api-key for standard API keys and enforces the official origin", async (t) => {
  const { registry, provider } = await anthropicFixture(t);
  const resolved = await resolveAnthropicAuth(registry);
  assert.equal(resolved.isOAuth, false);
  assert.deepEqual(Object.fromEntries(resolved.headers), {
    "anthropic-version": "2023-06-01",
    "x-api-key": "sk-ant-api03-test-only",
  });

  registry.getProvider = () => ({ ...provider, baseUrl: "https://gateway.example.test" });
  await assert.rejects(resolveAnthropicAuth(registry), {
    message:
      "Anthropic web tools require Pi's effective auth origin to be https://api.anthropic.com.",
  });
});

test("Anthropic prepares Bearer and Claude Code headers for OAuth tokens and honors header overrides", async (t) => {
  const { registry, provider } = await anthropicFixture(t);
  registry.getProviderAuth = async () => ({
    auth: { apiKey: "sk-ant-oat01-oauth-token" },
  });
  const oauth = await resolveAnthropicAuth(registry);
  assert.equal(oauth.isOAuth, true);
  assert.deepEqual(Object.fromEntries(oauth.headers), {
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    authorization: "Bearer sk-ant-oat01-oauth-token",
    "user-agent": "claude-cli/2.1.322",
    "x-app": "cli",
  });

  // AUTH_TOKEN style header-only auth works without an apiKey field.
  registry.getProviderAuth = async () => ({
    auth: { headers: { Authorization: "Bearer auth-token-only" } },
  });
  const bearerOnly = await resolveAnthropicAuth(registry);
  assert.equal(bearerOnly.isOAuth, false);
  assert.equal(bearerOnly.headers.get("authorization"), "Bearer auth-token-only");
  assert.equal(bearerOnly.headers.get("x-api-key"), null);

  // Pi's authHeader: true supplies both apiKey and headers.Authorization; only Authorization is sent.
  registry.getProviderAuth = async () => ({
    auth: {
      apiKey: "sk-ant-api03-test",
      headers: { Authorization: "Bearer sk-ant-api03-test" },
    },
  });
  const bearerFromAuthHeader = await resolveAnthropicAuth(registry);
  assert.equal(bearerFromAuthHeader.isOAuth, false);
  assert.deepEqual(Object.fromEntries(bearerFromAuthHeader.headers), {
    "anthropic-version": "2023-06-01",
    authorization: "Bearer sk-ant-api03-test",
  });

  // Overriding an OAuth credential with an explicit x-api-key replaces Authorization and disables OAuth mode.
  registry.getProviderAuth = async () => ({
    auth: {
      apiKey: "sk-ant-oat01-oauth-token",
      headers: { "x-api-key": "sk-ant-api03-override" },
    },
  });
  const apiKeyOverride = await resolveAnthropicAuth(registry);
  assert.equal(apiKeyOverride.isOAuth, false);
  assert.deepEqual(Object.fromEntries(apiKeyOverride.headers), {
    "anthropic-version": "2023-06-01",
    "x-api-key": "sk-ant-api03-override",
  });

  // Null suppression of the only auth header fails closed; empty federation auth also fails closed.
  registry.getProvider = () => ({ ...provider, headers: { "X-Custom": "kept" } });
  registry.getProviderAuth = async () => ({
    auth: { apiKey: "sk-ant-api03-test", headers: { "x-api-key": null } },
  });
  await assert.rejects(resolveAnthropicAuth(registry), /Configure Anthropic authentication/u);

  registry.getProviderAuth = async () => ({
    auth: {},
    env: { ANTHROPIC_FEDERATION_RULE_ID: "rule-1" },
  });
  await assert.rejects(resolveAnthropicAuth(registry), /Configure Anthropic authentication/u);
});

async function providerFixture(t: TestContext, id: string, apiKey?: string) {
  const directory = await mkdtemp(join(tmpdir(), `pi-${id}-auth-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const provider = runtime.getProvider(id);
  assert.ok(provider);
  const registry: AuthRegistry = {
    getProvider: (requested) => {
      assert.equal(requested, id);
      return provider;
    },
    getProviderAuth: async (requested) => {
      assert.equal(requested, id);
      return apiKey === undefined ? undefined : { auth: { apiKey } };
    },
  };
  return { provider, registry };
}

function codexToken(claims: object): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

test("OpenAI sends API keys or Sign in with ChatGPT tokens as Bearer auth at the official origin", async (t) => {
  for (const key of ["sk-openai-test", "chatgpt-access-token"]) {
    const { registry } = await providerFixture(t, "openai", key);
    assert.deepEqual(Object.fromEntries(await resolveOpenAIHeaders(registry)), {
      authorization: `Bearer ${key}`,
    });
  }
  const { registry, provider } = await providerFixture(t, "openai", "sk-openai-test");
  registry.getProvider = () => ({ ...provider, baseUrl: "https://gateway.example.test/v1" });
  await assert.rejects(resolveOpenAIHeaders(registry), {
    message: "OpenAI web tools require Pi's effective auth origin to be https://api.openai.com.",
  });
  const missing = await providerFixture(t, "openai");
  await assert.rejects(resolveOpenAIHeaders(missing.registry), /\/login openai or OPENAI_API_KEY/u);
});

test("OpenAI Codex binds the ChatGPT token and account claim over configured headers", async (t) => {
  const token = codexToken({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  const { registry, provider } = await providerFixture(t, "openai-codex", token);
  registry.getProvider = () => ({
    ...provider,
    headers: { Authorization: "Bearer other", "chatgpt-account-id": "other", originator: "custom" },
  });
  assert.deepEqual(Object.fromEntries(await resolveOpenAICodexHeaders(registry)), {
    authorization: `Bearer ${token}`,
    "chatgpt-account-id": "acct-1",
    "openai-beta": "responses=experimental",
    originator: "custom",
  });
  registry.getProvider = () => ({
    ...provider,
    baseUrl: "https://chatgpt.example.test/backend-api",
  });
  await assert.rejects(resolveOpenAICodexHeaders(registry), /https:\/\/chatgpt\.com/u);

  for (const invalid of ["not-a-jwt", codexToken({}), codexToken({ sub: "secret-subject" })]) {
    const fixture = await providerFixture(t, "openai-codex", invalid);
    await assert.rejects(resolveOpenAICodexHeaders(fixture.registry), {
      message: "Cannot prepare OpenAI Codex authentication headers returned by Pi.",
    });
  }
  const missing = await providerFixture(t, "openai-codex");
  await assert.rejects(resolveOpenAICodexHeaders(missing.registry), /\/login openai-codex/u);
});
