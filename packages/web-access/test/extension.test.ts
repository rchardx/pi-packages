import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { fixture } from "./_server.ts";

const nativeFetch = globalThis.fetch;
const enabledFetch = JSON.stringify({ fetch: { provider: "deepseek" } });

async function loadSession(
  t: TestContext,
  tools?: string[],
  config?: string,
  modelsConfig?: object,
) {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network call");
  });
  const directory = await mkdtemp(join(tmpdir(), "pi-web-extension-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  if (config !== undefined) await writeFile(join(directory, "web-access.json"), config);
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  const modelsPath = modelsConfig ? join(directory, "models.json") : null;
  if (modelsPath) await writeFile(modelsPath, JSON.stringify(modelsConfig));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader: loader,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(directory),
    ...(tools ? { tools } : {}),
  });
  t.after(() => session.dispose());
  if (tools) assert.deepEqual(session.getActiveToolNames(), tools);
  return { session, directory, modelRuntime, loader };
}

test("Pi loads hosted fetch, requires independent consent, and resolves credentials per invocation", async (t) => {
  const { session, directory, modelRuntime } = await loadSession(
    t,
    ["web_fetch"],
    JSON.stringify({ search: { provider: "deepseek" } }),
  );
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(tool);
  for (const args of [
    { url: "https://example.test" },
    { url: `https://example.test/${"x".repeat(3000)}` },
  ]) {
    assert.equal(Check(tool.parameters, args), true);
  }
  for (const args of [
    {},
    { url: "" },
    { url: "x".repeat(8193) },
    { url: "https://example.test", apiKey: "not-allowed" },
  ]) {
    assert.equal(Check(tool.parameters, args), false);
  }
  let expectedKey = "sdk-fetch-key-1";
  let calls = 0;
  const { server } = await fixture(t, (incoming, reply) => {
    assert.equal(incoming.url, "/v1/tools/fetch");
    assert.equal(incoming.method, "POST");
    assert.equal(incoming.headers.authorization, `Bearer ${expectedKey}`);
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
        url: "https://example.test/guide",
      });
      reply.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          title: "SDK fixture",
          content: "# Hosted Markdown\n\nProvider content.",
        }),
      );
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/v1/tools/fetch");
    return nativeFetch(`http://127.0.0.1:${address.port}/v1/tools/fetch`, init);
  });
  const resolveAuth = t.mock.method(modelRuntime, "getAuth");
  // Search consent and explicit fetch tool selection do not authorize fetching.
  await assert.rejects(
    tool.execute("disabled", { url: "https://example.test/guide" }),
    /Fetch is disabled/u,
  );
  assert.equal(resolveAuth.mock.callCount(), 0);
  await writeFile(join(directory, "web-access.json"), enabledFetch);
  await assert.rejects(
    tool.execute("missing-key", { url: "https://example.test/guide" }),
    /Configure DeepSeek authentication/u,
  );
  assert.equal(calls, 0);
  await modelRuntime.setRuntimeApiKey("deepseek", expectedKey);
  const result = await tool.execute("sdk-success", {
    url: "https://EXAMPLE.test:443/guide#section",
  });
  const content = result.content[0];
  assert.ok(content?.type === "text");
  assert.match(content.text, /SDK fixture/u);
  assert.match(content.text, /# Hosted Markdown/u);
  expectedKey = "sdk-fetch-key-2";
  await modelRuntime.setRuntimeApiKey("deepseek", expectedKey);
  await tool.execute("second", { url: "https://example.test/guide" });
  assert.equal(calls, 2);
  assert.equal(resolveAuth.mock.callCount(), 3);
  await writeFile(
    join(directory, "web-access.json"),
    JSON.stringify({ search: { provider: "deepseek" } }),
  );
  await assert.rejects(
    tool.execute("revoked", { url: "https://example.test/guide" }),
    /Fetch is disabled/u,
  );
  assert.equal(resolveAuth.mock.callCount(), 3);
  assert.equal(calls, 2);
});

test("fetch consent does not authorize search, and revocation blocks an explicitly selected tool", async (t) => {
  const { session, directory, modelRuntime } = await loadSession(
    t,
    ["web_fetch", "web_search"],
    enabledFetch,
  );
  await modelRuntime.setRuntimeApiKey("deepseek", "test-key");
  const resolveAuth = t.mock.method(modelRuntime, "getAuth");
  const search = session.agent.state.tools.find((tool) => tool.name === "web_search");
  const fetch = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(search && fetch);
  await assert.rejects(search.execute("disabled", { query: "API" }), /Search is disabled/u);
  await writeFile(join(directory, "web-access.json"), "{}");
  await assert.rejects(
    fetch.execute("disabled", { url: "https://example.test" }),
    /Fetch is disabled/u,
  );
  assert.equal(resolveAuth.mock.callCount(), 0);
});

test("fetch defaults active only after its own opt-in and reload", async (t) => {
  const { session, directory } = await loadSession(t);
  assert.ok(!session.getActiveToolNames().includes("web_fetch"));
  assert.ok(!session.getActiveToolNames().includes("web_search"));
  assert.doesNotMatch(session.systemPrompt, /web_fetch|DeepSeek/u);
  await writeFile(join(directory, "web-access.json"), enabledFetch);
  await session.reload();
  assert.ok(session.getActiveToolNames().includes("web_fetch"));
  assert.ok(!session.getActiveToolNames().includes("web_search"));
  assert.match(session.systemPrompt, /web_fetch discloses the URL to DeepSeek/u);
});

test("Pi search requires opt-in before resolving credentials and supports the environment key", async (t) => {
  const { session, directory, modelRuntime } = await loadSession(t, ["web_search"]);
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_search");
  assert.ok(tool);
  process.env.DEEPSEEK_API_KEY = "sdk-test-only-key";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(init?.body, '{"query":"SDK search","count":10,"need_content":true}');
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sdk-test-only-key");
    return Response.json({
      results: [
        {
          title: "SDK result",
          url: "https://example.test/result",
          summary: "Provider search summary.",
          snippet: "Short snippet.",
          content: "Provider page content.",
          site_name: null,
          date: null,
        },
      ],
    });
  });
  const resolveAuth = t.mock.method(modelRuntime, "getAuth");
  // Explicit tool selection and a key do not authorize reading credentials or sending queries.
  await assert.rejects(tool.execute("disabled", { query: "SDK search" }), /Search is disabled/u);
  assert.equal(resolveAuth.mock.callCount(), 0);
  await writeFile(
    join(directory, "web-access.json"),
    JSON.stringify({ search: { provider: "deepseek" } }),
  );
  delete process.env.DEEPSEEK_API_KEY;
  await assert.rejects(tool.execute("missing-key", { query: "SDK search" }), /DEEPSEEK_API_KEY/u);
  assert.equal(calls, 0);
  process.env.DEEPSEEK_API_KEY = "sdk-test-only-key";
  const result = await tool.execute("search", { query: "SDK search", need_content: true });
  const text = result.content[0];
  assert.ok(text?.type === "text");
  assert.match(text.text, /SDK result/u);
  assert.match(text.text, /Provider page content/u);
  assert.equal(calls, 1);
  assert.equal(resolveAuth.mock.callCount(), 2);
  await assert.rejects(tool.execute("long-query", { query: "x".repeat(129) }), /1–128 Unicode/u);
  await writeFile(join(directory, "web-access.json"), "{}");
  await assert.rejects(tool.execute("revoked", { query: "SDK search" }), /Search is disabled/u);
  assert.equal(resolveAuth.mock.callCount(), 2);
  assert.equal(calls, 1);
});

const enabledSearch = JSON.stringify({ search: { provider: "deepseek" } });

test("the registered search schema declares the argument constraints enforced by Pi", async (t) => {
  const { session } = await loadSession(t, ["web_search"], enabledSearch);
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_search");
  assert.ok(tool);
  for (const args of [
    { query: "API" },
    { query: "API", count: 1 },
    { query: "API", count: 50, need_content: true },
  ])
    assert.equal(Check(tool.parameters, args), true);
  for (const args of [
    {},
    { query: "" },
    { query: null },
    { query: "API", count: 0 },
    { query: "API", count: -1 },
    { query: "API", count: 51 },
    { query: "API", count: 1.5 },
    { query: "API", count: "10" },
    { query: "API", need_content: "true" },
    { query: "API", provider: "other" },
  ])
    assert.equal(Check(tool.parameters, args), false, JSON.stringify(args));
});

test("default visibility omits search metadata until enabled and reloaded", async (t) => {
  const { session, directory } = await loadSession(t);
  assert.ok(!session.getActiveToolNames().includes("web_fetch"));
  assert.ok(!session.getActiveToolNames().includes("web_search"));
  assert.doesNotMatch(session.systemPrompt, /web_search|DeepSeek|provider summaries/u);
  assert.ok(!session.agent.state.tools.some((tool) => tool.name === "web_search"));
  await writeFile(join(directory, "web-access.json"), enabledSearch);
  await session.reload();
  assert.ok(session.getActiveToolNames().includes("web_search"));
  assert.ok(!session.getActiveToolNames().includes("web_fetch"));
  assert.match(session.systemPrompt, /web_search|DeepSeek/u);
  assert.match(session.systemPrompt, /provider summaries are not verified quotations/u);
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_search");
  assert.ok(tool);
  await writeFile(join(directory, "web-access.json"), "{}");
  await assert.rejects(tool.execute("revoked", { query: "API" }), /Search is disabled/u);
});

test("configured search defaults to active without overriding an explicit fetch-only tool set", async (t) => {
  const { session } = await loadSession(t, ["web_fetch"], enabledSearch);
  assert.doesNotMatch(session.systemPrompt, /web_search|provider summaries/u);
});

test("malformed configuration prevents both tools from loading until fixed", async (t) => {
  const { session, directory, loader } = await loadSession(t);
  await writeFile(join(directory, "web-access.json"), '{"search":false}');
  await session.reload();
  assert.equal(loader.getExtensions().errors.length, 1);
  assert.match(loader.getExtensions().errors[0]?.error ?? "", /Invalid web access configuration/u);
  assert.ok(!session.getAllTools().some((tool) => ["web_fetch", "web_search"].includes(tool.name)));
  await writeFile(join(directory, "web-access.json"), enabledFetch);
  await session.reload();
  assert.ok(session.getActiveToolNames().includes("web_fetch"));
});

test("search uses Pi runtime credentials without an env key and resolves them again per call", async (t) => {
  const { session, modelRuntime } = await loadSession(t, undefined, enabledSearch);
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_search");
  assert.ok(tool);
  assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer runtime-key-${calls}`);
    return Response.json({ results: [] });
  });
  await modelRuntime.setRuntimeApiKey("deepseek", "runtime-key-1");
  await tool.execute("first", { query: "API" });
  await modelRuntime.setRuntimeApiKey("deepseek", "runtime-key-2");
  await tool.execute("second", { query: "API" });
  assert.equal(calls, 2);
});

test("search honors Pi login credentials and precedence, then stops after logout without another key", async (t) => {
  const { session, modelRuntime } = await loadSession(t, ["web_search"], enabledSearch);
  await modelRuntime.login("deepseek", "api_key", {
    prompt: async () => "stored-test-only-key",
    notify: () => {},
  });
  process.env.DEEPSEEK_API_KEY = "environment-test-only-key";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer stored-test-only-key");
    return Response.json({ results: [] });
  });
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_search");
  assert.ok(tool);
  await tool.execute("stored-key", { query: "API" });
  delete process.env.DEEPSEEK_API_KEY;
  await modelRuntime.logout("deepseek");
  await assert.rejects(
    tool.execute("logged-out", { query: "API" }),
    /Configure DeepSeek authentication/u,
  );
  assert.equal(calls, 1);
});

test("SDK effective gateway auth is rejected before sending a request", async (t) => {
  const { session, modelRuntime } = await loadSession(t, ["web_search"], enabledSearch);
  modelRuntime.registerProvider("deepseek", { baseUrl: "https://gateway.example.test/v1" });
  await modelRuntime.setRuntimeApiKey("deepseek", "gateway-only-key");
  const resolveAuth = t.mock.method(modelRuntime, "getAuth");
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_search");
  assert.ok(tool);
  await assert.rejects(tool.execute("gateway", { query: "API" }), /effective auth origin/u);
  assert.equal(resolveAuth.mock.callCount(), 1);
});

for (const baseUrl of [
  "https://api.deepseek.com/beta",
  "https://api.deepseek.com/anthropic",
  "https://test-user:test-password@api.deepseek.com/v1",
]) {
  test(`SDK base ${baseUrl}, mixed model routes, and custom auth headers work at the fixed search endpoint`, async (t) => {
    const { session, modelRuntime } = await loadSession(t, ["web_search"], enabledSearch, {
      providers: {
        deepseek: {
          baseUrl,
          headers: { authorization: "Bearer sdk-header-key", "X-Custom": "sdk-header-value" },
          models: [{ id: "gateway-chat-model", baseUrl: "https://gateway.example.test/v1" }],
        },
      },
    });
    await modelRuntime.setRuntimeApiKey("deepseek", "sdk-default-key");
    assert.equal(modelRuntime.getError(), undefined);
    assert.ok(
      modelRuntime
        .getProvider("deepseek")
        ?.getModels()
        .some((model) => model.baseUrl === "https://gateway.example.test/v1"),
    );
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
      calls++;
      assert.equal(url, "https://api.deepseek.com/v1/tools/search");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
        authorization: "Bearer sdk-header-key",
        "content-type": "application/json",
        "x-custom": "sdk-header-value",
      });
      return Response.json({ results: [] });
    });
    const tool = session.agent.state.tools.find((tool) => tool.name === "web_search");
    assert.ok(tool);
    await tool.execute("custom-auth", { query: "API" });
    assert.equal(calls, 1);
  });
}

test("SDK global diagnostics do not override usable provider auth", async (t) => {
  const { session, modelRuntime } = await loadSession(t, ["web_search"], enabledSearch, {
    providers: { unrelated: { baseUrl: 42 } },
  });
  assert.match(modelRuntime.getError() ?? "", /Invalid models.json schema/u);
  await modelRuntime.setRuntimeApiKey("deepseek", "sdk-test-only-key");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sdk-test-only-key");
    return Response.json({ results: [] });
  });
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_search");
  assert.ok(tool);
  await tool.execute("upstream-diagnostic", { query: "API" });
  assert.equal(calls, 1);
});

test("SDK credential resolution failures are sanitized and never fall back to the environment", async (t) => {
  const { session, modelRuntime } = await loadSession(t, ["web_search"], enabledSearch);
  process.env.DEEPSEEK_API_KEY = "must-not-be-used";
  t.mock.method(modelRuntime, "getAuth", async () => {
    throw new Error("credential-value-from-sdk");
  });
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_search");
  assert.ok(tool);
  await assert.rejects(tool.execute("auth-error", { query: "API" }), {
    message: "Cannot resolve DeepSeek credentials through Pi; check the provider setup.",
  });
});

test("hosted fetch honors Pi environment and login precedence, then stops without credentials", async (t) => {
  const { session, modelRuntime } = await loadSession(t, undefined, enabledFetch);
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(tool);
  process.env.DEEPSEEK_API_KEY = "environment-fetch-key";
  let expected = "environment-fetch-key";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/v1/tools/fetch");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${expected}`);
    return Response.json({ title: "Page", content: "Provider content" });
  });
  await tool.execute("environment", { url: "https://example.test" });
  await modelRuntime.login("deepseek", "api_key", {
    prompt: async () => "stored-fetch-key",
    notify: () => {},
  });
  expected = "stored-fetch-key";
  await tool.execute("login", { url: "https://example.test" });
  await modelRuntime.logout("deepseek");
  expected = "environment-fetch-key";
  await tool.execute("environment-again", { url: "https://example.test" });
  delete process.env.DEEPSEEK_API_KEY;
  await assert.rejects(
    tool.execute("no-credentials", { url: "https://example.test" }),
    /Configure DeepSeek authentication/u,
  );
  assert.equal(calls, 3);
});

test("hosted fetch uses Pi headers at the fixed endpoint and rejects an effective gateway", async (t) => {
  const { session, modelRuntime } = await loadSession(t, undefined, enabledFetch, {
    providers: {
      deepseek: {
        baseUrl: "https://api.deepseek.com/beta",
        headers: { authorization: "Custom fetch auth", "X-Custom": "value" },
      },
    },
  });
  await modelRuntime.setRuntimeApiKey("deepseek", "default-key");
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(tool);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/v1/tools/fetch");
    assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
      authorization: "Custom fetch auth",
      "x-custom": "value",
      "content-type": "application/json",
    });
    return Response.json({ title: "Page", content: "Provider content" });
  });
  await tool.execute("headers", { url: "https://example.test" });
  modelRuntime.registerProvider("deepseek", { baseUrl: "https://gateway.example.test/v1" });
  await assert.rejects(
    tool.execute("gateway", { url: "https://example.test" }),
    /effective auth origin/u,
  );
  assert.equal(calls, 1);
});
