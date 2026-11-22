import assert from "node:assert/strict";
import { once } from "node:events";
import fs, { access, readFile, rm, stat } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
import { test, type TestContext } from "node:test";
import { Check } from "typebox/value";
import {
  FETCH_TIMEOUT_MS,
  FetchParameters,
  fetchDeepSeek,
  MAX_FETCH_RESPONSE_BYTES,
} from "../src/fetch.ts";
import { fixture } from "./_server.ts";

const key = "fetch-test-only-key";
const credentials = () => new Headers({ Authorization: `Bearer ${key}` });
const url = "https://example.test/article";
const page = { title: "An article", content: "# An article\n\nProvider Markdown.\n" };
const response = () => Response.json(page);

async function localTransport(t: TestContext, handler: RequestListener): Promise<typeof fetch> {
  const { server } = await fixture(t, handler);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return (endpoint, init) => {
    assert.equal(endpoint, "https://api.deepseek.com/v1/tools/fetch");
    return fetch(`http://127.0.0.1:${address.port}/v1/tools/fetch`, init);
  };
}

test("sends only a normalized URL to the fixed Fetch endpoint, owning JSON Content-Type and refusing redirects", async () => {
  const headers = new Headers({
    authorization: `Bearer ${key}`,
    "content-type": "text/plain",
  });
  let calls = 0;
  const result = await fetchDeepSeek(
    " HTTPS://EXAMPLE.test:443/article#private-fragment ",
    () => headers,
    undefined,
    async (endpoint, init) => {
      calls++;
      assert.equal(endpoint, "https://api.deepseek.com/v1/tools/fetch");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.body, '{"url":"https://example.test/article"}');
      assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      });
      return response();
    },
  );
  assert.equal(calls, 1);
  assert.equal(headers.get("content-type"), "text/plain");
  const { display, ...details } = result.details;
  assert.equal(display.previewLength, result.content[0]?.text.length);
  assert.deepEqual(details, {
    provider: "deepseek",
    url,
    title: page.title,
    truncated: false,
  });
  const text = result.content[0]?.text ?? "";
  assert.match(text, /Provider: DeepSeek Fetch/u);
  assert.match(text, /Requested URL: https:\/\/example.test\/article/u);
  assert.match(text, /Untrusted provider-returned web content/u);
  assert.match(text, /completeness is not guaranteed/u);
  assert.ok(text.endsWith(page.content));
  assert.doesNotMatch(text, /private-fragment|fetch-test-only-key|Content-Type:/u);
});

test("preserves provider Markdown and paragraphs without local HTML extraction, with single-line titles", async () => {
  const content = "\n# 标题\n\n<b>Literal HTML</b>\n\n```js\n  const n = 1;\n```\n";
  for (const title of ["  Page\r\nTitle\u2028Here ", ""]) {
    const result = await fetchDeepSeek(url, credentials, undefined, async () =>
      Response.json({ title, content, extra: true }),
    );
    const text = result.content[0]?.text ?? "";
    assert.ok(text.includes(`Title: ${title ? "Page Title Here" : "Not provided."}\n`));
    assert.ok(text.endsWith(content));
  }
});

test("the registered fetch schema bounds input and disallows per-call credentials or provider selection", () => {
  for (const args of [
    { url },
    { url, max_age_hours: -1 },
    { url, max_age_hours: 0 },
    { url, max_age_hours: 720 },
    { url: `https://example.test/${"a".repeat(8192 - 21)}` },
  ]) {
    assert.equal(Check(FetchParameters, args), true);
  }
  for (const args of [
    {},
    { url: "" },
    { url: null },
    { url: "x".repeat(8193) },
    { url, max_age_hours: -2 },
    { url, max_age_hours: 721 },
    { url, max_age_hours: 1.5 },
    { url, apiKey: key },
    { url, provider: "other" },
  ]) {
    assert.equal(Check(FetchParameters, args), false);
  }
});

test("DeepSeek Fetch rejects max_age_hours and pre-cancellation before resolving credentials", async () => {
  let resolutions = 0;
  const countAuth = () => {
    resolutions++;
    return credentials();
  };
  await assert.rejects(
    fetchDeepSeek(url, countAuth, undefined, async () => response(), { maxAgeHours: 0 }),
    /DeepSeek Fetch does not support max_age_hours/u,
  );
  await assert.rejects(
    fetchDeepSeek(url, countAuth, AbortSignal.abort(new Error("cancelled")), async () =>
      response(),
    ),
    /cancelled/u,
  );
  assert.equal(resolutions, 0);
});

for (const input of [
  "",
  "relative/path",
  "//example.test",
  "file:///tmp/page",
  "ftp://example.test/page",
  "javascript:alert(1)",
  "https://user:secret@example.test",
  `https://example.test/${"a".repeat(8192)}`,
  `https://example.test/${"界".repeat(1000)}`,
]) {
  test(`invalid or oversized URL is rejected before authentication (${input.slice(0, 40)})`, async () => {
    let resolutions = 0;
    let calls = 0;
    await assert.rejects(
      fetchDeepSeek(
        input,
        () => {
          resolutions++;
          return credentials();
        },
        undefined,
        async () => {
          calls++;
          return response();
        },
      ),
      /URL/u,
    );
    assert.equal(resolutions, 0);
    assert.equal(calls, 0);
  });
}

test("supports HTTP URLs and the documented 8192-character limit without contacting the target", async () => {
  for (const input of [
    "http://127.0.0.1/private",
    `https://example.test/${"a".repeat(8192 - 21)}`,
  ]) {
    await fetchDeepSeek(input, credentials, undefined, async (endpoint, init) => {
      assert.equal(endpoint, "https://api.deepseek.com/v1/tools/fetch");
      assert.equal(init?.body, JSON.stringify({ url: input }));
      return response();
    });
  }
});

for (const [status, diagnostic] of [
  [400, "Invalid fetch request."],
  [401, "Missing or invalid DeepSeek API key."],
  [402, "Insufficient DeepSeek account balance."],
  [403, "Fetch denied by the security policy."],
  [404, "No usable page content could be retrieved."],
  [408, "Request timed out. This may be transient; retry later."],
  [413, "Fetch request body is too large."],
  [422, "Invalid fetch parameters."],
  [429, "DeepSeek fetch rate limit exceeded. This may be transient; retry later."],
  [500, "Fetch request failed. This may be transient; retry later."],
  [504, "Upstream fetch timed out. This may be transient; retry later."],
  [302, "Fetch request failed."],
  [206, "Fetch request failed."],
] as const) {
  test(`HTTP ${status} is sanitized without retry or direct-fetch fallback`, async () => {
    let calls = 0;
    await assert.rejects(
      fetchDeepSeek(url, credentials, undefined, async () => {
        calls++;
        return new Response(`PRIVATE ${key}`, { status });
      }),
      { message: `DeepSeek Fetch HTTP ${status}: ${diagnostic}` },
    );
    assert.equal(calls, 1);
  });
}

for (const data of [
  null,
  [],
  {},
  { title: null, content: "text" },
  { title: "Title" },
  { title: "Title", content: 42 },
]) {
  test(`rejects invalid page schema ${JSON.stringify(data)}`, async () => {
    await assert.rejects(
      fetchDeepSeek(url, credentials, undefined, async () => Response.json(data)),
      /invalid page schema/u,
    );
  });
}
for (const content of ["", " \n\t"]) {
  test(`reports empty provider content (${content.length} characters)`, async () => {
    await assert.rejects(
      fetchDeepSeek(url, credentials, undefined, async () =>
        Response.json({ title: "Empty", content }),
      ),
      /no readable page content/u,
    );
  });
}
test("closes HTTP streams exceeding the cumulative decoded response limit", {
  timeout: 5000,
}, async (t) => {
  let closed: Promise<unknown[]> | undefined;
  const request = await localTransport(t, (_incoming, reply) => {
    closed = once(reply, "close");
    reply.writeHead(200, { "content-type": "application/json" });
    reply.write(Buffer.alloc(MAX_FETCH_RESPONSE_BYTES));
    reply.write(Buffer.alloc(1));
  });
  await assert.rejects(fetchDeepSeek(url, credentials, undefined, request), /2 MiB/u);
  assert.ok(closed);
  await closed;
});

test("enforces a 60-second total deadline across stalled requests and response bodies", {
  timeout: 5000,
}, async (t) => {
  assert.equal(FETCH_TIMEOUT_MS, 60_000);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closed: Promise<unknown[]> | undefined;
  const request = await localTransport(t, (_incoming, reply) => {
    closed = once(reply, "close");
    reply.writeHead(200, { "content-type": "application/json" }).flushHeaders();
  });
  await assert.rejects(
    fetchDeepSeek(url, credentials, undefined, async (endpoint, init) => {
      const reply = await request(endpoint, init);
      t.mock.timers.tick(FETCH_TIMEOUT_MS);
      return reply;
    }),
    /DeepSeek Fetch timed out after 60 seconds/u,
  );
  assert.ok(closed);
  await closed;
});

for (const content of ["Line\n".repeat(2100), "世界".repeat(12_000)]) {
  test("long provider content is retained in a private file with a bounded UTF-8 preview", async (t) => {
    const result = await fetchDeepSeek(url, credentials, undefined, async () =>
      Response.json({ title: "Long", content }),
    );
    const path = result.details.fullOutputPath;
    assert.ok(path);
    t.after(() => rm(dirname(path), { recursive: true, force: true }));
    const preview = result.content[0]?.text ?? "";
    assert.match(preview, /Output truncated.*Full fetched content/su);
    assert.ok(preview.includes(path));
    assert.ok(Buffer.byteLength(preview) < 53_000);
    assert.doesNotMatch(preview, /\uFFFD/u);
    assert.ok((await readFile(path, "utf8")).endsWith(content));
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    }
  });
}

for (const ending of ["write failure", "cancellation", "deadline"] as const) {
  test(`output cleanup removes partial files on ${ending}`, async (t) => {
    const controller = new AbortController();
    const writeFile = fs.writeFile;
    let path: string | undefined;
    if (ending === "deadline") t.mock.timers.enable({ apis: ["setTimeout"] });
    const mocked = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof writeFile>) => {
      assert.ok(typeof args[0] === "string");
      path = args[0];
      await writeFile(...args);
      if (ending === "write failure") throw new Error("storage unavailable");
      if (ending === "cancellation") controller.abort(new Error("caller cancelled"));
      if (ending === "deadline") t.mock.timers.tick(60_000);
    });
    syncBuiltinESMExports();
    t.after(async () => {
      mocked.mock.restore();
      syncBuiltinESMExports();
      if (path) await rm(dirname(path), { recursive: true, force: true });
    });
    const message =
      ending === "write failure"
        ? "storage unavailable"
        : ending === "cancellation"
          ? "caller cancelled"
          : "DeepSeek Fetch timed out after 60 seconds.";
    await assert.rejects(
      fetchDeepSeek(url, credentials, controller.signal, async () =>
        Response.json({ title: "Long", content: "line\n".repeat(2100) }),
      ),
      { message },
    );
    assert.ok(path);
    await assert.rejects(access(dirname(path)), { code: "ENOENT" });
  });
}
