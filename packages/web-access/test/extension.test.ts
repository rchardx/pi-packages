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
const enabledFetch = JSON.stringify({
  fetch: { providers: { deepseek: {} }, defaultProvider: "deepseek" },
});
const enabledSearch = JSON.stringify({
  search: { providers: { deepseek: {} }, defaultProvider: "deepseek" },
});

async function loadSession(
  t: TestContext,
  tools?: string[],
  config?: string,
  modelsConfig?: object,
) {
  const previousDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const previousAnthropicToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const previousAnthropicOAuth = process.env.ANTHROPIC_OAUTH_TOKEN;
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  t.after(() => {
    if (previousDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousDeepSeekKey;
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    if (previousAnthropicToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previousAnthropicToken;
    if (previousAnthropicOAuth === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
    else process.env.ANTHROPIC_OAUTH_TOKEN = previousAnthropicOAuth;
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiKey;
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
  const { session, directory, modelRuntime } = await loadSession(t, ["web_fetch"], enabledSearch);
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
  await writeFile(join(directory, "web-access.json"), enabledSearch);
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
  assert.doesNotMatch(session.systemPrompt, /web_fetch|hosted provider/u);
  await writeFile(join(directory, "web-access.json"), enabledFetch);
  await session.reload();
  assert.ok(session.getActiveToolNames().includes("web_fetch"));
  assert.ok(!session.getActiveToolNames().includes("web_search"));
  assert.match(session.systemPrompt, /web_fetch sends the URL to a hosted provider/u);
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
  await writeFile(join(directory, "web-access.json"), enabledSearch);
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
  assert.match(session.systemPrompt, /web_search sends the query to a hosted provider/u);
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_search");
  assert.ok(tool);
  // Provider-specific limits are reported by the selected provider, not advertised to every model.
  assert.doesNotMatch(
    `${tool.description}${JSON.stringify(tool.parameters)}${session.systemPrompt}`,
    /DeepSeek|Anthropic|OpenAI|Gemini/u,
  );
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

test("routes dynamically by active model across DeepSeek and Anthropic without cross-provider fallback", async (t) => {
  const dualConfig = JSON.stringify({
    search: {
      providers: {
        deepseek: {},
        anthropic: { model: "claude-haiku-4-5" },
      },
      defaultProvider: "deepseek",
    },
    fetch: {
      providers: {
        anthropic: {},
      },
    },
  });
  const { session, modelRuntime } = await loadSession(t, ["web_search", "web_fetch"], dualConfig);
  await modelRuntime.setRuntimeApiKey("deepseek", "deepseek-runtime-key");
  await modelRuntime.setRuntimeApiKey("anthropic", "sk-ant-oat01-runtime-oauth");
  await modelRuntime.setRuntimeApiKey("openai", "sk-openai-key");

  const search = session.agent.state.tools.find((tool) => tool.name === "web_search");
  const fetchTool = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(search && fetchTool);

  const anthropicModel = modelRuntime.getProvider("anthropic")?.getModels()[0];
  const deepseekModel = modelRuntime.getProvider("deepseek")?.getModels()[0];
  const openaiModel = modelRuntime.getProvider("openai")?.getModels()[0];
  assert.ok(anthropicModel && deepseekModel && openaiModel);

  const seenUrls: string[] = [];
  let failAnthropic = false;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    seenUrls.push(String(url));
    if (url === "https://api.anthropic.com/v1/messages") {
      if (failAnthropic) return new Response("rate limited", { status: 429 });
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer sk-ant-oat01-runtime-oauth");
      assert.equal(headers.get("anthropic-beta"), "claude-code-20250219,oauth-2025-04-20");
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        tools: Array<{ name: string }>;
      };
      if (body.tools[0]?.name === "web_search") {
        assert.equal(body.model, "claude-haiku-4-5");
        return Response.json({
          stop_reason: "end_turn",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "srv_1",
              content: [
                {
                  type: "web_search_result",
                  title: "Anthropic result",
                  url: "https://example.test/anthropic",
                  page_age: null,
                },
              ],
            },
            { type: "text", text: "Grounded by Anthropic." },
          ],
        });
      }
      assert.equal(body.model, "claude-haiku-5-5");
      return Response.json({
        stop_reason: "end_turn",
        content: [
          {
            type: "web_fetch_tool_result",
            tool_use_id: "srv_2",
            content: {
              type: "web_fetch_result",
              url: "https://example.test/page",
              content: {
                type: "document",
                title: "Fetched via Anthropic",
                source: {
                  type: "text",
                  media_type: "text/plain",
                  data: "Anthropic page body.",
                },
              },
            },
          },
        ],
      });
    }
    assert.equal(url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer deepseek-runtime-key");
    return Response.json({
      results: [
        {
          title: "DeepSeek result",
          url: "https://example.test/deepseek",
          summary: "DeepSeek summary.",
          snippet: "",
          content: "",
          site_name: null,
          date: null,
        },
      ],
    });
  });

  // Active Anthropic model routes both search and fetch to Anthropic.
  await session.setModel(anthropicModel);
  const anthropicSearch = await search.execute("s-anthropic", { query: "test query" });
  assert.equal(anthropicSearch.details.provider, "anthropic");
  const anthropicFetch = await fetchTool.execute("f-anthropic", {
    url: "https://example.test/page",
  });
  assert.equal(anthropicFetch.details.provider, "anthropic");

  // Anthropic failure never falls back to DeepSeek even though defaultProvider is deepseek.
  failAnthropic = true;
  await assert.rejects(
    search.execute("s-anthropic-429", { query: "test query" }),
    /Anthropic Search HTTP 429/u,
  );
  assert.deepEqual(seenUrls, [
    "https://api.anthropic.com/v1/messages",
    "https://api.anthropic.com/v1/messages",
    "https://api.anthropic.com/v1/messages",
  ]);
  failAnthropic = false;

  // Switching active model to OpenAI (not in search.providers) uses defaultProvider ("deepseek")
  // for search, and fails closed without resolving credentials for fetch (no defaultProvider).
  await session.setModel(openaiModel);
  const fallbackDefault = await search.execute("s-default", { query: "test query" });
  assert.equal(fallbackDefault.details.provider, "deepseek");

  const resolveAuth = t.mock.method(modelRuntime, "getAuth");
  await assert.rejects(
    fetchTool.execute("f-unenabled", { url: "https://example.test/page" }),
    /Active model provider "openai" is not enabled in fetch\.providers/u,
  );
  assert.equal(resolveAuth.mock.callCount(), 0);

  // Switching active model to DeepSeek routes search directly to DeepSeek.
  await session.setModel(deepseekModel);
  const directDeepSeek = await search.execute("s-deepseek", { query: "test query" });
  assert.equal(directDeepSeek.details.provider, "deepseek");
});

test("SDK authHeader: true on Anthropic sends only Bearer Authorization without duplicate x-api-key", async (t) => {
  const { session, modelRuntime } = await loadSession(
    t,
    undefined,
    JSON.stringify({ fetch: { providers: { anthropic: {} }, defaultProvider: "anthropic" } }),
    {
      providers: {
        anthropic: {
          authHeader: true,
        },
      },
    },
  );
  await modelRuntime.setRuntimeApiKey("anthropic", "sk-ant-api03-bearer-test");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer sk-ant-api03-bearer-test");
    assert.equal(headers.get("x-api-key"), null);
    assert.equal(headers.get("anthropic-beta"), null);
    return Response.json({
      stop_reason: "end_turn",
      content: [
        {
          type: "web_fetch_tool_result",
          tool_use_id: "srv_auth_header",
          content: {
            type: "web_fetch_result",
            url: "https://example.test/auth",
            content: {
              type: "document",
              title: "Auth Header Page",
              source: {
                type: "text",
                media_type: "text/plain",
                data: "Authenticated with Bearer only.",
              },
            },
          },
        },
      ],
    });
  });
  const fetchTool = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(fetchTool);
  const result = await fetchTool.execute("f-auth-header", { url: "https://example.test/auth" });
  assert.equal(calls, 1);
  const first = result.content[0];
  assert.equal(first?.type, "text");
  assert.match(first.text, /Authenticated with Bearer only\./u);
});

function sse(events: object[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

test("Pi routes search to OpenAI and OpenAI Codex by active model with their own credentials", async (t) => {
  const config = JSON.stringify({
    search: { providers: { openai: {}, "openai-codex": { model: "gpt-6-sol" } } },
  });
  const claims = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } }),
  ).toString("base64url");
  const codexToken = `header.${claims}.signature`;
  // The Codex provider is OAuth-only; a configured key stands in for a ChatGPT login.
  const { session, modelRuntime } = await loadSession(t, ["web_search"], config, {
    providers: { "openai-codex": { apiKey: codexToken } },
  });
  await modelRuntime.setRuntimeApiKey("openai", "sk-openai-runtime-key");
  await modelRuntime.setRuntimeApiKey("deepseek", "deepseek-runtime-key");
  const openaiModel = modelRuntime.getProvider("openai")?.getModels()[0];
  const codexModel = modelRuntime.getProvider("openai-codex")?.getModels()[0];
  const deepseekModel = modelRuntime.getProvider("deepseek")?.getModels()[0];
  assert.ok(openaiModel && codexModel && deepseekModel);
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    seen.push(String(url));
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as { model: string; stream: boolean };
    assert.equal(body.stream, true);
    if (url === "https://api.openai.com/v1/responses") {
      assert.equal(headers.get("authorization"), "Bearer sk-openai-runtime-key");
      assert.equal(body.model, "gpt-6-luna");
    } else {
      assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(headers.get("authorization"), `Bearer ${codexToken}`);
      assert.equal(headers.get("chatgpt-account-id"), "acct-test");
      assert.equal(body.model, "gpt-6-sol");
    }
    return sse([
      {
        type: "response.output_item.done",
        item: { type: "web_search_call", status: "completed", action: { type: "search" } },
      },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Grounded.", annotations: [] }],
        },
      },
      { type: "response.completed", response: { status: "completed" } },
    ]);
  });
  const search = session.agent.state.tools.find((tool) => tool.name === "web_search");
  assert.ok(search);
  await session.setModel(openaiModel);
  assert.equal((await search.execute("openai", { query: "test" })).details.provider, "openai");
  await session.setModel(codexModel);
  assert.equal((await search.execute("codex", { query: "test" })).details.provider, "openai-codex");
  // No defaultProvider: an unrelated active model fails before resolving credentials.
  await session.setModel(deepseekModel);
  await assert.rejects(
    search.execute("deepseek", { query: "test" }),
    /Active model provider "deepseek" is not enabled in search\.providers/u,
  );
  assert.deepEqual(seen, [
    "https://api.openai.com/v1/responses",
    "https://chatgpt.com/backend-api/codex/responses",
  ]);
});

test("Pi routes fetch to Google with the Gemini key from Pi", async (t) => {
  const config = JSON.stringify({
    fetch: { providers: { google: { model: "gemini-3.5-flash" } }, defaultProvider: "google" },
  });
  const { session } = await loadSession(t, ["web_fetch"], config);
  process.env.GEMINI_API_KEY = "gemini-environment-key";
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    seen.push(String(url));
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "gemini-environment-key");
    return Response.json({
      candidates: [
        {
          content: { parts: [{ text: "Page content." }] },
          finishReason: "STOP",
          urlContextMetadata: {
            urlMetadata: [{ urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }],
          },
        },
      ],
    });
  });
  const fetchTool = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(fetchTool);
  const result = await fetchTool.execute("f", { url: "https://example.test/page" });
  assert.equal(result.details.provider, "google");
  assert.deepEqual(seen, [
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
  ]);
});
