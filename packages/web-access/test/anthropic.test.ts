import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { dirname } from "node:path";
import { test, type TestContext } from "node:test";
import type { AnthropicRequestAuth } from "../src/auth.ts";
import {
  ANTHROPIC_MAX_QUERY_CHARACTERS,
  DEFAULT_ANTHROPIC_MODEL,
  fetchAnthropic,
  searchAnthropic,
} from "../src/providers/anthropic.ts";
import { fixture } from "./_server.ts";

const secret = "sk-ant-api03-test-secret";
const apiKeyAuth = async (): Promise<AnthropicRequestAuth> => ({
  headers: new Headers({
    "anthropic-version": "2023-06-01",
    "x-api-key": secret,
  }),
  isOAuth: false,
});
const oauthAuth = async (): Promise<AnthropicRequestAuth> => ({
  headers: new Headers({
    "anthropic-version": "2023-06-01",
    authorization: "Bearer sk-ant-oat01-test-token",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    "user-agent": "claude-cli/2.1.322",
    "x-app": "cli",
  }),
  isOAuth: true,
});

async function localMessagesTransport(
  t: TestContext,
  handler: RequestListener,
): Promise<typeof fetch> {
  const { server } = await fixture(t, handler);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return (endpoint, init) => {
    assert.equal(endpoint, "https://api.anthropic.com/v1/messages");
    return fetch(`http://127.0.0.1:${address.port}/v1/messages`, init);
  };
}

test("Anthropic Search sends Messages web_search, ignores pre-tool narration, orders cited sources first, and honors model overrides", async () => {
  let calls = 0;
  const query = `${"Node.js release notes ".repeat(10)}site:nodejs.org`;
  assert.ok(query.length > 128);
  const result = await searchAnthropic(
    { query, count: 2 },
    apiKeyAuth,
    { model: "claude-sonnet-5-5" },
    undefined,
    async (endpoint, init) => {
      calls++;
      assert.equal(endpoint, "https://api.anthropic.com/v1/messages");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": secret,
      });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.model, "claude-sonnet-5-5");
      assert.equal(body.max_tokens, 4096);
      assert.equal("temperature" in body, false);
      assert.deepEqual(body.messages, [{ role: "user", content: query }]);
      assert.deepEqual(body.tools, [
        { type: "web_search_20250305", name: "web_search", max_uses: 1 },
      ]);
      const system = body.system as Array<{ type: string; text: string }>;
      assert.equal(system.length, 1);
      assert.doesNotMatch(system[0]?.text ?? "", /Claude Code/u);
      return Response.json({
        id: "msg_search_1",
        model: "claude-sonnet-5-5",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "Let me search the web for that query." },
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query } },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [
              {
                type: "web_search_result",
                title: "Uncited first",
                url: "https://nodejs.org/en/about",
                page_age: "5 days ago",
                encrypted_content: "ciphertext-1",
              },
              {
                type: "web_search_result",
                title: "Cited release\nnotes",
                url: "https://nodejs.org/en/blog/release/v26.13.1",
                page_age: "1 day ago",
                encrypted_content: "ciphertext-2",
              },
              {
                type: "web_search_result",
                title: "Bad URL",
                url: "javascript:alert(1)",
                page_age: null,
                encrypted_content: "ciphertext-3",
              },
              {
                type: "web_search_result",
                title: "Dropped by count",
                url: "https://nodejs.org/en/download",
                page_age: null,
                encrypted_content: "ciphertext-4",
              },
            ],
          },
          { type: "text", text: "Node 26.13.1 shipped security fixes", citations: null },
          {
            type: "text",
            text: " and TLS updates.",
            citations: [
              {
                type: "web_search_result_location",
                url: "https://nodejs.org/en/blog/release/v26.13.1",
                title: "Cited release notes",
                cited_text: "Node 26.13.1 updates OpenSSL and root certificates.",
                encrypted_index: "idx",
              },
            ],
          },
        ],
      });
    },
  );

  assert.equal(calls, 1);
  const text = result.content[0]?.text ?? "";
  assert.match(text, /Provider: Anthropic Search \(claude-sonnet-5-5\)/u);
  assert.match(text, /Omitted 1 result\(s\) with unusable source URLs\./u);
  assert.match(
    text,
    /Provider synthesis:\nNode 26\.13\.1 shipped security fixes and TLS updates\./u,
  );
  assert.doesNotMatch(text, /Let me search the web/u);
  assert.match(
    text,
    /1\. Cited release notes\nURL: https:\/\/nodejs\.org\/en\/blog\/release\/v26\.13\.1\nAge \(provider-reported\): 1 day ago\nCited excerpt: Node 26\.13\.1 updates OpenSSL and root certificates\.\n\n2\. Uncited first\nURL: https:\/\/nodejs\.org\/en\/about\nAge \(provider-reported\): 5 days ago/u,
  );
  assert.doesNotMatch(text, /Dropped by count|javascript:|ciphertext|sk-ant/u);

  const { display, ...details } = result.details;
  assert.ok(display.synthesis);
  assert.equal(
    text.slice(display.synthesis.start, display.synthesis.end),
    "Node 26.13.1 shipped security fixes and TLS updates.",
  );
  assert.deepEqual(details, {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    query,
    requestedCount: 2,
    resultCount: 2,
    omittedInvalidUrls: 1,
    needContent: false,
    truncated: false,
  });
});

test("Anthropic OAuth search prepends the Claude Code system identity and defaults to claude-haiku-5-5", async () => {
  const result = await searchAnthropic(
    { query: "Anthropic docs", need_content: true },
    oauthAuth,
    {},
    undefined,
    async (_endpoint, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        system: Array<{ type: string; text: string }>;
      };
      assert.equal(body.model, DEFAULT_ANTHROPIC_MODEL);
      assert.equal(body.system.length, 2);
      assert.equal(
        body.system[0]?.text,
        "You are Claude Code, Anthropic's official CLI for Claude.",
      );
      assert.equal(
        new Headers(init?.headers).get("anthropic-beta"),
        "claude-code-20250219,oauth-2025-04-20",
      );
      return Response.json({
        stop_reason: "end_turn",
        content: [
          { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] },
          { type: "text", text: "No matching pages were found." },
        ],
      });
    },
  );
  const text = result.content[0]?.text ?? "";
  assert.match(
    text,
    /Anthropic Search returns synthesis and source citations rather than full page bodies/u,
  );
  assert.match(text, /No source URLs returned\./u);
  assert.equal(result.details.model, DEFAULT_ANTHROPIC_MODEL);
  assert.equal(result.details.needContent, true);
  assert.equal(result.details.resultCount, 0);
});

test("Anthropic Search rejects ungrounded completions, refusals, paused turns, server tool errors, and out-of-range queries", async () => {
  let resolutions = 0;
  const countedAuth = async () => {
    resolutions++;
    return apiKeyAuth();
  };
  for (const invalid of ["", "   ", "a".repeat(ANTHROPIC_MAX_QUERY_CHARACTERS + 1)]) {
    await assert.rejects(
      searchAnthropic({ query: invalid }, countedAuth, {}, undefined, async () => {
        throw new Error("Unexpected network call");
      }),
      /1–4096 Unicode characters/u,
    );
  }
  assert.equal(resolutions, 0);

  await assert.rejects(
    searchAnthropic(
      { query: "test" },
      apiKeyAuth,
      { model: "retired-model" },
      undefined,
      async () => new Response(`raw ${secret}`, { status: 404 }),
    ),
    {
      message:
        'Anthropic Search HTTP 404: Requested model "retired-model" was not found; set search.providers.anthropic.model in web-access.json to an available model.',
    },
  );

  // Model answered without running web_search -> must be rejected.
  await assert.rejects(
    searchAnthropic({ query: "test" }, apiKeyAuth, {}, undefined, async () =>
      Response.json({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Ungrounded memory answer." }],
      }),
    ),
    /without invoking web_search/u,
  );

  // Refusals, sensitive stops, paused turns, and context-window overflows fail even after web_search.
  for (const [stopReason, expected] of [
    ["refusal", /refused to complete/u],
    ["sensitive", /refused to complete/u],
    ["pause_turn", /paused before completing.*retry later/u],
    ["model_context_window_exceeded", /context window/u],
    [null, /stopped unexpectedly/u],
  ] as const) {
    await assert.rejects(
      searchAnthropic({ query: "test" }, apiKeyAuth, {}, undefined, async () =>
        Response.json({
          stop_reason: stopReason,
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "srv_1",
              content: [
                {
                  type: "web_search_result",
                  title: "Result",
                  url: "https://example.test/item",
                  page_age: null,
                },
              ],
            },
          ],
        }),
      ),
      expected,
    );
  }

  // pause_turn before web_search_tool_result reports paused turn rather than missing web_search.
  await assert.rejects(
    searchAnthropic({ query: "test" }, apiKeyAuth, {}, undefined, async () =>
      Response.json({
        stop_reason: "pause_turn",
        content: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: {} }],
      }),
    ),
    /paused before completing/u,
  );

  for (const [code, expected] of [
    ["too_many_requests", /rate limit exceeded.*retry later/u],
    ["unavailable", /temporarily unavailable.*retry later/u],
    ["query_too_long", /query as too long/u],
    ["invalid_tool_input", /query as invalid/u],
    ["unknown_code", /failed to retrieve results/u],
  ] as const) {
    await assert.rejects(
      searchAnthropic({ query: "test" }, apiKeyAuth, {}, undefined, async () =>
        Response.json({
          stop_reason: "end_turn",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "srv_1",
              content: { type: "web_search_tool_result_error", error_code: code },
            },
          ],
        }),
      ),
      expected,
    );
  }
});

test("Anthropic Fetch omits allowed_domains, extracts PlainTextSource directly, ignores pre-tool narration, and flags max_tokens PDFs", async () => {
  // PlainTextSource ignores both pre-tool narration and stop_reason === "max_tokens" because server text is complete.
  const htmlResult = await fetchAnthropic(
    "https://DOCS.EXAMPLE.TEST:443/reference#section",
    apiKeyAuth,
    {},
    undefined,
    async (endpoint, init) => {
      assert.equal(endpoint, "https://api.anthropic.com/v1/messages");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.model, DEFAULT_ANTHROPIC_MODEL);
      assert.equal(body.max_tokens, 16_384);
      assert.deepEqual(body.messages, [
        { role: "user", content: "https://docs.example.test/reference" },
      ]);
      assert.deepEqual(body.tools, [
        {
          type: "web_fetch_20250910",
          name: "web_fetch",
          max_uses: 1,
        },
      ]);
      return Response.json({
        stop_reason: "max_tokens",
        content: [
          { type: "text", text: "I will fetch that URL now." },
          {
            type: "server_tool_use",
            id: "srvtoolu_fetch_1",
            name: "web_fetch",
            input: { url: "https://docs.example.test/reference" },
          },
          {
            type: "web_fetch_tool_result",
            tool_use_id: "srvtoolu_fetch_1",
            content: {
              type: "web_fetch_result",
              url: "https://platform.example.test/redirected-reference",
              retrieved_at: "2026-11-16T00:00:00Z",
              content: {
                type: "document",
                title: "  Reference\nGuide  ",
                citations: null,
                source: {
                  type: "text",
                  media_type: "text/plain",
                  data: "# Reference Guide\n\nExact server-extracted text.",
                },
              },
            },
          },
          { type: "text", text: "Chatty assistant commentary ignored for plain text sources." },
        ],
      });
    },
  );

  const htmlText = htmlResult.content[0]?.text ?? "";
  assert.match(htmlText, /Provider: Anthropic Fetch \(claude-haiku-5-5\)/u);
  assert.match(htmlText, /Title: Reference Guide\n/u);
  assert.ok(htmlText.endsWith("# Reference Guide\n\nExact server-extracted text."));
  assert.doesNotMatch(htmlText, /I will fetch|Chatty assistant commentary|token limit/u);
  assert.equal("outputTokenLimitReached" in htmlResult.details, false);

  // PDF source ignores pre-tool narration and uses post-fetch Markdown extraction,
  // surfacing an explicit notice when stop_reason === "max_tokens".
  const pdfResult = await fetchAnthropic(
    "https://example.test./paper.pdf",
    oauthAuth,
    { model: "claude-haiku-4-5" },
    undefined,
    async (_endpoint, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        tools: Array<Record<string, unknown>>;
      };
      assert.equal(body.model, "claude-haiku-4-5");
      assert.deepEqual(body.tools, [
        { type: "web_fetch_20250910", name: "web_fetch", max_uses: 1 },
      ]);
      return Response.json({
        stop_reason: "max_tokens",
        content: [
          { type: "text", text: "Let me fetch the PDF first." },
          {
            type: "web_fetch_tool_result",
            tool_use_id: "srvtoolu_pdf",
            content: {
              type: "web_fetch_result",
              url: "https://example.test./paper.pdf",
              retrieved_at: null,
              content: {
                type: "document",
                title: null,
                citations: null,
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "JVBERi0xLjQK",
                },
              },
            },
          },
          { type: "text", text: "# Extracted PDF\n\nSection 1." },
        ],
      });
    },
  );
  const pdfText = pdfResult.content[0]?.text ?? "";
  assert.match(pdfText, /Title: Not provided\.\n/u);
  assert.doesNotMatch(pdfText, /Let me fetch the PDF/u);
  assert.match(
    pdfText,
    /# Extracted PDF\n\nSection 1\.\n\n\[Provider output reached the model token limit; extracted content is incomplete\.\]/u,
  );
  assert.equal(pdfResult.details.truncated, false);
  assert.equal(pdfResult.details.outputTokenLimitReached, true);

  // Pre-tool narration alone cannot satisfy PDF extraction when no post-tool text was emitted.
  await assert.rejects(
    fetchAnthropic("https://example.test/empty.pdf", apiKeyAuth, {}, undefined, async () =>
      Response.json({
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "Let me fetch the PDF first." },
          {
            type: "web_fetch_tool_result",
            tool_use_id: "srvtoolu_empty_pdf",
            content: {
              type: "web_fetch_result",
              url: "https://example.test/empty.pdf",
              content: {
                type: "document",
                title: "Empty PDF",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "JVBERi0xLjQK",
                },
              },
            },
          },
        ],
      }),
    ),
    /no readable page content/u,
  );
});

test("a rejected extra tool call under max_uses keeps the successful result and only the final answer text", async () => {
  const search = await searchAnthropic({ query: "test" }, apiKeyAuth, {}, undefined, async () =>
    Response.json({
      stop_reason: "end_turn",
      content: [
        { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "test" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "srv_1",
          content: [
            {
              type: "web_search_result",
              title: "First",
              url: "https://example.test/first",
              page_age: null,
            },
          ],
        },
        {
          type: "text",
          text: "Let me search once more.",
          // Malformed citations in discarded narration never fail the call.
          citations: [{ type: "web_search_result_location", url: 42 }],
        },
        { type: "server_tool_use", id: "srv_2", name: "web_search", input: { query: "more" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "srv_2",
          content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
        },
        { type: "text", text: "Final answer", citations: null },
        {
          type: "text",
          text: " from the first search.",
          citations: [
            {
              type: "web_search_result_location",
              url: "https://example.test/first",
              title: "First",
              cited_text: "First excerpt.",
            },
          ],
        },
      ],
    }),
  );
  const searchText = search.content[0]?.text ?? "";
  assert.match(searchText, /Provider synthesis:\nFinal answer from the first search\.\n/u);
  assert.doesNotMatch(searchText, /search once more|per-call/u);
  assert.match(searchText, /Cited excerpt: First excerpt\./u);

  const fetched = await fetchAnthropic(
    "https://example.test/paper.pdf",
    apiKeyAuth,
    {},
    undefined,
    async () =>
      Response.json({
        stop_reason: "end_turn",
        content: [
          {
            type: "web_fetch_tool_result",
            tool_use_id: "srv_1",
            content: {
              type: "web_fetch_result",
              url: "https://example.test/paper.pdf",
              content: {
                type: "document",
                title: "Paper",
                source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" },
              },
            },
          },
          { type: "text", text: "Let me fetch it again." },
          { type: "server_tool_use", id: "srv_2", name: "web_fetch", input: {} },
          {
            type: "web_fetch_tool_result",
            tool_use_id: "srv_2",
            content: { type: "web_fetch_tool_result_error", error_code: "max_uses_exceeded" },
          },
          { type: "text", text: "# Paper\n\nA sentence split " },
          { type: "text", text: "across blocks.\n```js\nconst a = 1;" },
          { type: "text", text: "\n```" },
        ],
      }),
  );
  const fetchedText = fetched.content[0]?.text ?? "";
  assert.ok(
    fetchedText.endsWith("# Paper\n\nA sentence split across blocks.\n```js\nconst a = 1;\n```"),
  );
  assert.doesNotMatch(fetchedText, /fetch it again|per-call/u);
});

test("Anthropic Fetch rejects ungrounded completions, refusals, paused turns, server error codes, HTTP errors, and oversized bodies", async (t) => {
  await assert.rejects(
    fetchAnthropic("https://example.test/page", apiKeyAuth, {}, undefined, async () =>
      Response.json({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Guessed page content." }],
      }),
    ),
    /without invoking web_fetch/u,
  );

  for (const [stopReason, expected] of [
    ["refusal", /refused to complete/u],
    ["sensitive", /refused to complete/u],
    ["pause_turn", /paused before completing.*retry later/u],
    ["model_context_window_exceeded", /context window/u],
  ] as const) {
    await assert.rejects(
      fetchAnthropic("https://example.test/page", apiKeyAuth, {}, undefined, async () =>
        Response.json({
          stop_reason: stopReason,
          content: [
            {
              type: "web_fetch_tool_result",
              tool_use_id: "srv_1",
              content: {
                type: "web_fetch_result",
                url: "https://example.test/page",
                content: {
                  type: "document",
                  title: "Title",
                  source: {
                    type: "text",
                    media_type: "text/plain",
                    data: "Body text.",
                  },
                },
              },
            },
          ],
        }),
      ),
      expected,
    );
  }

  for (const [code, expected] of [
    ["url_not_allowed", /security or domain policy/u],
    ["url_not_accessible", /could not access/u],
    ["unsupported_content_type", /content type/u],
    ["content_too_large", /exceeds the provider limit/u],
    ["too_many_requests", /rate limit exceeded.*retry later/u],
    ["unavailable", /temporarily unavailable.*retry later/u],
  ] as const) {
    await assert.rejects(
      fetchAnthropic("https://example.test/page", apiKeyAuth, {}, undefined, async () =>
        Response.json({
          stop_reason: "end_turn",
          content: [
            {
              type: "web_fetch_tool_result",
              tool_use_id: "srv_1",
              content: { type: "web_fetch_tool_result_error", error_code: code },
            },
          ],
        }),
      ),
      expected,
    );
  }

  for (const [status, expected] of [
    [401, "Anthropic Fetch HTTP 401: Missing or invalid Anthropic credentials."],
    [
      403,
      "Anthropic Fetch HTTP 403: Anthropic web_fetch access denied; verify organization and credential permissions.",
    ],
    [
      404,
      'Anthropic Fetch HTTP 404: Requested model "claude-haiku-5-5" was not found; set fetch.providers.anthropic.model in web-access.json to an available model.',
    ],
    [
      529,
      "Anthropic Fetch HTTP 529: Anthropic service is overloaded. This may be transient; retry later.",
    ],
  ] as const) {
    await assert.rejects(
      fetchAnthropic("https://example.test/page", apiKeyAuth, {}, undefined, async () => {
        return new Response(`raw body with ${secret}`, { status });
      }),
      { message: expected },
    );
  }

  // Real local HTTP transport enforces the 2 MiB decoded response cap and spills >50 KiB previews.
  const oversizedTransport = await localMessagesTransport(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.write('{"stop_reason":"end_turn","content":[{"type":"text","text":"');
    res.write("x".repeat(2 * 1024 * 1024));
    res.end('"}]}');
  });
  await assert.rejects(
    fetchAnthropic("https://example.test/huge", apiKeyAuth, {}, undefined, oversizedTransport),
    /exceeds the 2 MiB limit/u,
  );

  // Large PDF hitting BOTH >50 KiB local truncation and max_tokens retains both notices in preview and saved file.
  const largePdfBody = `${"Section line with details.\n".repeat(2200)}FINAL_EXTRACTED_LINE`;
  const truncatedResult = await fetchAnthropic(
    "https://example.test/long.pdf",
    apiKeyAuth,
    {},
    undefined,
    async () =>
      Response.json({
        stop_reason: "max_tokens",
        content: [
          {
            type: "web_fetch_tool_result",
            tool_use_id: "srv_long",
            content: {
              type: "web_fetch_result",
              url: "https://example.test/long.pdf",
              content: {
                type: "document",
                title: "Long Doc",
                source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" },
              },
            },
          },
          { type: "text", text: largePdfBody },
        ],
      }),
  );
  assert.equal(truncatedResult.details.truncated, true);
  assert.equal(truncatedResult.details.outputTokenLimitReached, true);
  assert.match(
    truncatedResult.content[0]?.text ?? "",
    /\[Provider output reached the model token limit; extracted content is incomplete\.\]\n\n\[Output truncated\./u,
  );
  const fullPath = truncatedResult.details.fullOutputPath;
  assert.ok(fullPath);
  t.after(() => rm(dirname(fullPath), { recursive: true, force: true }));
  assert.equal((await stat(fullPath)).mode & 0o777, 0o600);
  const saved = await readFile(fullPath, "utf8");
  assert.match(
    saved,
    /FINAL_EXTRACTED_LINE\n\n\[Provider output reached the model token limit; extracted content is incomplete\.\]/u,
  );
});
