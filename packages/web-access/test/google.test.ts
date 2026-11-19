import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_GOOGLE_MODEL, fetchGoogle } from "../src/providers/google.ts";

const secret = "gemini-test-secret";
const auth = async () => new Headers({ "x-goog-api-key": secret });
const endpoint = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

function candidate(fields: object, text = "Answer.", finishReason = "STOP") {
  return Response.json({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason, ...fields }],
  });
}

test("Google Fetch requires a successful url_context retrieval and returns the model's Markdown", async () => {
  const result = await fetchGoogle(
    "https://Example.test/doc#frag",
    auth,
    { model: "gemini-3.5-flash" },
    undefined,
    async (url, init) => {
      assert.equal(url, endpoint("gemini-3.5-flash"));
      assert.equal(init?.redirect, "error");
      assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
        "content-type": "application/json",
        "x-goog-api-key": secret,
      });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.deepEqual(body.tools, [{ url_context: {} }]);
      assert.match(JSON.stringify(body.systemInstruction), /without summarizing.*untrusted data/u);
      assert.deepEqual(body.contents, [
        { role: "user", parts: [{ text: "https://example.test/doc" }] },
      ]);
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                { text: "Reading the page.", thought: true },
                { text: "# Doc\n\nBody ", thoughtSignature: "sig" },
                { text: "text." },
              ],
            },
            finishReason: "STOP",
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: "https://other.test/", title: "Other" } },
                { web: { uri: "https://example.test/doc", title: "Doc\nTitle" } },
              ],
            },
            urlContextMetadata: {
              urlMetadata: [
                {
                  retrievedUrl: "https://example.test/doc",
                  urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
                },
              ],
            },
          },
        ],
      });
    },
  );
  const text = result.content[0]?.text ?? "";
  assert.match(
    text,
    /Provider: Google Fetch \(gemini-3\.5-flash\)\nRequested URL: https:\/\/example\.test\/doc\nTitle: Doc Title\n/u,
  );
  assert.ok(text.endsWith("# Doc\n\nBody text."));
  assert.doesNotMatch(text, /Reading the page|gemini-test-secret/u);
  const { display, ...details } = result.details;
  assert.ok(display);
  assert.deepEqual(details, {
    provider: "google",
    model: "gemini-3.5-flash",
    url: "https://example.test/doc",
    title: "Doc Title",
    truncated: false,
  });

  const run = (response: Response) =>
    fetchGoogle("https://example.test/doc", auth, {}, undefined, async () => response);
  await assert.rejects(run(candidate({}, "Guessed content.")), /without invoking url_context/u);
  await assert.rejects(
    run(Response.json({ promptFeedback: { blockReason: "SAFETY" } })),
    /refused to complete/u,
  );
  await assert.rejects(run(Response.json({ candidates: [] })), /returned no candidates/u);
  await assert.rejects(run(Response.json({ candidates: "bad" })), /invalid response schema/u);
  const retrieved = { urlMetadata: [{ urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }] };
  for (const [finishReason, expected] of [
    ["SAFETY", /refused to complete/u],
    ["RECITATION", /refused to complete/u],
    ["OTHER", /stopped before completing/u],
  ] as const) {
    await assert.rejects(
      run(candidate({ urlContextMetadata: retrieved }, "Text", finishReason)),
      expected,
    );
  }
  for (const [status, expected] of [
    ["URL_RETRIEVAL_STATUS_UNSAFE", /safety policy/u],
    ["URL_RETRIEVAL_STATUS_PAYWALL", /paywalled/u],
    ["URL_RETRIEVAL_STATUS_ERROR", /could not retrieve the URL/u],
    ["constructor", /could not retrieve the URL/u],
  ] as const) {
    await assert.rejects(
      run(candidate({ urlContextMetadata: { urlMetadata: [{ urlRetrievalStatus: status }] } })),
      expected,
    );
  }
  const success = { urlMetadata: [{ urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }] };
  await assert.rejects(
    run(candidate({ urlContextMetadata: success }, "  ")),
    /no readable page content/u,
  );
  const truncated = await run(candidate({ urlContextMetadata: success }, "Partial", "MAX_TOKENS"));
  assert.equal(truncated.details.outputTokenLimitReached, true);
  assert.match(
    truncated.content[0]?.text ?? "",
    /\[Provider output reached the model token limit; extracted content is incomplete\.\]$/u,
  );
  for (const [status, expected] of [
    [400, "Google Fetch HTTP 400: Invalid request or Gemini API key."],
    [
      404,
      'Google Fetch HTTP 404: Requested model "gemini-3.8-flash" or endpoint was not found; if the model is unavailable, set fetch.providers.google.model in web-access.json.',
    ],
    [
      429,
      "Google Fetch HTTP 429: Google fetch rate limit exceeded. This may be transient; retry later.",
    ],
  ] as const) {
    await assert.rejects(run(new Response(`raw ${secret}`, { status })), { message: expected });
  }
});

test("Google Fetch defaults to the catalog model and leaves an unmatched title empty", async () => {
  const result = await fetchGoogle("https://example.test/a", auth, {}, undefined, async (url) => {
    assert.equal(url, endpoint(DEFAULT_GOOGLE_MODEL));
    return candidate(
      {
        groundingMetadata: { groundingChunks: [{ web: { uri: "https://elsewhere.test/" } }] },
        urlContextMetadata: {
          urlMetadata: [{ urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }],
        },
      },
      "Content.",
    );
  });
  assert.equal(result.details.model, "gemini-3.8-flash");
  assert.equal(result.details.title, "");
  assert.match(result.content[0]?.text ?? "", /Title: Not provided\./u);
});
