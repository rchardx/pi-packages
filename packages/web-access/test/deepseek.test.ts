import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveDeepSeekHeaders } from "../src/deepseek.ts";

type Registry = Parameters<typeof resolveDeepSeekHeaders>[0];

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-search-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const provider = runtime.getProvider("deepseek");
  assert.ok(provider);
  const registry: Registry = {
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
  test(`accepts the official effective origin regardless of base path: ${baseUrl}`, async (t) => {
    const { registry, provider } = await fixture(t);
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
    test(`rejects a mismatched ${source} origin without exposing the route`, async (t) => {
      const { registry, provider } = await fixture(t);
      if (source === "provider") registry.getProvider = () => ({ ...provider, baseUrl });
      else registry.getProviderAuth = async () => ({ auth: { apiKey: "test-only-key", baseUrl } });
      await assert.rejects(resolveDeepSeekHeaders(registry), {
        message:
          "DeepSeek web tools require Pi's effective auth origin to be https://api.deepseek.com.",
      });
    });
  }
}

test("an explicit auth origin is sufficient without provider defaults, but an unknown origin is not", async (t) => {
  const { registry } = await fixture(t);
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
  const { registry, provider } = await fixture(t);
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
  const { registry, provider } = await fixture(t);
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

test("Pi's Authorization header overrides the default bearer key and works without an apiKey field", async (t) => {
  const { registry, provider } = await fixture(t);
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
  const { registry } = await fixture(t);
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
    const { registry } = await fixture(t);
    registry.getProviderAuth = async () => ({ auth });
    await assert.rejects(resolveDeepSeekHeaders(registry), {
      message: "Cannot prepare DeepSeek authentication headers returned by Pi.",
    });
  });
}

test("missing credentials are not replaced and SDK failures do not disclose their cause", async (t) => {
  const { registry, provider } = await fixture(t);
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
  const { registry } = await fixture(t);
  registry.getProvider = () => {
    throw new Error("private-provider-configuration");
  };
  await assert.rejects(resolveDeepSeekHeaders(registry), {
    message: "Cannot resolve DeepSeek credentials through Pi; check the provider setup.",
  });
});

test("a resolved auth result without HTTP authorization gives a configuration error", async (t) => {
  const { registry } = await fixture(t);
  registry.getProviderAuth = async () => ({ auth: {} });
  await assert.rejects(resolveDeepSeekHeaders(registry), /Configure DeepSeek authentication/u);
});
