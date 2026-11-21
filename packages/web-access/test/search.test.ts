import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, rm, stat } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { dirname } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { Check } from "typebox/value";
import {
  MAX_SEARCH_RESPONSE_BYTES,
  SEARCH_TIMEOUT_MS,
  SearchParameters,
  searchDeepSeek as searchWithCredentials,
} from "../src/search.ts";
import { fixture } from "./_server.ts";

const key = "test-only-deepseek-key";
const toHeaders = (apiKey: string) => new Headers({ Authorization: `Bearer ${apiKey}` });

// Supply a fixed credential at the auth boundary for transport/output tests.
function searchDeepSeek(
  args: Parameters<typeof searchWithCredentials>[0],
  apiKey: string,
  signal?: AbortSignal,
  request?: typeof fetch,
) {
  return searchWithCredentials(args, async () => toHeaders(apiKey), signal, request);
}
const entry = {
  title: "API guide",
  url: "https://docs.example.test/guide",
  snippet: "Short excerpt.",
  summary: "Long search-provider summary with useful API details.",
  content: "Full page content.",
  site_name: "Example docs",
  site_icon: "https://docs.example.test/icon.png",
  date: "2026-06-01T00:00:00Z",
  rerank_score: 2.4,
  authority: 3,
};
const response = (results = [entry]) => Response.json({ results });

async function localTransport(t: TestContext, handler: RequestListener): Promise<typeof fetch> {
  const { server } = await fixture(t, handler);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return (url, init) => {
    assert.equal(url, "https://api.deepseek.com/v1/tools/search");
    return fetch(`http://127.0.0.1:${address.port}/v1/tools/search`, init);
  };
}

test("sends only search arguments, preserves operators and provider order, and defaults to ten summaries", async () => {
  let calls = 0;
  const query = '  API site:example.test lang:en after:2025 "release notes"  ';
  const result = await searchDeepSeek({ query }, key, undefined, async (url, init) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    });
    assert.equal(init?.body, JSON.stringify({ query, count: 10, need_content: false }));
    return response([entry, { ...entry, title: "Second result", authority: -1, rerank_score: 0 }]);
  });
  assert.equal(calls, 1);
  const text = result.content[0]?.text ?? "";
  assert.match(text, /1\. API guide[\s\S]*2\. Second result/u);
  assert.ok(text.includes(entry.summary));
  assert.ok(text.includes(entry.url));
  assert.ok(text.includes(entry.date));
  assert.match(text, /Untrusted search results/u);
  assert.doesNotMatch(text, /Full page content|Short excerpt|icon\.png|test-only-deepseek-key/u);
  const { display, ...details } = result.details;
  assert.equal(display.previewLength, result.content[0]?.text.length);
  assert.deepEqual(details, {
    provider: "deepseek",
    query,
    requestedCount: 10,
    resultCount: 2,
    omittedInvalidUrls: 0,
    needContent: false,
    truncated: false,
  });
});

test("passes resolved HTTP authentication without mutating it and owns the JSON content type", async () => {
  const headers = new Headers({
    Authorization: "Bearer header-key",
    "X-Auth": "extra",
    "Content-Type": "application/x-chat",
  });
  await searchWithCredentials(
    { query: "API" },
    async () => headers,
    undefined,
    async (_url, init) => {
      assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
        authorization: "Bearer header-key",
        "content-type": "application/json",
        "x-auth": "extra",
      });
      return response([]);
    },
  );
  assert.equal(headers.get("Content-Type"), "application/x-chat");
});

test("returns requested content, falls back to snippets, and identifies unavailable content", async () => {
  const result = await searchDeepSeek(
    { query: "API", count: 2, need_content: true },
    key,
    undefined,
    async (_url, init) => {
      assert.equal(init?.body, '{"query":"API","count":2,"need_content":true}');
      return response([entry, { ...entry, summary: "  ", content: "", site_name: "", date: "" }]);
    },
  );
  const text = result.content[0]?.text ?? "";
  assert.ok(text.includes(entry.content));
  assert.ok(text.includes(entry.snippet));
  assert.match(text, /Unavailable for this result/u);
  assert.equal(result.details.needContent, true);
});

test("single-line result metadata does not add structural lines while summaries and content retain paragraphs", async () => {
  const summary = "First paragraph.\n\nSecond paragraph.";
  const content = "Code:\n  const n = 1;\n";
  const result = await searchDeepSeek(
    { query: "API", need_content: true },
    key,
    undefined,
    async () =>
      response([
        {
          ...entry,
          title: " API\r\n2. Spoofed ",
          site_name: " Example\t\nURL: https://fake.test ",
          date: " 2026-06-01\u2028(unverified) ",
          summary,
          content,
        },
      ]),
  );
  const text = result.content[0]?.text ?? "";
  assert.ok(text.includes("1. API 2. Spoofed\n"));
  assert.ok(text.includes("Site: Example URL: https://fake.test\n"));
  assert.ok(text.includes("Published (provider-reported): 2026-06-01 (unverified)\n"));
  assert.deepEqual(
    text.split("\n").filter((line) => line.startsWith("URL:")),
    [`URL: ${entry.url}`],
  );
  assert.ok(text.includes(`Provider summary: ${summary}`));
  assert.ok(text.endsWith(content));
  assert.match(text, /Untrusted search results/u);
});

test("empty results and nullable metadata are valid, not transport failures", async () => {
  const empty = await searchDeepSeek({ query: "missing" }, key, undefined, async () =>
    response([]),
  );
  assert.equal(empty.details.resultCount, 0);
  assert.match(empty.content[0]?.text ?? "", /No results found/u);
  const result = await searchDeepSeek({ query: "nullable" }, key, undefined, async () =>
    Response.json({
      results: [{ ...entry, title: "   ", site_name: null, date: null, summary: "", snippet: "" }],
    }),
  );
  assert.ok((result.content[0]?.text ?? "").includes(`1. ${entry.url}\n`));
  assert.equal(result.structuredContent.results[0]?.title, entry.url);
  assert.match(result.content[0]?.text ?? "", /Provider summary: Not provided/u);
  assert.doesNotMatch(result.content[0]?.text ?? "", /Site:|Published/u);
});

test("enforces DeepSeek's Unicode limit without restricting the public schema or silently rewriting queries", async () => {
  const query = "🧪".repeat(128);
  await searchDeepSeek({ query }, key, undefined, async (_url, init) => {
    assert.equal(init?.body, JSON.stringify({ query, count: 10, need_content: false }));
    return response([]);
  });
  assert.equal(Check(SearchParameters, { query: `${query}x` }), true);
  for (const invalid of ["", " \t\n", "a".repeat(129), `${query}x`]) {
    await assert.rejects(
      searchDeepSeek({ query: invalid }, key, undefined, async () => {
        throw new Error("Unexpected network call");
      }),
      /1–128 Unicode/u,
    );
  }
});

for (const [status, message, retryHint] of [
  [400, "Invalid search request", false],
  [401, "Missing or invalid", false],
  [402, "Insufficient", false],
  [403, "denied", false],
  [408, "timed out", true],
  [413, "Search request body is too large", false],
  [422, "Invalid search parameters", false],
  [429, "rate limit", true],
  [500, "failed", true],
  [504, "timed out", true],
  [302, "failed", false],
  [206, "failed", false],
] as const) {
  test(`HTTP ${status} is a sanitized error with no retry`, async () => {
    let calls = 0;
    await assert.rejects(
      searchDeepSeek({ query: "API" }, key, undefined, async () => {
        calls++;
        return new Response(`Untrusted error echo: ${key}`, { status });
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(String(status)));
        assert.ok(error.message.includes(message));
        assert.equal(error.message.includes("This may be transient; retry later."), retryHint);
        assert.ok(!error.message.includes(key));
        return true;
      },
    );
    assert.equal(calls, 1);
  });
}

test("real HTTP transport sends a POST and refuses redirects without forwarding credentials", async (t) => {
  let calls = 0;
  const request = await localTransport(t, (incoming, reply) => {
    calls++;
    assert.equal(incoming.url, "/v1/tools/search");
    assert.equal(incoming.method, "POST");
    assert.equal(incoming.headers.authorization, `Bearer ${key}`);
    reply.writeHead(302, { location: "/credential-leak" }).end();
  });
  await assert.rejects(
    searchDeepSeek({ query: "API" }, key, undefined, request),
    /network or redirect/u,
  );
  assert.equal(calls, 1);
});

test("real HTTP transport reads JSON and preserves the search-only request contract", async (t) => {
  const request = await localTransport(t, (incoming, reply) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => {
      body += chunk;
    });
    incoming.on("end", () => {
      assert.equal(body, '{"query":"API","count":10,"need_content":false}');
      reply.writeHead(200, { "content-type": "Application/JSON; charset=utf-8" });
      reply.write('{"results":[');
      reply.end(`${JSON.stringify(entry)}]}`);
    });
  });
  const result = await searchDeepSeek({ query: "API" }, key, undefined, request);
  assert.equal(result.details.resultCount, 1);
  assert.ok(result.content[0]?.text.includes(entry.summary));
});

for (const [status, headers, diagnostic] of [
  [400, { "content-type": "application/json" }, /HTTP 400/u],
  [200, { "content-type": "text/html" }, /non-JSON/u],
  [
    200,
    { "content-type": "application/json", "content-length": String(MAX_SEARCH_RESPONSE_BYTES + 1) },
    /2 MiB/u,
  ],
] as const) {
  test(`closes an unread HTTP response rejected for ${diagnostic}`, {
    timeout: 5_000,
  }, async (t) => {
    let closed: Promise<unknown[]> | undefined;
    const request = await localTransport(t, (_incoming, reply) => {
      closed = once(reply, "close");
      reply.writeHead(status, headers).write("unfinished body");
    });
    await assert.rejects(searchDeepSeek({ query: "API" }, key, undefined, request), diagnostic);
    assert.ok(closed);
    await closed;
  });
}

test("bounds decompressed response bytes even when the wire payload is small", async (t) => {
  const compressed = gzipSync(
    JSON.stringify({ results: [{ ...entry, content: "x".repeat(MAX_SEARCH_RESPONSE_BYTES) }] }),
  );
  assert.ok(compressed.byteLength < MAX_SEARCH_RESPONSE_BYTES);
  const request = await localTransport(t, (_incoming, reply) => {
    reply
      .writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": compressed.byteLength,
      })
      .end(compressed);
  });
  await assert.rejects(
    searchDeepSeek({ query: "API", need_content: true }, key, undefined, request),
    /2 MiB/u,
  );
});

test("counts streamed chunks cumulatively and closes an oversized HTTP body", {
  timeout: 5_000,
}, async (t) => {
  let closed: Promise<unknown[]> | undefined;
  const request = await localTransport(t, (_incoming, reply) => {
    closed = once(reply, "close");
    reply.writeHead(200, { "content-type": "application/json" });
    reply.write(Buffer.alloc(MAX_SEARCH_RESPONSE_BYTES));
    reply.write(Buffer.alloc(1));
  });
  await assert.rejects(searchDeepSeek({ query: "API" }, key, undefined, request), /2 MiB/u);
  assert.ok(closed);
  await closed;
});

test("transport diagnostics retain known codes without raw messages or arbitrary code values", async () => {
  const failures: [Error, string][] = [
    [new Error(key), ""],
    [new Error(key, { cause: { code: key, message: key } }), ""],
    [new Error(key, { cause: { code: "PRIVATE_CREDENTIAL_VALUE" } }), ""],
    [Object.assign(new Error(key), { code: "ECONNRESET" }), " (ECONNRESET)"],
    ...["ENOTFOUND", "ECONNREFUSED", "CERT_HAS_EXPIRED", "UND_ERR_CONNECT_TIMEOUT"].map(
      (code): [Error, string] => [new Error(key, { cause: { code, message: key } }), ` (${code})`],
    ),
  ];
  let calls = 0;
  for (const [failure, suffix] of failures) {
    await assert.rejects(
      searchDeepSeek({ query: "API" }, key, undefined, async () => {
        calls++;
        throw failure;
      }),
      { message: `Cannot reach DeepSeek Search; network or redirect failure${suffix}.` },
    );
  }
  assert.equal(calls, failures.length);
});

for (const data of [
  null,
  {},
  { results: null },
  { results: [{}] },
  { results: [{ ...entry, summary: 4 }] },
]) {
  test("rejects malformed results instead of treating them as an empty search", async () => {
    await assert.rejects(
      searchDeepSeek({ query: "API" }, key, undefined, async () => Response.json(data)),
      /invalid results schema/u,
    );
  });
}

test("filters unusable URLs before taking the requested number in provider order", async () => {
  const result = await searchDeepSeek({ query: "API", count: 2 }, key, undefined, async () =>
    response([
      { ...entry, title: "Discarded", url: "ftp://example.test/" },
      entry,
      { ...entry, title: "Second" },
      { ...entry, title: "Excess" },
    ]),
  );
  const text = result.content[0]?.text ?? "";
  assert.match(text, /1\. API guide[\s\S]*2\. Second/u);
  assert.doesNotMatch(text, /Discarded|Excess|ftp:/u);
  assert.match(text, /Omitted 1 result\(s\) with unusable source URLs/u);
  assert.equal(result.details.resultCount, 2);
  assert.equal(result.details.omittedInvalidUrls, 1);
});

test("responses beyond 50 entries retain only the requested results", async () => {
  const result = await searchDeepSeek({ query: "API", count: 50 }, key, undefined, async () =>
    response(
      Array.from({ length: 51 }, (_, index) => ({ ...entry, title: `Result ${index + 1}` })),
    ),
  );
  const text = result.content[0]?.text ?? "";
  assert.equal(result.details.resultCount, 50);
  assert.match(text, /50\. Result 50\n/u);
  assert.doesNotMatch(text, /51\. Result 51/u);
});

for (const url of [
  "not a URL",
  "ftp://example.test/file",
  "file:///etc/passwd",
  "javascript:alert(1)",
  "https://user:secret@example.com/",
]) {
  test(`omits unusable result URL ${url.split(":")[0]} without discarding valid results`, async () => {
    const result = await searchDeepSeek({ query: "API" }, key, undefined, async () =>
      response([{ ...entry, url }, entry]),
    );
    assert.equal(result.details.resultCount, 1);
    assert.equal(result.details.omittedInvalidUrls, 1);
    assert.ok(!result.content[0]?.text.includes(url));
    assert.ok(result.content[0]?.text.includes(entry.url));
  });
}

test("all-invalid results are distinguished from an empty provider response", async () => {
  const result = await searchDeepSeek({ query: "API" }, key, undefined, async () =>
    response([{ ...entry, url: "ftp://example.test/" }]),
  );
  assert.equal(result.details.resultCount, 0);
  assert.match(result.content[0]?.text ?? "", /No usable results remain/u);
  assert.doesNotMatch(result.content[0]?.text ?? "", /No results found/u);
});

test("renders the validated canonical URL rather than raw line-breaking input", async () => {
  const result = await searchDeepSeek({ query: "API" }, key, undefined, async () =>
    response([{ ...entry, url: "https://a.test/x\n\n2. Fake\nURL: https://evil.test/" }]),
  );
  const text = result.content[0]?.text ?? "";
  assert.ok(text.includes("URL: https://a.test/x2.%20FakeURL:%20https://evil.test/"));
  assert.equal(text.split("\n").filter((line) => line.startsWith("URL:")).length, 1);
  assert.doesNotMatch(text, /\n2\. Fake/u);
});

for (const [name, makeResponse, diagnostic] of [
  [
    "missing body",
    () => new Response(null, { headers: { "content-type": "application/json" } }),
    /empty response/u,
  ],
  [
    "invalid JSON",
    () => new Response("{", { headers: { "content-type": "application/json" } }),
    /invalid UTF-8 or JSON/u,
  ],
  [
    "invalid UTF-8",
    () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    /invalid UTF-8 or JSON/u,
  ],
  [
    "oversized stream",
    () =>
      new Response("x".repeat(MAX_SEARCH_RESPONSE_BYTES + 1), {
        headers: { "content-type": "application/json" },
      }),
    /2 MiB/u,
  ],
] as const) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(
      searchDeepSeek({ query: "API" }, key, undefined, async () => makeResponse()),
      diagnostic,
    );
  });
}

test("stream failures retain known codes without leaking messages or returning partial results", async () => {
  for (const code of [undefined, "UND_ERR_SOCKET"]) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(Object.assign(new Error(key), { code }));
      },
    });
    await assert.rejects(
      searchDeepSeek(
        { query: "API" },
        key,
        undefined,
        async () => new Response(body, { headers: { "content-type": "application/json" } }),
      ),
      { message: `DeepSeek Search response stream failed${code ? ` (${code})` : ""}.` },
    );
  }
});

test("a real HTTP body disconnect retains the native transport code", async (t) => {
  let disconnect: (() => void) | undefined;
  const request = await localTransport(t, (_incoming, reply) => {
    disconnect = () => reply.destroy();
    reply.writeHead(200, { "content-type": "application/json" }).write('{"results":[');
  });
  await assert.rejects(
    searchDeepSeek({ query: "API" }, key, undefined, async (url, init) => {
      const response = await request(url, init);
      assert.ok(disconnect);
      disconnect();
      return response;
    }),
    { message: "DeepSeek Search response stream failed (UND_ERR_SOCKET)." },
  );
});

test("pre-cancelled searches never reach the network", async () => {
  await assert.rejects(
    searchDeepSeek({ query: "API" }, key, AbortSignal.abort(new Error("cancelled")), async () => {
      throw new Error("Unexpected network call");
    }),
    /cancelled/u,
  );
});

test("cancellation closes real network work while awaiting the body", async (t) => {
  const controller = new AbortController();
  const request = await localTransport(t, (_incoming, reply) => {
    reply.writeHead(200, { "content-type": "application/json" }).write('{"results":[');
  });
  const cancellation = new Error("caller cancelled");
  await assert.rejects(
    searchDeepSeek({ query: "API" }, key, controller.signal, async (url, init) => {
      const reply = await request(url, init);
      // Schedule after response handling has had a chance to start reading the body.
      setImmediate(() => controller.abort(cancellation));
      return reply;
    }),
    /caller cancelled/u,
  );
});

test("the total deadline aborts the outbound request without retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let started: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = searchDeepSeek({ query: "API" }, key, undefined, async (_url, init) => {
    calls++;
    started?.();
    const signal = init?.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const rejected = assert.rejects(pending, /timed out after 120 seconds/u);
  assert.equal(SEARCH_TIMEOUT_MS, 120_000);
  await requestStarted;
  t.mock.timers.tick(SEARCH_TIMEOUT_MS);
  await rejected;
  assert.equal(calls, 1);
});

test("cancellation stops waiting for Pi credentials and prevents late requests", async () => {
  let finish: ((key: string) => void) | undefined;
  const credential = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const controller = new AbortController();
  let calls = 0;
  const pending = searchWithCredentials(
    { query: "API" },
    () => credential.then(toHeaders),
    controller.signal,
    async () => {
      calls++;
      return response();
    },
  );
  const rejected = assert.rejects(pending, /caller cancelled/u);
  controller.abort(new Error("caller cancelled"));
  await rejected;
  assert.ok(finish);
  finish(key);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("cancellation racing credential completion sends no HTTP request", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  const request = await localTransport(t, (_incoming, reply) => {
    calls++;
    reply.writeHead(200, { "content-type": "application/json" }).end('{"results":[]}');
  });
  await assert.rejects(
    searchWithCredentials(
      { query: "API" },
      async () => {
        queueMicrotask(() => controller.abort(new Error("caller cancelled")));
        return toHeaders(key);
      },
      controller.signal,
      request,
    ),
    /caller cancelled/u,
  );
  assert.equal(calls, 0);
});

test("a late credential rejection remains handled after cancellation", async () => {
  let fail: ((reason: Error) => void) | undefined;
  const credential = new Promise<Headers>((_resolve, reject) => {
    fail = reject;
  });
  const controller = new AbortController();
  let calls = 0;
  const pending = searchWithCredentials(
    { query: "API" },
    () => credential,
    controller.signal,
    async () => {
      calls++;
      return response();
    },
  );
  const rejected = assert.rejects(pending, /caller cancelled/u);
  controller.abort(new Error("caller cancelled"));
  await rejected;
  assert.ok(fail);
  fail(new Error("late secret-manager failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("backend query errors and pre-cancellation do not resolve credentials", async () => {
  let resolutions = 0;
  const resolveKey = async () => {
    resolutions++;
    return toHeaders(key);
  };
  await assert.rejects(
    searchWithCredentials({ query: "x".repeat(129) }, resolveKey),
    /1–128 Unicode/u,
  );
  await assert.rejects(
    searchWithCredentials({ query: "API" }, resolveKey, AbortSignal.abort(new Error("cancelled"))),
    /cancelled/u,
  );
  assert.equal(resolutions, 0);
});

test("credential resolution consumes the network deadline rather than resetting it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish: ((key: string) => void) | undefined;
  const credential = new Promise<string>((resolve) => {
    finish = resolve;
  });
  let started: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = searchWithCredentials(
    { query: "API" },
    () => credential.then(toHeaders),
    undefined,
    async (_url, init) => {
      const signal = init?.signal;
      assert.ok(signal);
      started?.();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  );
  const rejected = assert.rejects(pending, /timed out after 120 seconds/u);
  t.mock.timers.tick(60_000);
  assert.ok(finish);
  finish(key);
  await requestStarted;
  t.mock.timers.tick(60_000);
  await rejected;
});

test("the same total deadline bounds credential resolution", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const pending = searchWithCredentials(
    { query: "API" },
    () => new Promise(() => {}),
    undefined,
    async () => {
      calls++;
      return response();
    },
  );
  const rejected = assert.rejects(pending, /timed out after 120 seconds/u);
  t.mock.timers.tick(120_000);
  await rejected;
  assert.equal(calls, 0);
});

test("the deadline also covers a stalled response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started: (() => void) | undefined;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = searchDeepSeek({ query: "API" }, key, undefined, async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            started?.();
            return new Promise<void>((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  controller.error(signal.reason);
                  resolve();
                },
                { once: true },
              );
            });
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "application/json" } },
    );
  });
  const rejected = assert.rejects(pending, /timed out after 120 seconds/u);
  await reading;
  t.mock.timers.tick(SEARCH_TIMEOUT_MS);
  await rejected;
});

for (const content of ["line\n".repeat(2100), "世界".repeat(12_000)]) {
  test("truncated results retain complete content in a private file", async (t) => {
    const result = await searchDeepSeek(
      { query: "API", need_content: true },
      key,
      undefined,
      async () => response([{ ...entry, content }]),
    );
    const path = result.details.fullOutputPath;
    assert.ok(path);
    t.after(() => rm(dirname(path), { recursive: true, force: true }));
    assert.equal(result.details.truncated, true);
    const text = result.content[0]?.text ?? "";
    assert.ok(text.includes(path));
    assert.match(text, /Output truncated/u);
    assert.doesNotMatch(text, /\uFFFD/u);
    assert.ok(Buffer.byteLength(text) < 53_000);
    assert.ok((await readFile(path, "utf8")).endsWith(content));
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    }
  });
}
