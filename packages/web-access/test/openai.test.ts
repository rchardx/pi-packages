import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { searchOpenAI } from "../src/providers/openai.ts";
import { fixture } from "./_server.ts";

const secret = "sk-openai-test-secret";
const auth = async () => new Headers({ Authorization: `Bearer ${secret}` });

function sseBody(events: object[], separator = "\n"): string {
  return events
    .map(
      (event) =>
        `event: ${"type" in event ? event.type : "x"}${separator}data: ${JSON.stringify(event)}${separator}${separator}`,
    )
    .join("");
}

function sse(events: object[]): Response {
  return new Response(sseBody(events), { headers: { "content-type": "text/event-stream" } });
}

const searchCall = (sources: string[] = [], status = "completed") => ({
  type: "response.output_item.done",
  item: {
    type: "web_search_call",
    id: "ws_1",
    status,
    action: { type: "search", query: "q", sources: sources.map((url) => ({ type: "url", url })) },
  },
});
const message = (text: string, citations: Array<{ url: string; title?: string }> = []) => ({
  type: "response.output_item.done",
  item: {
    type: "message",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
        annotations: citations.map((citation) => ({ type: "url_citation", ...citation })),
      },
    ],
  },
});
const completed = { type: "response.completed", response: { status: "completed", output: [] } };

test("OpenAI Search streams Responses web_search and orders cited sources ahead of searched sources", async () => {
  let calls = 0;
  const result = await searchOpenAI(
    "openai",
    { query: "Node.js releases", count: 3 },
    auth,
    {},
    undefined,
    async (endpoint, init) => {
      calls++;
      assert.equal(endpoint, "https://api.openai.com/v1/responses");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
        accept: "text/event-stream",
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.model, "gpt-6-luna");
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.deepEqual(body.tools, [{ type: "web_search" }]);
      assert.deepEqual(body.include, ["web_search_call.action.sources"]);
      assert.deepEqual(body.input, [
        { role: "user", content: [{ type: "input_text", text: "Node.js releases" }] },
      ]);
      assert.match(String(body.instructions), /untrusted data/u);
      return sse([
        { type: "response.created", response: { status: "in_progress" } },
        message("I will search first."),
        searchCall([
          "https://nodejs.org/en/about",
          "javascript:alert(1)",
          "https://nodejs.org/en/blog",
          "https://nodejs.org/en/download",
          "https://nodejs.org/en/extra",
        ]),
        { type: "response.output_text.delta", delta: "ignored deltas" },
        message("Node 26 shipped ", [
          { url: "https://nodejs.org/en/blog", title: "Node blog" },
          { url: "https://example.test/cited-only", title: "Cited only" },
        ]),
        message("security fixes."),
        completed,
      ]);
    },
  );
  assert.equal(calls, 1);
  const text = result.content[0]?.text ?? "";
  assert.match(text, /Provider: OpenAI Search \(gpt-6-luna\)/u);
  assert.match(text, /Omitted 1 result\(s\) with unusable source URLs\./u);
  assert.match(text, /Provider synthesis:\nNode 26 shipped \n\nsecurity fixes\.\n\n1\. Node blog/u);
  assert.doesNotMatch(text, /I will search first|ignored deltas|javascript:|sk-openai/u);
  assert.match(
    text,
    /1\. Node blog\nURL: https:\/\/nodejs\.org\/en\/blog\n\n2\. Cited only\nURL: https:\/\/example\.test\/cited-only\n\n3\. https:\/\/nodejs\.org\/en\/about\nURL: https:\/\/nodejs\.org\/en\/about$/u,
  );
  const { display, ...details } = result.details;
  assert.ok(display.synthesis);
  assert.deepEqual(details, {
    provider: "openai",
    model: "gpt-6-luna",
    query: "Node.js releases",
    requestedCount: 3,
    resultCount: 3,
    omittedInvalidUrls: 1,
    needContent: false,
    truncated: false,
  });
});

test("OpenAI attribution parameters do not split one page into duplicate sources", async () => {
  const docs = "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html";
  const beta = "https://devblogs.microsoft.com/typescript/announcing-typescript-6-0-beta/";
  const result = await searchOpenAI(
    "openai",
    { query: "TypeScript 6 release notes" },
    auth,
    {},
    undefined,
    async () =>
      sse([
        searchCall([
          docs,
          `${beta}?cmid=a%20b&utm_source=openai`,
          "https://example.test/?utm_source=openaix",
        ]),
        message(`See [docs](${docs}?utm_source=openai).`, [
          { url: `${docs}?utm_source=openai`, title: "TypeScript 6.0" },
          { url: `${beta}?utm_source=openai`, title: "Beta" },
        ]),
        completed,
      ]),
  );
  const text = result.content[0]?.text ?? "";
  // The synthesis is provider output and stays unchanged.
  assert.match(
    text,
    /See \[docs\]\(https:\/\/www\.typescriptlang\.org\/[^)]+\?utm_source=openai\)\./u,
  );
  const urls = [...text.matchAll(/^URL: (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(urls, [
    docs,
    beta,
    `${beta}?cmid=a%20b`,
    "https://example.test/?utm_source=openaix",
  ]);
  assert.match(text, /1\. TypeScript 6\.0\nURL: /u);
  assert.equal(result.details.resultCount, 4);
});

test("OpenAI Codex Search uses the Codex endpoint without unsupported include fields", async () => {
  const result = await searchOpenAI(
    "openai-codex",
    { query: "Codex", need_content: true },
    auth,
    { model: "gpt-6-sol" },
    undefined,
    async (endpoint, init) => {
      assert.equal(endpoint, "https://chatgpt.com/backend-api/codex/responses");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.model, "gpt-6-sol");
      assert.equal("include" in body, false);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal(typeof body.instructions, "string");
      // CRLF event framing is accepted.
      return new Response(sseBody([searchCall(), message("Answer."), completed], "\r\n"), {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  );
  const text = result.content[0]?.text ?? "";
  assert.match(text, /Provider: OpenAI Codex Search \(gpt-6-sol\)/u);
  assert.match(text, /OpenAI Codex Search returns synthesis and source citations/u);
  assert.match(text, /Provider synthesis:\nAnswer\.\n\nNo source URLs returned\./u);
  assert.equal(result.details.provider, "openai-codex");
});

test("search streams default to SSE when Content-Type is absent and honor explicit types", async () => {
  const events = [
    searchCall(),
    message("Headerless answer.", [{ url: "https://example.test/cited", title: "Cited" }]),
    completed,
  ];
  const bytes = new TextEncoder().encode(sseBody(events));
  const run = (response: Response, provider: "openai" | "openai-codex" = "openai-codex") =>
    searchOpenAI(provider, { query: "test" }, auth, {}, undefined, async () => response);
  for (const provider of ["openai", "openai-codex"] as const) {
    const result = await run(new Response(bytes), provider);
    assert.equal(result.details.provider, provider);
    assert.equal(result.details.resultCount, 1);
    assert.match(result.content[0]?.text ?? "", /Headerless answer\./u);
    assert.match(result.content[0]?.text ?? "", /URL: https:\/\/example\.test\/cited/u);
  }
  await assert.rejects(
    run(new Response(bytes, { headers: { "content-type": "text/html" } })),
    /non-event-stream response/u,
  );
  await assert.rejects(run(new Response(new TextEncoder().encode(`<html>${secret}</html>`))), {
    message: "OpenAI Codex Search event stream ended before the response completed.",
  });
});

test("Codex response.done ends the stream with its outcome taken from the response status", async (t) => {
  const done = (response: object) => ({ type: "response.done", response });
  const run = (events: object[]) =>
    searchOpenAI("openai-codex", { query: "test" }, auth, {}, undefined, async () => sse(events));
  const answer = message("Codex answer.", [{ url: "https://example.test/cited", title: "Cited" }]);

  const success = await run([
    searchCall(["https://example.test/a"]),
    answer,
    done({ status: "completed" }),
  ]);
  assert.match(
    success.content[0]?.text ?? "",
    /Provider synthesis:\nCodex answer\.\n\n1\. Cited\nURL: https:\/\/example\.test\/cited/u,
  );
  // A status-less done event (normalized away by Pi for unknown statuses) is a normal completion.
  await run([searchCall(), answer, done({})]);

  const truncated = await run([
    searchCall(),
    answer,
    done({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
  ]);
  assert.equal(truncated.details.outputTokenLimitReached, true);
  await assert.rejects(
    run([searchCall(), answer, done({ status: "failed", error: { code: "server_error" } })]),
    { message: "OpenAI Codex Search failed: server error. This may be transient; retry later." },
  );

  // With a live connection left open after response.done, reading stops instead of waiting.
  const { server } = await fixture(t, (_request, reply) => {
    reply.writeHead(200, { "content-type": "text/event-stream" });
    reply.write(sseBody([searchCall(), answer, done({ status: "completed" })]));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const live = await searchOpenAI(
    "openai-codex",
    { query: "test" },
    auth,
    {},
    undefined,
    (_e, init) => fetch(`http://127.0.0.1:${address.port}/`, init),
  );
  assert.equal(live.details.provider, "openai-codex");
});

test("OpenAI Search fails closed on ungrounded, failed, refused, or incomplete responses", async () => {
  const run = (events: object[]) =>
    searchOpenAI("openai", { query: "test" }, auth, {}, undefined, async () => sse(events));
  await assert.rejects(run([message("From memory."), completed]), /without invoking web_search/u);
  await assert.rejects(
    run([searchCall([], "failed"), message("Sorry."), completed]),
    /web_search failed to retrieve results.*retry later/u,
  );
  await assert.rejects(
    run([
      searchCall(),
      {
        type: "response.output_item.done",
        item: { type: "message", content: [{ type: "refusal", refusal: "No." }] },
      },
      completed,
    ]),
    /refused to complete/u,
  );
  await assert.rejects(
    run([
      searchCall(),
      {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "content_filter" } },
      },
    ]),
    /refused to complete/u,
  );
  await assert.rejects(
    run([searchCall(), { type: "response.incomplete", response: { incomplete_details: null } }]),
    /stopped before completing/u,
  );
  for (const [event, expected] of [
    [
      {
        type: "response.failed",
        response: { error: { code: "rate_limit_exceeded", message: secret } },
      },
      "OpenAI Search failed: rate limit exceeded. This may be transient; retry later.",
    ],
    [
      { type: "error", code: "toString", message: `raw ${secret}` },
      "OpenAI Search failed to complete the request.",
    ],
    [
      { type: "response.failed", response: { error: null } },
      "OpenAI Search failed to complete the request.",
    ],
  ] as const) {
    await assert.rejects(run([searchCall(["https://example.test"]), event]), { message: expected });
  }

  const truncated = await run([
    searchCall(["https://example.test/a"]),
    message("Partial"),
    {
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } },
    },
  ]);
  assert.equal(truncated.details.outputTokenLimitReached, true);
  assert.match(
    truncated.content[0]?.text ?? "",
    /\[Provider synthesis reached the model token limit and is incomplete\.\]$/u,
  );
});

test("OpenAI Search validates stream framing, encoding, status, and size without leaking bodies", async (t) => {
  const run = (response: () => Response) =>
    searchOpenAI("openai", { query: "test" }, auth, {}, undefined, async () => response());
  await assert.rejects(
    run(() => new Response(`{"error":"${secret}"}`, { status: 401 })),
    { message: "OpenAI Search HTTP 401: Missing or invalid OpenAI credentials." },
  );
  for (const [provider, model] of [
    ["openai", undefined],
    ["openai-codex", "retired-model"],
  ] as const) {
    await assert.rejects(
      searchOpenAI(
        provider,
        { query: "test" },
        auth,
        model ? { model } : {},
        undefined,
        async () => new Response(`raw ${secret}`, { status: 404 }),
      ),
      {
        message:
          `${provider === "openai" ? "OpenAI Search" : "OpenAI Codex Search"} HTTP 404: ` +
          `Requested model "${model ?? "gpt-6-luna"}" was not found; set search.providers.${provider}.model in web-access.json to an available model.`,
      },
    );
  }
  await assert.rejects(
    run(() => new Response("", { status: 429 })),
    /HTTP 429: OpenAI search rate limit exceeded\. This may be transient; retry later\./u,
  );
  await assert.rejects(
    run(() => Response.json({ ok: true })),
    /non-event-stream response/u,
  );
  await assert.rejects(
    run(
      () =>
        new Response("data: {not json}\n\n", { headers: { "content-type": "text/event-stream" } }),
    ),
    /invalid event stream/u,
  );
  await assert.rejects(
    run(
      () =>
        new Response(new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0xff, 0x0a, 0x0a]), {
          headers: { "content-type": "text/event-stream" },
        }),
    ),
    /invalid UTF-8/u,
  );
  await assert.rejects(
    run(() => sse([searchCall(), message("No terminal event.")])),
    /event stream ended before the response completed/u,
  );
  await assert.rejects(
    searchOpenAI("openai", { query: "   " }, async () => {
      throw new Error("must not resolve credentials");
    }),
    /non-blank query/u,
  );

  // A real stream is read incrementally, stops at the terminal event even if the
  // connection stays open, and closes oversized bodies at the 2 MiB limit.
  const { server } = await fixture(t, (request, reply) => {
    reply.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url === "/open") {
      const bytes = Buffer.from(
        sseBody([searchCall(["https://example.test/live"]), message("Live 界."), completed]),
      );
      // Split inside a multi-byte character; the connection then stays open.
      const split = bytes.indexOf(Buffer.from("界")) + 1;
      reply.write(bytes.subarray(0, split));
      setTimeout(() => reply.write(bytes.subarray(split)), 10);
      return;
    }
    reply.write(`data: ${JSON.stringify(message("x".repeat(1024 * 1024)))}\n\n`);
    reply.write(`data: ${JSON.stringify(message("x".repeat(1024 * 1024)))}\n\n`);
    reply.end();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const local =
    (path: string): typeof fetch =>
    (_endpoint, init) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, init);
  const live = await searchOpenAI("openai", { query: "test" }, auth, {}, undefined, local("/open"));
  assert.match(live.content[0]?.text ?? "", /Live 界\./u);
  await assert.rejects(
    searchOpenAI("openai", { query: "test" }, auth, {}, undefined, local("/large")),
    /response exceeds the 2 MiB limit/u,
  );
});

test("OpenAI Search honors cancellation before and during the stream", async (t: TestContext) => {
  const aborted = AbortSignal.abort(new Error("caller cancelled"));
  await assert.rejects(
    searchOpenAI("openai", { query: "test" }, auth, {}, aborted, async () => {
      throw new Error("Unexpected network call");
    }),
    /caller cancelled/u,
  );
  const { server } = await fixture(t, (_request, reply) => {
    reply.writeHead(200, { "content-type": "text/event-stream" });
    reply.write(sseBody([searchCall()]));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const controller = new AbortController();
  const pending = searchOpenAI(
    "openai",
    { query: "test" },
    auth,
    {},
    controller.signal,
    (_endpoint, init) => fetch(`http://127.0.0.1:${address.port}/`, init),
  );
  setTimeout(() => controller.abort(new Error("caller cancelled mid-stream")), 50);
  await assert.rejects(pending, /caller cancelled mid-stream/u);
});
