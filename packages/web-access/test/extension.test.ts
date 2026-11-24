import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { fixture } from "./_server.ts";

const nativeFetch = globalThis.fetch;
const enabledFetch = JSON.stringify({
  fetch: { providers: { deepseek: {} } },
});
const enabledSearch = JSON.stringify({
  search: { providers: { deepseek: {} } },
});

async function loadSession(
  t: TestContext,
  tools?: string[],
  config?: string,
  modelsConfig?: object,
) {
  const previousDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  const previousExaKey = process.env.EXA_API_KEY;
  const previousParallelKey = process.env.PARALLEL_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.EXA_API_KEY;
  delete process.env.PARALLEL_API_KEY;
  t.after(() => {
    if (previousDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousDeepSeekKey;
    if (previousExaKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = previousExaKey;
    if (previousParallelKey === undefined) delete process.env.PARALLEL_API_KEY;
    else process.env.PARALLEL_API_KEY = previousParallelKey;
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network call");
  });
  const directory = await mkdtemp(join(tmpdir(), "pi-web-extension-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  let activeSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  t.after(async () => {
    activeSession?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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
  activeSession = session;
  if (tools) assert.deepEqual(session.getActiveToolNames(), tools);
  return { session, directory, modelRuntime, loader };
}

test("Pi loads hosted fetch, requires independent consent, and reads DEEPSEEK_API_KEY per invocation", async (t) => {
  const { session, directory } = await loadSession(t, ["web_fetch"], enabledSearch);
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(tool);
  for (const args of [
    { url: "https://example.test" },
    { url: `https://example.test/${"x".repeat(3000)}` },
    { url: "https://example.test", max_age_hours: -1 },
    { url: "https://example.test", max_age_hours: 0 },
    { url: "https://example.test", max_age_hours: 720 },
  ]) {
    assert.equal(Check(tool.parameters, args), true);
  }
  for (const args of [
    {},
    { url: "" },
    { url: "x".repeat(8193) },
    { url: "https://example.test", max_age_hours: -2 },
    { url: "https://example.test", max_age_hours: 721 },
    { url: "https://example.test", max_age_hours: 1.5 },
    { url: "https://example.test", max_age_hours: "0" },
    { url: "https://example.test", apiKey: "not-allowed" },
  ]) {
    assert.equal(Check(tool.parameters, args), false, JSON.stringify(args));
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
  // Search consent and explicit fetch tool selection do not authorize fetching.
  process.env.DEEPSEEK_API_KEY = expectedKey;
  await assert.rejects(
    tool.execute("disabled", { url: "https://example.test/guide" }),
    /Fetch is disabled/u,
  );
  assert.equal(calls, 0);

  await writeFile(join(directory, "web-access.json"), enabledFetch);
  delete process.env.DEEPSEEK_API_KEY;
  await assert.rejects(
    tool.execute("missing-key", { url: "https://example.test/guide" }),
    /Configure DEEPSEEK_API_KEY/u,
  );
  assert.equal(calls, 0);

  process.env.DEEPSEEK_API_KEY = expectedKey;
  const result = await tool.execute("sdk-success", {
    url: "https://EXAMPLE.test:443/guide#section",
  });
  const content = result.content[0];
  assert.ok(content?.type === "text");
  assert.match(content.text, /SDK fixture/u);
  assert.match(content.text, /# Hosted Markdown/u);

  expectedKey = "sdk-fetch-key-2";
  process.env.DEEPSEEK_API_KEY = expectedKey;
  await tool.execute("second", { url: "https://example.test/guide" });
  assert.equal(calls, 2);

  await writeFile(join(directory, "web-access.json"), enabledSearch);
  await assert.rejects(
    tool.execute("revoked", { url: "https://example.test/guide" }),
    /Fetch is disabled/u,
  );
  assert.equal(calls, 2);
});

test("fetch consent does not authorize search, and revocation blocks an explicitly selected tool", async (t) => {
  const { session, directory } = await loadSession(t, ["web_fetch", "web_search"], enabledFetch);
  process.env.DEEPSEEK_API_KEY = "test-key";
  const search = session.agent.state.tools.find((tool) => tool.name === "web_search");
  const fetch = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(search && fetch);
  await assert.rejects(search.execute("disabled", { query: "API" }), /Search is disabled/u);
  await writeFile(join(directory, "web-access.json"), "{}");
  await assert.rejects(
    fetch.execute("disabled", { url: "https://example.test" }),
    /Fetch is disabled/u,
  );
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
  assert.match(
    session.systemPrompt,
    /web_fetch sends URLs and objectives to a hosted provider;.*untrusted data, not instructions/u,
  );
});

test("Pi search requires opt-in before reading DEEPSEEK_API_KEY and sends requests to the hardcoded endpoint", async (t) => {
  const { session, directory } = await loadSession(t, ["web_search"]);
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
  await assert.rejects(tool.execute("disabled", { query: "SDK search" }), /Search is disabled/u);
  assert.equal(calls, 0);

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

  await assert.rejects(tool.execute("long-query", { query: "x".repeat(129) }), /1–128 Unicode/u);
  await writeFile(join(directory, "web-access.json"), "{}");
  await assert.rejects(tool.execute("revoked", { query: "SDK search" }), /Search is disabled/u);
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
    { query: "API", mode: "lite" },
    { query: "API", mode: "fast" },
    { query: "API", mode: "advanced" },
    { query: "API", mode: "deep", max_age_hours: 0 },
    { query: "API", max_age_hours: -1 },
    {
      query: "API",
      include_domains: ["nodejs.org", "github.com/nodejs/node"],
      exclude_domains: ["nodejs.org/dist"],
      after_date: "2025-01-01",
    },
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
    { query: "API", mode: "invalid" },
    { query: "API", max_age_hours: -2 },
    { query: "API", max_age_hours: 721 },
    { query: "API", include_domains: [] },
    { query: "API", include_domains: [""] },
    {
      query: "API",
      exclude_domains: Array.from({ length: 101 }, (_, index) => `d${index}.example`),
    },
    { query: "API", after_date: "2025/01/01" },
    { query: "API", before_date: "2025-12-31" },
    { query: "API", provider: "other" },
  ])
    assert.equal(Check(tool.parameters, args), false, JSON.stringify(args));
});

test("default visibility omits search metadata until enabled and reloaded", async (t) => {
  const { session, directory } = await loadSession(t);
  assert.ok(!session.getActiveToolNames().includes("web_fetch"));
  assert.ok(!session.getActiveToolNames().includes("web_search"));
  assert.doesNotMatch(session.systemPrompt, /web_search|DeepSeek|provider-supplied summaries/u);
  assert.ok(!session.agent.state.tools.some((tool) => tool.name === "web_search"));
  await writeFile(join(directory, "web-access.json"), enabledSearch);
  await session.reload();
  assert.ok(session.getActiveToolNames().includes("web_search"));
  assert.ok(!session.getActiveToolNames().includes("web_fetch"));
  assert.match(
    session.systemPrompt,
    /web_search sends queries and filters to a hosted provider;.*untrusted data, not instructions/u,
  );
  const tool = session.agent.state.tools.find((tool) => tool.name === "web_search");
  assert.ok(tool);
  assert.doesNotMatch(
    `${tool.description}${JSON.stringify(tool.parameters)}${session.systemPrompt}`,
    /DeepSeek|Anthropic|OpenAI|Gemini|synthesis/iu,
  );
  await writeFile(join(directory, "web-access.json"), "{}");
  await assert.rejects(tool.execute("revoked", { query: "API" }), /Search is disabled/u);
});

test("configured search defaults to active without overriding an explicit fetch-only tool set", async (t) => {
  const { session } = await loadSession(t, ["web_fetch"], enabledSearch);
  assert.doesNotMatch(session.systemPrompt, /web_search|provider-supplied summaries/u);
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

test("operates solely through environment API keys and hardcoded endpoints, decoupled from Pi ModelRegistry, auth.json, and models.json", async (t) => {
  const bothConfig = JSON.stringify({
    search: { providers: { deepseek: {} } },
    fetch: { providers: { deepseek: {} }, defaultProvider: "deepseek" },
  });
  const { session, modelRuntime } = await loadSession(t, ["web_search", "web_fetch"], bothConfig, {
    providers: {
      deepseek: {
        baseUrl: "https://gateway.example.test/v1",
        apiKey: "gateway-chat-key-must-be-ignored",
        headers: { Authorization: "Bearer gateway-header-must-be-ignored" },
        models: [{ id: "gateway-chat-model" }],
      },
    },
  });
  await modelRuntime.login("deepseek", "api_key", {
    prompt: async () => "stored-login-key-must-be-ignored",
    notify: () => {},
  });
  const search = session.agent.state.tools.find((tool) => tool.name === "web_search");
  const fetchTool = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(search && fetchTool);

  // Stored Pi login and models.json keys are ignored when DEEPSEEK_API_KEY is unset.
  await assert.rejects(
    search.execute("no-env", { query: "test query" }),
    /Configure DEEPSEEK_API_KEY/u,
  );

  process.env.DEEPSEEK_API_KEY = "env-only-deepseek-key";
  await modelRuntime.setRuntimeApiKey("anthropic", "sk-ant-api03-unrelated");
  await modelRuntime.setRuntimeApiKey("openai", "sk-openai-unrelated");
  const anthropicModel = modelRuntime.getProvider("anthropic")?.getModels()[0];
  const openaiModel = modelRuntime.getProvider("openai")?.getModels()[0];
  assert.ok(anthropicModel && openaiModel);

  const seenUrls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    seenUrls.push(String(url));
    assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
      authorization: "Bearer env-only-deepseek-key",
      "content-type": "application/json",
    });
    if (url === "https://api.deepseek.com/v1/tools/search") {
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
    }
    assert.equal(url, "https://api.deepseek.com/v1/tools/fetch");
    return Response.json({ title: "DeepSeek page", content: "DeepSeek body." });
  });

  for (const model of [anthropicModel, openaiModel]) {
    await session.setModel(model);
    assert.equal((await search.execute("s", { query: "test query" })).details.provider, "deepseek");
    assert.equal(
      (await fetchTool.execute("f", { url: "https://example.test/page" })).details.provider,
      "deepseek",
    );
  }
  assert.deepEqual(seenUrls, [
    "https://api.deepseek.com/v1/tools/search",
    "https://api.deepseek.com/v1/tools/fetch",
    "https://api.deepseek.com/v1/tools/search",
    "https://api.deepseek.com/v1/tools/fetch",
  ]);
});

test("Exa exposes configured defaults in guidelines, uses EXA_API_KEY at hardcoded endpoints without registering a Pi model provider, and never falls back across providers", async (t) => {
  const exaConfig = JSON.stringify({
    search: {
      providers: {
        exa: { mode: "auto", maxAgeHours: 24 },
        deepseek: {},
      },
      defaultProvider: "exa",
    },
    fetch: {
      providers: {
        exa: { maxAgeHours: 12 },
        deepseek: {},
      },
      defaultProvider: "exa",
    },
  });
  const { session, directory, modelRuntime } = await loadSession(
    t,
    ["web_search", "web_fetch"],
    exaConfig,
  );
  assert.equal(modelRuntime.getProvider("exa"), undefined);
  assert.match(
    session.systemPrompt,
    /Active search provider is Exa \(defaults: mode="auto", maxAgeHours=24h; mode="lite" cannot be combined with max_age_hours\)\./u,
  );
  assert.match(
    session.systemPrompt,
    /Active fetch provider is Exa \(default maxAgeHours=12h\)\. Pass objective on large pages to extract focused excerpts\./u,
  );
  assert.doesNotMatch(session.systemPrompt, /web-access\.json/u);

  process.env.DEEPSEEK_API_KEY = "unused-deepseek-key";
  const searchTool = session.agent.state.tools.find((tool) => tool.name === "web_search");
  const fetchTool = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(searchTool?.outputSchema && fetchTool?.outputSchema);

  // Missing EXA_API_KEY fails directly without falling back to DeepSeek.
  await assert.rejects(
    searchTool.execute("exa-missing", { query: "Node.js" }),
    /Configure EXA_API_KEY/u,
  );

  process.env.EXA_API_KEY = "env-exa-key";
  let failExa = false;
  const seenRequests: Array<{ url: string; body: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    seenRequests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
      "content-type": "application/json",
      "x-api-key": "env-exa-key",
    });
    if (failExa) return new Response("rate limit", { status: 429 });
    if (url === "https://api.exa.ai/search") {
      return Response.json({
        results: [
          {
            url: "https://exa.ai/docs",
            title: "Exa Docs",
            publishedDate: "2026-09-01",
            highlights: ["Exa highlight."],
          },
        ],
      });
    }
    assert.equal(url, "https://api.exa.ai/contents");
    return Response.json({
      results: [{ url: "https://exa.ai/docs", title: "Exa Docs", text: "# Exa Docs\n\nBody." }],
    });
  });

  const searchRes = await searchTool.execute("exa-s1", {
    query: "Exa search",
    mode: "deep",
    max_age_hours: 0,
  });
  assert.equal(searchRes.details.provider, "exa");
  assert.equal(Check(searchTool.outputSchema, searchRes.structuredContent), true);

  const fetchRes = await fetchTool.execute("exa-f1", {
    url: "https://exa.ai/docs",
    max_age_hours: 0,
  });
  assert.equal(fetchRes.details.provider, "exa");
  assert.equal(Check(fetchTool.outputSchema, fetchRes.structuredContent), true);

  // Upstream Exa 429 reports directly without forwarding to DeepSeek.
  failExa = true;
  await assert.rejects(
    searchTool.execute("exa-429", { query: "Exa search" }),
    /Exa Search HTTP 429/u,
  );
  failExa = false;

  assert.deepEqual(seenRequests, [
    {
      url: "https://api.exa.ai/search",
      body: {
        query: "Exa search",
        type: "deep",
        numResults: 10,
        contents: { highlights: true, maxAgeHours: 0 },
      },
    },
    {
      url: "https://api.exa.ai/contents",
      body: {
        urls: ["https://exa.ai/docs"],
        text: true,
        maxAgeHours: 0,
      },
    },
    {
      url: "https://api.exa.ai/search",
      body: {
        query: "Exa search",
        type: "auto",
        numResults: 10,
        contents: { highlights: true, maxAgeHours: 24 },
      },
    },
  ]);

  await writeFile(join(directory, "web-access.json"), "{}");
});

test("Parallel defaults to fast mode in guidelines, uses PARALLEL_API_KEY at hardcoded /v1 endpoints, and never falls back to Exa or DeepSeek", async (t) => {
  const parallelConfig = JSON.stringify({
    search: {
      providers: {
        exa: {},
        parallel: {},
        deepseek: {},
      },
      defaultProvider: "parallel",
    },
    fetch: {
      providers: {
        exa: {},
        parallel: { maxAgeHours: 6 },
        deepseek: {},
      },
      defaultProvider: "parallel",
    },
  });
  const { session, directory, modelRuntime } = await loadSession(
    t,
    ["web_search", "web_fetch"],
    parallelConfig,
  );
  assert.equal(modelRuntime.getProvider("parallel"), undefined);
  assert.match(
    session.systemPrompt,
    /Active search provider is Parallel \(defaults: mode="fast", maxAgeHours=index cache; omit need_content; domain\/path prefixes require mode "fast", "basic", or "advanced", not "turbo"\)\./u,
  );
  assert.match(
    session.systemPrompt,
    /Active fetch provider is Parallel \(default maxAgeHours=6h\)\. Pass objective on large pages to extract focused excerpts\./u,
  );
  assert.doesNotMatch(session.systemPrompt, /web-access\.json/u);

  process.env.EXA_API_KEY = "unused-exa-key";
  process.env.DEEPSEEK_API_KEY = "unused-deepseek-key";
  const searchTool = session.agent.state.tools.find((tool) => tool.name === "web_search");
  const fetchTool = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(searchTool?.outputSchema && fetchTool?.outputSchema);

  await assert.rejects(
    searchTool.execute("p-missing", { query: "Node.js" }),
    /Configure PARALLEL_API_KEY/u,
  );

  process.env.PARALLEL_API_KEY = "env-parallel-key";
  let failParallel = false;
  const seenRequests: Array<{ url: string; body: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    seenRequests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
      "content-type": "application/json",
      "x-api-key": "env-parallel-key",
    });
    if (failParallel) return new Response("rate limit", { status: 429 });
    if (url === "https://api.parallel.ai/v1/search") {
      return Response.json({
        search_id: "s1",
        session_id: "sess1",
        results: [
          {
            url: "https://docs.parallel.ai/search",
            title: "Parallel Docs",
            publish_date: "2026-09-10",
            excerpts: ["Parallel excerpt."],
          },
        ],
      });
    }
    assert.equal(url, "https://api.parallel.ai/v1/extract");
    return Response.json({
      extract_id: "e1",
      session_id: "sess1",
      results: [
        {
          url: "https://docs.parallel.ai/search",
          title: "Parallel Docs",
          excerpts: ["Excerpt"],
          full_content: "# Parallel Docs\n\nBody.",
        },
      ],
      errors: [],
    });
  });

  const defaultSearch = await searchTool.execute("p-s1", { query: "Parallel search" });
  assert.equal(defaultSearch.details.provider, "parallel");
  assert.equal(defaultSearch.details.mode, "fast");
  assert.equal(Check(searchTool.outputSchema, defaultSearch.structuredContent), true);

  const overrideSearch = await searchTool.execute("p-s2", {
    query: "Parallel search",
    mode: "advanced",
    max_age_hours: 0,
    count: 5,
    include_domains: ["docs.parallel.ai"],
    after_date: "2026-01-01",
  });
  assert.equal(overrideSearch.details.mode, "advanced");

  const fetchRes = await fetchTool.execute("p-f1", {
    url: "https://docs.parallel.ai/search",
    objective: "authentication headers",
    max_age_hours: 0,
  });
  assert.equal(fetchRes.details.provider, "parallel");
  assert.deepEqual(fetchRes.structuredContent, {
    provider: "parallel",
    url: "https://docs.parallel.ai/search",
    title: "Parallel Docs",
    objective: "authentication headers",
    content: "Excerpt",
  });
  assert.equal(Check(fetchTool.outputSchema, fetchRes.structuredContent), true);

  failParallel = true;
  await assert.rejects(
    searchTool.execute("p-429", { query: "Parallel search" }),
    /Parallel Search HTTP 429/u,
  );
  failParallel = false;

  assert.deepEqual(seenRequests, [
    {
      url: "https://api.parallel.ai/v1/search",
      body: {
        mode: "fast",
        search_queries: ["Parallel search"],
        advanced_settings: { max_results: 10 },
      },
    },
    {
      url: "https://api.parallel.ai/v1/search",
      body: {
        mode: "advanced",
        search_queries: ["Parallel search"],
        advanced_settings: {
          max_results: 5,
          source_policy: {
            include_domains: ["docs.parallel.ai"],
            after_date: "2026-01-01",
          },
          fetch_policy: { max_age_seconds: 600 },
        },
      },
    },
    {
      url: "https://api.parallel.ai/v1/extract",
      body: {
        urls: ["https://docs.parallel.ai/search"],
        objective: "authentication headers",
        advanced_settings: { fetch_policy: { max_age_seconds: 600 } },
      },
    },
    {
      url: "https://api.parallel.ai/v1/search",
      body: {
        mode: "fast",
        search_queries: ["Parallel search"],
        advanced_settings: { max_results: 10 },
      },
    },
  ]);

  await writeFile(join(directory, "web-access.json"), "{}");
});

test("web_search and web_fetch expose structuredContent matching outputSchema to codemode scripts", async (t) => {
  const previousDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "cm-deepseek-key";
  t.after(() => {
    if (previousDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousDeepSeekKey;
  });
  const bothConfig = JSON.stringify({
    search: { providers: { deepseek: {} } },
    fetch: { providers: { deepseek: {} } },
  });
  let mockTurn = 0;
  const { server: mockLlm } = await fixture(t, (_req, reply) => {
    const step = mockTurn++;
    reply.writeHead(200, { "content-type": "text/event-stream" });
    if (step === 0) {
      const code = `
        const [searched, page] = await Promise.all([
          tools.web_search({ query: "Node 26", need_content: true }),
          tools.web_fetch({ url: "https://nodejs.org/en/blog" }),
        ]);
        return {
          provider: searched.provider,
          firstUrl: searched.results[0].url,
          omitted: searched.omittedInvalidUrls,
          pageTitle: page.title,
          rawBody: page.content,
        };
      `;
      reply.write(
        `data: ${JSON.stringify({
          id: "cmpl_1",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_cm",
                    type: "function",
                    function: { name: "codemode", arguments: JSON.stringify({ code }) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n` +
          `data: ${JSON.stringify({
            id: "cmpl_1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n` +
          "data: [DONE]\n\n",
      );
      reply.end();
      return;
    }
    reply.write(
      `data: ${JSON.stringify({
        id: "cmpl_2",
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null },
        ],
      })}\n\n` +
        `data: ${JSON.stringify({
          id: "cmpl_2",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        })}\n\n` +
        "data: [DONE]\n\n",
    );
    reply.end();
  });
  const llmAddr = mockLlm.address();
  assert.ok(llmAddr && typeof llmAddr === "object");

  const directory = await mkdtemp(join(tmpdir(), "pi-web-codemode-"));
  const prevDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  let activeSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  t.after(async () => {
    activeSession?.dispose();
    if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevDir;
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await writeFile(join(directory, "web-access.json"), bothConfig);
  const modelsPath = join(directory, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${llmAddr.port}/v1`,
          apiKey: "mock-key",
          api: "openai-completions",
          models: [
            {
              id: "mock-model",
              name: "Mock",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
    extensionFactories: [createCodemodeExtension({ mode: "on" })],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);

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
    tools: ["web_search", "web_fetch", "codemode"],
  });
  activeSession = session;

  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).startsWith(`http://127.0.0.1:${llmAddr.port}/`)) {
      return nativeFetch(String(url), init);
    }
    if (url === "https://api.deepseek.com/v1/tools/search") {
      return Response.json({
        results: [
          {
            title: "Node 26 Release",
            url: "https://nodejs.org/en/blog/release/v26.0.0",
            summary: "Major V8 update.",
            snippet: "",
            content: "Detailed changelog content.",
            site_name: "Node.js",
            date: "2026-04-21",
          },
          {
            title: "Invalid",
            url: "ftp://invalid.example.test",
            summary: "",
            snippet: "",
            content: "",
            site_name: null,
            date: null,
          },
        ],
      });
    }
    assert.equal(url, "https://api.deepseek.com/v1/tools/fetch");
    return Response.json({
      title: "Node 26 Guide",
      content: "# Node 26\n\nBody without wrapper header.",
    });
  });

  const searchTool = session.agent.state.tools.find((tool) => tool.name === "web_search");
  const fetchTool = session.agent.state.tools.find((tool) => tool.name === "web_fetch");
  assert.ok(searchTool?.outputSchema && fetchTool?.outputSchema);

  const mockModel = modelRuntime.getProvider("mock")?.getModels()[0];
  assert.ok(mockModel);
  await session.setModel(mockModel);

  const dsSearch = await searchTool.execute("cm-s1", { query: "Node 26", need_content: true });
  assert.equal(Check(searchTool.outputSchema, dsSearch.structuredContent), true);
  const dsFetch = await fetchTool.execute("cm-f1", { url: "https://nodejs.org/en/blog" });
  assert.equal(Check(fetchTool.outputSchema, dsFetch.structuredContent), true);

  await session.prompt("Run codemode web search and fetch");

  const cmResult = session.messages.find(
    (msg) => msg.role === "toolResult" && msg.toolName === "codemode",
  );
  assert.ok(cmResult && cmResult.role === "toolResult");
  assert.equal(cmResult.isError, false, JSON.stringify(cmResult.content));
  const payloadPart = cmResult.content.at(1);
  assert.ok(payloadPart && payloadPart.type === "text");
  assert.deepEqual(JSON.parse(payloadPart.text), {
    provider: "deepseek",
    firstUrl: "https://nodejs.org/en/blog/release/v26.0.0",
    omitted: 1,
    pageTitle: "Node 26 Guide",
    rawBody: "# Node 26\n\nBody without wrapper header.",
  });
});
