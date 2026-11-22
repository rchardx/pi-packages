import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, rm, stat } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { dirname } from "node:path";
import { test, type TestContext } from "node:test";
import {
  executeFetch,
  FETCH_TIMEOUT_MS,
  fetchExa,
  MAX_FETCH_RESPONSE_BYTES,
} from "../src/fetch.ts";
import { MAX_SEARCH_RESPONSE_BYTES, SEARCH_TIMEOUT_MS, searchExa } from "../src/search.ts";
import { fixture } from "./_server.ts";

const key = "test-only-exa-key";
const credentials = () => new Headers({ "x-api-key": key });
const pageUrl = "https://docs.example.test/guide";

const searchHit = {
  id: pageUrl,
  title: "Exa API Guide",
  url: pageUrl,
  publishedDate: "2026-08-14T00:00:00.000Z",
  highlights: ["First relevant highlight.", "Second relevant highlight."],
  text: "# Exa Guide\n\nFull extracted page text.",
};

async function localTransport(
  t: TestContext,
  expectedEndpoint: string,
  handler: RequestListener,
): Promise<typeof fetch> {
  const { server } = await fixture(t, handler);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const path = new URL(expectedEndpoint).pathname;
  return (endpoint, init) => {
    assert.equal(endpoint, expectedEndpoint);
    return fetch(`http://127.0.0.1:${address.port}${path}`, init);
  };
}

test("searchExa defaults to auto mode and requests highlights only unless full text is requested", async () => {
  let calls = 0;
  const result = await searchExa(
    { query: "React Server Components" },
    credentials,
    {},
    undefined,
    async (endpoint, init) => {
      calls++;
      assert.equal(endpoint, "https://api.exa.ai/search");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
        "content-type": "application/json",
        "x-api-key": key,
      });
      assert.deepEqual(JSON.parse(String(init?.body)), {
        query: "React Server Components",
        type: "auto",
        numResults: 10,
        contents: { highlights: true },
      });
      return Response.json({ results: [searchHit] });
    },
  );
  assert.equal(calls, 1);
  const text = result.content[0]?.text ?? "";
  assert.match(text, /Provider: Exa Search \(mode: auto\)/u);
  assert.match(text, /First relevant highlight\.\n\nSecond relevant highlight\./u);
  assert.doesNotMatch(text, /Full extracted page text/u);
  assert.deepEqual(result.structuredContent, {
    provider: "exa",
    query: "React Server Components",
    results: [
      {
        title: "Exa API Guide",
        url: pageUrl,
        publishedDate: "2026-08-14T00:00:00.000Z",
        summary: "First relevant highlight.\n\nSecond relevant highlight.",
      },
    ],
    omittedInvalidUrls: 0,
  });
  assert.equal(result.details.mode, "auto");
  assert.equal(result.details.needContent, false);
});

test("searchExa switches to text-only contents when need_content is true and honors configured and per-call overrides", async () => {
  const seenBodies: unknown[] = [];
  const transport: typeof fetch = async (_endpoint, init) => {
    seenBodies.push(JSON.parse(String(init?.body)));
    return Response.json({ results: [searchHit] });
  };

  // Configured defaults apply when call overrides are omitted.
  const fromConfig = await searchExa(
    { query: "caching", count: 3, need_content: true },
    credentials,
    { mode: "deep-lite", maxAgeHours: 24 },
    undefined,
    transport,
  );
  assert.equal(fromConfig.details.mode, "deep-lite");
  assert.equal(fromConfig.details.maxAgeHours, 24);
  assert.equal(
    fromConfig.structuredContent.results[0]?.content,
    "# Exa Guide\n\nFull extracted page text.",
  );
  assert.equal(fromConfig.structuredContent.results[0]?.summary, undefined);

  // Per-call mode and max_age_hours override configured defaults.
  const overridden = await searchExa(
    { query: "caching", count: 2, mode: "deep", max_age_hours: 0 },
    credentials,
    { mode: "auto", maxAgeHours: 24 },
    undefined,
    transport,
  );
  assert.equal(overridden.details.mode, "deep");
  assert.equal(overridden.details.maxAgeHours, 0);

  // Per-call mode="lite" drops a configured maxAgeHours default so cached fast-path calls succeed.
  const liteOverride = await searchExa(
    { query: "caching", mode: "lite" },
    credentials,
    { mode: "auto", maxAgeHours: 24 },
    undefined,
    transport,
  );
  assert.equal(liteOverride.details.mode, "lite");
  assert.equal(liteOverride.details.maxAgeHours, undefined);

  assert.deepEqual(seenBodies, [
    {
      query: "caching",
      type: "deep-lite",
      numResults: 3,
      contents: { text: true, maxAgeHours: 24 },
    },
    {
      query: "caching",
      type: "deep",
      numResults: 2,
      contents: { highlights: true, maxAgeHours: 0 },
    },
    {
      query: "caching",
      type: "lite",
      numResults: 10,
      contents: { highlights: true },
    },
  ]);

  seenBodies.length = 0;
  const filtered = await searchExa(
    {
      query: "Node.js releases",
      include_domains: [
        "  DOCS.Nodejs.org/api/ ",
        "npmjs.com/package/@types/node/",
        "nodejs.org/",
        "nodejs.org",
      ],
      exclude_domains: ["www.nodejs.org/", "nodejs.org/dist/"],
      after_date: "2024-02-29",
    },
    credentials,
    {},
    undefined,
    transport,
  );
  assert.deepEqual(seenBodies, [
    {
      query: "Node.js releases",
      type: "auto",
      numResults: 10,
      includeDomains: ["docs.nodejs.org/api", "npmjs.com/package/@types/node", "nodejs.org"],
      excludeDomains: ["www.nodejs.org", "nodejs.org/dist"],
      startPublishedDate: "2024-02-29T00:00:00.000Z",
      contents: { highlights: true },
    },
  ]);
  assert.match(
    filtered.content[0]?.text ?? "",
    /Filters: include=docs\.nodejs\.org\/api, npmjs\.com\/package\/@types\/node, nodejs\.org; exclude=www\.nodejs\.org, nodejs\.org\/dist; after=2024-02-29/u,
  );
  assert.deepEqual(filtered.details.includeDomains, [
    "docs.nodejs.org/api",
    "npmjs.com/package/@types/node",
    "nodejs.org",
  ]);
  assert.deepEqual(filtered.details.excludeDomains, ["www.nodejs.org", "nodejs.org/dist"]);
  assert.equal(filtered.details.afterDate, "2024-02-29");
});

test("searchExa rejects blank queries, incompatible lite + max_age_hours, and pre-cancellation before resolving credentials", async () => {
  let resolutions = 0;
  const resolveAuth = () => {
    resolutions++;
    return credentials();
  };
  await assert.rejects(
    searchExa({ query: "   " }, resolveAuth),
    /Exa Search requires a non-blank query/u,
  );
  await assert.rejects(
    searchExa({ query: "API", mode: "fast" }, resolveAuth),
    /Exa Search mode must be one of lite, auto, deep-lite, deep; got "fast"/u,
  );
  await assert.rejects(
    searchExa({ query: "API", mode: "lite", max_age_hours: 24 }, resolveAuth),
    /mode "lite" uses cached content only and cannot be combined with max_age_hours/u,
  );
  await assert.rejects(
    searchExa({ query: "API", max_age_hours: 0 }, resolveAuth, { mode: "lite" }),
    /mode "lite" uses cached content only and cannot be combined with max_age_hours/u,
  );
  for (const badFilter of [
    { include_domains: ["   "] },
    { include_domains: ["https://nodejs.org"] },
    { include_domains: ["*.nodejs.org"] },
    { include_domains: ["nodejs.org:443"] },
    { include_domains: ["user@nodejs.org/api"] },
    { include_domains: ["nodejs.org?x=1"] },
    { include_domains: ["nodejs.org#frag"] },
    { include_domains: ["localhost"] },
    { include_domains: ["127.0.0.1"] },
    { include_domains: [".edu"] },
    { include_domains: [".edu/path"] },
    { exclude_domains: ["github.com/../etc"] },
    { include_domains: ["nodejs.org"], exclude_domains: ["NODEJS.ORG/"] },
    { after_date: "2025-02-29" },
  ]) {
    await assert.rejects(searchExa({ query: "API", ...badFilter }, resolveAuth));
  }
  await assert.rejects(
    searchExa({ query: "API" }, resolveAuth, {}, AbortSignal.abort(new Error("cancelled"))),
    /cancelled/u,
  );
  assert.equal(resolutions, 0);
});

test("searchExa normalizes nullable metadata, omits invalid URLs, and handles oversized or stalled streams", async (t) => {
  const result = await searchExa(
    { query: "nullable", count: 2 },
    credentials,
    {},
    undefined,
    async () =>
      Response.json({
        results: [
          { url: "ftp://invalid.example.test", title: "Bad" },
          { url: pageUrl, title: null, publishedDate: null, highlights: null },
        ],
      }),
  );
  assert.equal(result.details.omittedInvalidUrls, 1);
  assert.equal(result.structuredContent.results[0]?.title, pageUrl);
  assert.match(result.content[0]?.text ?? "", /Omitted 1 result\(s\)/u);
  assert.match(result.content[0]?.text ?? "", /Highlights: Not provided\./u);

  const oversized = await localTransport(t, "https://api.exa.ai/search", (_req, reply) => {
    reply.writeHead(200, { "content-type": "application/json" });
    reply.write(Buffer.alloc(MAX_SEARCH_RESPONSE_BYTES + 1));
    reply.end();
  });
  await assert.rejects(
    searchExa({ query: "API" }, credentials, {}, undefined, oversized),
    /2 MiB/u,
  );

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stalled = searchExa(
    { query: "API" },
    credentials,
    {},
    undefined,
    async (_endpoint, init) => {
      started?.();
      const signal = init?.signal;
      assert.ok(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  );
  const timedOut = assert.rejects(stalled, /Exa Search timed out after 120 seconds/u);
  await requestStarted;
  t.mock.timers.tick(SEARCH_TIMEOUT_MS);
  await timedOut;
});

test("fetchExa normalizes URLs, passes maxAgeHours, and saves truncated output privately", async (t) => {
  const longText = `${"# Heading\n\nParagraph.\n".repeat(1200)}Tail marker`;
  let seenBody: unknown;
  const result = await fetchExa(
    " HTTPS://DOCS.example.test:443/guide#fragment ",
    credentials,
    { maxAgeHours: 0 },
    undefined,
    async (endpoint, init) => {
      assert.equal(endpoint, "https://api.exa.ai/contents");
      assert.equal(init?.redirect, "error");
      seenBody = JSON.parse(String(init?.body));
      return Response.json({
        results: [{ url: pageUrl, title: "  Guide\nTitle  ", text: longText }],
        statuses: [{ id: pageUrl, status: "success" }],
      });
    },
  );
  assert.deepEqual(seenBody, {
    urls: [pageUrl],
    text: true,
    maxAgeHours: 0,
  });
  assert.equal(result.details.provider, "exa");
  assert.equal(result.details.title, "Guide Title");
  assert.equal(result.details.maxAgeHours, 0);
  assert.equal(result.structuredContent.content, longText);
  const fullPath = result.details.fullOutputPath;
  assert.ok(fullPath);
  t.after(() => rm(dirname(fullPath), { recursive: true, force: true }));
  assert.ok((await readFile(fullPath, "utf8")).endsWith("Tail marker"));
  if (process.platform !== "win32") {
    assert.equal((await stat(fullPath)).mode & 0o777, 0o600);
  }

  // Targeted objective requests highlights.query instead of full page text.
  let objectiveBody: unknown;
  const focused = await fetchExa(
    pageUrl,
    credentials,
    { maxAgeHours: 12, objective: "  LTS\nmaintenance dates  " },
    undefined,
    async (_endpoint, init) => {
      objectiveBody = JSON.parse(String(init?.body));
      return Response.json({
        results: [
          {
            url: pageUrl,
            title: "Node Releases",
            highlights: ["22.x enters Maintenance LTS.", "End-of-life in April 2027."],
          },
        ],
      });
    },
  );
  assert.deepEqual(objectiveBody, {
    urls: [pageUrl],
    highlights: { query: "LTS maintenance dates" },
    maxAgeHours: 12,
  });
  assert.equal(focused.details.objective, "LTS maintenance dates");
  assert.equal(focused.structuredContent.objective, "LTS maintenance dates");
  assert.equal(
    focused.structuredContent.content,
    "22.x enters Maintenance LTS.\n\nEnd-of-life in April 2027.",
  );
  assert.match(focused.content[0]?.text ?? "", /Objective: LTS maintenance dates/u);
  assert.match(focused.content[0]?.text ?? "", /Untrusted provider-returned web excerpts/u);
});

test("fetchExa sanitizes crawl statuses, cache misses, HTTP errors, and pre-auth URL errors", async (t) => {
  const prevExaKey = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = key;
  t.after(() => {
    if (prevExaKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = prevExaKey;
  });

  let resolutions = 0;
  const countAuth = () => {
    resolutions++;
    return credentials();
  };
  await assert.rejects(fetchExa("ftp://example.test", countAuth), /Only HTTP and HTTPS/u);
  await assert.rejects(
    fetchExa(`https://docs.example.test/${"a".repeat(2024)}`, countAuth),
    /Exa Fetch URL exceeds 2048 characters after normalization/u,
  );
  await assert.rejects(
    fetchExa(pageUrl, countAuth, { objective: "  \n " }),
    /Exa Fetch objective must not be blank/u,
  );
  assert.equal(resolutions, 0);

  for (const [payload, options, expected] of [
    [
      {
        results: [],
        statuses: [{ id: pageUrl, status: "error", error: { tag: "SOURCE_NOT_AVAILABLE" } }],
      },
      {},
      /access restricted or unavailable/u,
    ],
    [
      {
        results: [],
        statuses: [
          { id: pageUrl, status: "error", error: { tag: "CRAWL_HTTP_403", httpStatusCode: null } },
        ],
      },
      {},
      /access restricted or unavailable/u,
    ],
    [
      {
        results: [],
        statuses: [
          { id: pageUrl, status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } },
        ],
      },
      {},
      /HTTP 404/u,
    ],
    [
      {
        results: [],
        statuses: [{ id: pageUrl, status: "error", error: { tag: "CRAWL_LIVECRAWL_TIMEOUT" } }],
      },
      {},
      /timed out while retrieving.*retry later/u,
    ],
    [
      {
        results: [],
        statuses: [{ id: pageUrl, status: "error", error: { tag: "CRAWL_HTTP_503" } }],
      },
      {},
      /upstream HTTP 503/u,
    ],
    [
      {
        results: [],
        statuses: [{ id: pageUrl, status: "error", error: { tag: "OTHER", httpStatusCode: 502 } }],
      },
      {},
      /upstream HTTP 502/u,
    ],
    [{ results: [] }, { maxAgeHours: -1 }, /found no cached content.*pass max_age_hours: 0/u],
    [
      { results: [{ url: pageUrl, title: "Blank", text: "  \n " }] },
      {},
      /no readable page content/u,
    ],
    [
      { results: [{ url: pageUrl, title: "Cached", highlights: [] }] },
      { maxAgeHours: -1, objective: "unmatched topic" },
      /found no excerpts matching the requested objective/u,
    ],
  ] as const) {
    await assert.rejects(
      fetchExa(pageUrl, credentials, options, undefined, async () => Response.json(payload)),
      expected,
    );
  }

  // Configured cache-only default (-1) directs callers to pass max_age_hours: 0, which succeeds.
  const cacheOnlyTarget = { provider: "exa" as const, options: { maxAgeHours: -1 } };
  const cacheVsLive: typeof fetch = async (_endpoint, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    const cacheOnly =
      typeof body === "object" && body !== null && "maxAgeHours" in body && body.maxAgeHours === -1;
    return cacheOnly
      ? Response.json({ results: [] })
      : Response.json({ results: [{ url: pageUrl, title: "Live", text: "Live content." }] });
  };
  await assert.rejects(
    executeFetch(cacheOnlyTarget, { url: pageUrl }, undefined, cacheVsLive),
    /pass max_age_hours: 0/u,
  );
  const recovered = await executeFetch(
    cacheOnlyTarget,
    { url: pageUrl, max_age_hours: 0 },
    undefined,
    cacheVsLive,
  );
  assert.equal(recovered.structuredContent.content, "Live content.");

  for (const [status, message] of [
    [401, "Exa Fetch HTTP 401: Missing or invalid Exa API key."],
    [402, "Exa Fetch HTTP 402: Insufficient Exa credits or spending budget exceeded."],
    [403, "Exa Fetch HTTP 403: Exa account access denied or feature disabled."],
  ] as const) {
    await assert.rejects(
      fetchExa(
        pageUrl,
        credentials,
        {},
        undefined,
        async () => new Response(`secret ${key}`, { status }),
      ),
      { message },
    );
  }

  let closed: Promise<unknown[]> | undefined;
  const oversized = await localTransport(t, "https://api.exa.ai/contents", (_req, reply) => {
    closed = once(reply, "close");
    reply.writeHead(200, { "content-type": "application/json" });
    reply.write(Buffer.alloc(MAX_FETCH_RESPONSE_BYTES + 1));
  });
  await assert.rejects(fetchExa(pageUrl, credentials, {}, undefined, oversized), /2 MiB/u);
  assert.ok(closed);
  await closed;

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stalled = fetchExa(pageUrl, credentials, {}, undefined, async (_endpoint, init) => {
    started?.();
    const signal = init?.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const timedOut = assert.rejects(stalled, /Exa Fetch timed out after 60 seconds/u);
  await requestStarted;
  t.mock.timers.tick(FETCH_TIMEOUT_MS);
  await timedOut;
});
