import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, rm, stat } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { dirname } from "node:path";
import { test, type TestContext } from "node:test";
import {
  FETCH_TIMEOUT_MS,
  fetchParallel,
  MAX_FETCH_RESPONSE_BYTES,
  PARALLEL_MIN_MAX_AGE_SECONDS,
} from "../src/fetch.ts";
import {
  MAX_SEARCH_RESPONSE_BYTES,
  PARALLEL_MAX_QUERY_CHARACTERS,
  SEARCH_TIMEOUT_MS,
  searchParallel,
} from "../src/search.ts";
import { fixture } from "./_server.ts";

const key = "test-only-parallel-key";
const credentials = () => new Headers({ "x-api-key": key });
const pageUrl = "https://docs.example.test/parallel-guide";

const searchHit = {
  url: pageUrl,
  title: "Parallel Search Guide",
  publish_date: "2026-09-12",
  excerpts: ["First Markdown excerpt.", "Second Markdown excerpt."],
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

test("searchParallel defaults to fast mode with index-cached excerpts and formats ordered results", async () => {
  let calls = 0;
  const result = await searchParallel(
    { query: "  Parallel Search API  " },
    credentials,
    {},
    undefined,
    async (endpoint, init) => {
      calls++;
      assert.equal(endpoint, "https://api.parallel.ai/v1/search");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
        "content-type": "application/json",
        "x-api-key": key,
      });
      assert.deepEqual(JSON.parse(String(init?.body)), {
        mode: "fast",
        search_queries: ["Parallel Search API"],
        advanced_settings: {
          max_results: 10,
        },
      });
      return Response.json({
        search_id: "search_1",
        session_id: "session_1",
        results: [searchHit],
      });
    },
  );
  assert.equal(calls, 1);
  const text = result.content[0]?.text ?? "";
  assert.match(text, /Provider: Parallel Search \(mode: fast\)/u);
  assert.match(text, /First Markdown excerpt\.\n\nSecond Markdown excerpt\./u);
  assert.deepEqual(result.structuredContent, {
    provider: "parallel",
    query: "  Parallel Search API  ",
    results: [
      {
        title: "Parallel Search Guide",
        url: pageUrl,
        publishedDate: "2026-09-12",
        summary: "First Markdown excerpt.\n\nSecond Markdown excerpt.",
      },
    ],
    omittedInvalidUrls: 0,
  });
  assert.equal(result.details.mode, "fast");
  assert.equal(result.details.needContent, false);
});

test("searchParallel honors configured and per-call mode and freshness overrides, mapping 0 to the 600s floor and -1 to index-only", async () => {
  const seenBodies: unknown[] = [];
  const transport: typeof fetch = async (_endpoint, init) => {
    seenBodies.push(JSON.parse(String(init?.body)));
    return Response.json({ search_id: "s", session_id: "sess", results: [searchHit] });
  };

  const fromConfig = await searchParallel(
    { query: "vector search", count: 4 },
    credentials,
    { mode: "basic", maxAgeHours: 24 },
    undefined,
    transport,
  );
  assert.equal(fromConfig.details.mode, "basic");
  assert.equal(fromConfig.details.maxAgeHours, 24);

  const liveOverride = await searchParallel(
    { query: "vector search", count: 2, mode: "advanced", max_age_hours: 0 },
    credentials,
    { mode: "fast", maxAgeHours: 24 },
    undefined,
    transport,
  );
  assert.equal(liveOverride.details.mode, "advanced");
  assert.equal(liveOverride.details.maxAgeHours, 0);

  const cacheOnlyOverride = await searchParallel(
    { query: "vector search", mode: "turbo", max_age_hours: -1 },
    credentials,
    { mode: "fast", maxAgeHours: 24 },
    undefined,
    transport,
  );
  assert.equal(cacheOnlyOverride.details.mode, "turbo");
  assert.equal(cacheOnlyOverride.details.maxAgeHours, -1);

  assert.deepEqual(seenBodies, [
    {
      mode: "basic",
      search_queries: ["vector search"],
      advanced_settings: {
        max_results: 4,
        fetch_policy: { max_age_seconds: 86_400 },
      },
    },
    {
      mode: "advanced",
      search_queries: ["vector search"],
      advanced_settings: {
        max_results: 2,
        fetch_policy: { max_age_seconds: PARALLEL_MIN_MAX_AGE_SECONDS },
      },
    },
    {
      mode: "turbo",
      search_queries: ["vector search"],
      advanced_settings: {
        max_results: 10,
      },
    },
  ]);

  seenBodies.length = 0;
  const filtered = await searchParallel(
    {
      query: "Node.js releases",
      include_domains: ["DOCS.Python.org/3/", "wikipedia.org", ".gov"],
      exclude_domains: ["docs.python.org/3/library/"],
      after_date: "2025-01-15",
    },
    credentials,
    {},
    undefined,
    transport,
  );
  assert.deepEqual(seenBodies, [
    {
      mode: "fast",
      search_queries: ["Node.js releases"],
      advanced_settings: {
        max_results: 10,
        source_policy: {
          include_domains: ["docs.python.org/3", "wikipedia.org", ".gov"],
          exclude_domains: ["docs.python.org/3/library"],
          after_date: "2025-01-15",
        },
      },
    },
  ]);
  assert.match(
    filtered.content[0]?.text ?? "",
    /Filters: include=docs\.python\.org\/3, wikipedia\.org, \.gov; exclude=docs\.python\.org\/3\/library; after=2025-01-15/u,
  );
  assert.deepEqual(filtered.details.includeDomains, ["docs.python.org/3", "wikipedia.org", ".gov"]);
  assert.deepEqual(filtered.details.excludeDomains, ["docs.python.org/3/library"]);
  assert.equal(filtered.details.afterDate, "2025-01-15");
});

test("searchParallel rejects unsupported modes, need_content, invalid query lengths, and pre-cancellation before reading credentials", async () => {
  let resolutions = 0;
  const countAuth = () => {
    resolutions++;
    return credentials();
  };
  await assert.rejects(
    searchParallel({ query: "API", mode: "deep" }, countAuth),
    /Parallel Search mode must be one of turbo, fast, basic, advanced; got "deep"/u,
  );
  await assert.rejects(
    searchParallel({ query: "API", need_content: true }, countAuth),
    /Parallel Search returns Markdown excerpts by default and does not support need_content/u,
  );
  for (const badQuery of ["   ", "x".repeat(PARALLEL_MAX_QUERY_CHARACTERS + 1)]) {
    await assert.rejects(
      searchParallel({ query: badQuery }, countAuth),
      /1–200 Unicode characters/u,
    );
  }
  for (const badFilter of [
    { include_domains: ["https://docs.parallel.ai"] },
    { include_domains: ["*.parallel.ai"] },
    { include_domains: ["parallel.ai"], exclude_domains: ["www.parallel.ai/"] },
    { mode: "turbo" as const, include_domains: ["docs.parallel.ai/search"] },
    { mode: "turbo" as const, exclude_domains: ["docs.parallel.ai/search"] },
    { after_date: "2025-02-29" },
  ]) {
    await assert.rejects(searchParallel({ query: "API", ...badFilter }, countAuth));
  }
  await assert.rejects(
    searchParallel({ query: "API", include_domains: ["docs.parallel.ai/search"] }, countAuth, {
      mode: "turbo",
    }),
    /mode "turbo" does not support domain\/path prefix filters/u,
  );
  await assert.rejects(
    searchParallel({ query: "API" }, countAuth, {}, AbortSignal.abort(new Error("cancelled"))),
    /cancelled/u,
  );
  assert.equal(resolutions, 0);
});

test("searchParallel normalizes nullable metadata, omits invalid URLs, and handles oversized or stalled streams", async (t) => {
  const result = await searchParallel(
    { query: "nullable", count: 2 },
    credentials,
    {},
    undefined,
    async () =>
      Response.json({
        results: [
          { url: "ftp://invalid.example.test", title: "Bad", excerpts: ["x"] },
          { url: pageUrl, title: null, publish_date: null, excerpts: [] },
        ],
      }),
  );
  assert.equal(result.details.omittedInvalidUrls, 1);
  assert.equal(result.structuredContent.results[0]?.title, pageUrl);
  assert.match(result.content[0]?.text ?? "", /Omitted 1 result\(s\)/u);
  assert.match(result.content[0]?.text ?? "", /Excerpts: Not provided\./u);

  const oversized = await localTransport(t, "https://api.parallel.ai/v1/search", (_req, reply) => {
    reply.writeHead(200, { "content-type": "application/json" });
    reply.write(Buffer.alloc(MAX_SEARCH_RESPONSE_BYTES + 1));
    reply.end();
  });
  await assert.rejects(
    searchParallel({ query: "API" }, credentials, {}, undefined, oversized),
    /2 MiB/u,
  );

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stalled = searchParallel(
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
  const timedOut = assert.rejects(stalled, /Parallel Search timed out after 120 seconds/u);
  await requestStarted;
  t.mock.timers.tick(SEARCH_TIMEOUT_MS);
  await timedOut;
});

test("fetchParallel normalizes URLs, requests full_content with fetch_policy, falls back to excerpts when full_content is null, and saves truncated output privately", async (t) => {
  const longText = `${"# Parallel Extract\n\nParagraph.\n".repeat(1200)}Tail marker`;
  let seenBody: unknown;
  const result = await fetchParallel(
    " HTTPS://DOCS.example.test:443/parallel-guide#section ",
    credentials,
    { maxAgeHours: 0 },
    undefined,
    async (endpoint, init) => {
      assert.equal(endpoint, "https://api.parallel.ai/v1/extract");
      assert.equal(init?.redirect, "error");
      seenBody = JSON.parse(String(init?.body));
      return Response.json({
        extract_id: "ext_1",
        session_id: "sess_1",
        results: [
          {
            url: pageUrl,
            title: "  Parallel\nGuide  ",
            excerpts: ["Short excerpt"],
            full_content: longText,
          },
        ],
        errors: [],
      });
    },
  );
  assert.deepEqual(seenBody, {
    urls: [pageUrl],
    advanced_settings: {
      full_content: true,
      fetch_policy: { max_age_seconds: PARALLEL_MIN_MAX_AGE_SECONDS },
    },
  });
  assert.equal(result.details.provider, "parallel");
  assert.equal(result.details.title, "Parallel Guide");
  assert.equal(result.details.maxAgeHours, 0);
  assert.equal(result.structuredContent.content, longText);
  const fullPath = result.details.fullOutputPath;
  assert.ok(fullPath);
  t.after(() => rm(dirname(fullPath), { recursive: true, force: true }));
  assert.ok((await readFile(fullPath, "utf8")).endsWith("Tail marker"));
  if (process.platform !== "win32") {
    assert.equal((await stat(fullPath)).mode & 0o777, 0o600);
  }

  // Fallback to joined excerpts if full_content is null.
  const excerptFallback = await fetchParallel(pageUrl, credentials, {}, undefined, async () =>
    Response.json({
      results: [
        {
          url: pageUrl,
          title: "Excerpts only",
          excerpts: ["Part A", "Part B"],
          full_content: null,
        },
      ],
      errors: [],
    }),
  );
  assert.equal(excerptFallback.structuredContent.content, "Part A\n\nPart B");
  assert.equal(excerptFallback.details.excerpts, true);
  assert.match(excerptFallback.content[0]?.text ?? "", /Untrusted provider-returned web excerpts/u);

  // Objective omits full_content (and advanced_settings when maxAgeHours is unset) to request focused excerpts.
  const objectiveBodies: unknown[] = [];
  const focusedDefault = await fetchParallel(
    pageUrl,
    credentials,
    { objective: "  rate\nlimits  " },
    undefined,
    async (_endpoint, init) => {
      objectiveBodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        results: [
          {
            url: pageUrl,
            title: "Rate limits",
            excerpts: ["600 requests per minute."],
            full_content: null,
          },
        ],
        errors: [],
      });
    },
  );
  const focusedLive = await fetchParallel(
    pageUrl,
    credentials,
    { objective: "rate limits", maxAgeHours: 0 },
    undefined,
    async (_endpoint, init) => {
      objectiveBodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        results: [
          {
            url: pageUrl,
            title: "Rate limits",
            excerpts: ["600 requests per minute."],
            full_content: null,
          },
        ],
        errors: [],
      });
    },
  );
  assert.deepEqual(objectiveBodies, [
    { urls: [pageUrl], objective: "rate limits" },
    {
      urls: [pageUrl],
      objective: "rate limits",
      advanced_settings: { fetch_policy: { max_age_seconds: PARALLEL_MIN_MAX_AGE_SECONDS } },
    },
  ]);
  assert.equal(focusedDefault.details.objective, "rate limits");
  assert.equal(focusedDefault.structuredContent.objective, "rate limits");
  assert.equal(focusedLive.structuredContent.content, "600 requests per minute.");
  assert.match(focusedDefault.content[0]?.text ?? "", /Objective: rate limits/u);
});

test("fetchParallel rejects cache-only (-1) and invalid URLs pre-auth, and sanitizes extract errors and HTTP statuses without leaking raw error text", async (t) => {
  let resolutions = 0;
  const countAuth = () => {
    resolutions++;
    return credentials();
  };
  await assert.rejects(fetchParallel("ftp://example.test", countAuth), /Only HTTP and HTTPS/u);
  await assert.rejects(
    fetchParallel(pageUrl, countAuth, { maxAgeHours: -1 }),
    /Parallel Fetch does not support cache-only mode \(-1\)/u,
  );
  await assert.rejects(
    fetchParallel(pageUrl, countAuth, { objective: "   " }),
    /Parallel Fetch objective must not be blank/u,
  );
  assert.equal(resolutions, 0);

  for (const [payload, expected] of [
    [
      {
        results: [],
        errors: [
          {
            url: pageUrl,
            error_type: "fetch_error",
            http_status_code: 403,
            content: `raw upstream body ${key}`,
          },
        ],
      },
      /access restricted or unavailable/u,
    ],
    [
      {
        results: [],
        errors: [
          {
            url: pageUrl,
            error_type: "fetch_error",
            http_status_code: 404,
            content: `raw upstream body ${key}`,
          },
        ],
      },
      /HTTP 404/u,
    ],
    [
      {
        results: [],
        errors: [
          {
            url: pageUrl,
            error_type: "timeout",
            http_status_code: null,
            content: `raw upstream body ${key}`,
          },
        ],
      },
      /timed out while retrieving.*retry later/u,
    ],
    [
      {
        results: [],
        errors: [
          {
            url: pageUrl,
            error_type: "fetch_error",
            http_status_code: 502,
            content: `raw upstream body ${key}`,
          },
        ],
      },
      /upstream HTTP 502/u,
    ],
    [
      {
        results: [{ url: pageUrl, title: "Blank", excerpts: ["  "], full_content: " \n " }],
        errors: [],
      },
      /no readable page content/u,
    ],
  ] as const) {
    await assert.rejects(
      fetchParallel(pageUrl, credentials, {}, undefined, async () => Response.json(payload)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, expected);
        assert.ok(!error.message.includes(key));
        return true;
      },
    );
  }

  await assert.rejects(
    fetchParallel(pageUrl, credentials, { objective: "unmatched topic" }, undefined, async () =>
      Response.json({
        results: [{ url: pageUrl, title: "Page", excerpts: [], full_content: null }],
        errors: [],
      }),
    ),
    /Parallel Fetch found no excerpts matching the requested objective/u,
  );

  for (const [status, message] of [
    [401, "Parallel Fetch HTTP 401: Missing or invalid Parallel API key."],
    [402, "Parallel Fetch HTTP 402: Insufficient Parallel account credits."],
    [403, "Parallel Fetch HTTP 403: Parallel access denied for the requested mode or account."],
  ] as const) {
    await assert.rejects(
      fetchParallel(
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
  const oversized = await localTransport(t, "https://api.parallel.ai/v1/extract", (_req, reply) => {
    closed = once(reply, "close");
    reply.writeHead(200, { "content-type": "application/json" });
    reply.write(Buffer.alloc(MAX_FETCH_RESPONSE_BYTES + 1));
  });
  await assert.rejects(fetchParallel(pageUrl, credentials, {}, undefined, oversized), /2 MiB/u);
  assert.ok(closed);
  await closed;

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stalled = fetchParallel(pageUrl, credentials, {}, undefined, async (_endpoint, init) => {
    started?.();
    const signal = init?.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const timedOut = assert.rejects(stalled, /Parallel Fetch timed out after 60 seconds/u);
  await requestStarted;
  t.mock.timers.tick(FETCH_TIMEOUT_MS);
  await timedOut;
});
