import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { fetchPage } from "../src/fetch.ts";
import { fixture } from "./_server.ts";

test("extracts readable HTML, preserves headings/code/links and removes non-content", async (t) => {
  const { network } = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
      <html><head><script>danger()</script><style>.x { color: red }</style></head>
      <body><nav>Navigation noise</nav><main><h1>Guide &amp; examples</h1>
      <p>Hello 世界. <a href="../next">Next page</a></p><ul><li>First item</li></ul>
      <pre>const answer = 42;</pre><p hidden>Secret decoration</p>
      <p aria-hidden="true">Hidden label</p><img src="/pixel">
      <script>fetch('/tracking')</script></main><footer>Footer noise</footer></body></html>`);
  });
  const result = await fetchPage("https://example.test/docs/start", undefined, network);
  const text = result.content[0]?.text ?? "";
  assert.match(text, /GUIDE & EXAMPLES/u);
  assert.match(text, /Hello 世界/u);
  assert.match(text, /Next page \[https:\/\/example.test\/next\]/u);
  assert.match(text, /First item/u);
  assert.match(text, /const answer = 42;/u);
  assert.match(text, /Untrusted web content/u);
  assert.doesNotMatch(
    text,
    /danger|tracking|Navigation noise|Footer noise|Secret decoration|Hidden label|pixel/u,
  );
  assert.deepEqual(result.details, {
    url: "https://example.test/docs/start",
    contentType: "text/html",
    truncated: false,
  });
});

for (const contentType of [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/problem+json",
  "application/xml",
  "text/xml",
]) {
  test(`preserves ${contentType} rather than stripping markup`, async (t) => {
    const text = '# Literal text\n{"value":"<b>not HTML</b>"}\n';
    const { network } = await fixture(t, (_request, response) =>
      response.writeHead(200, { "content-type": contentType }).end(text),
    );
    assert.ok(
      (await fetchPage("https://example.test", undefined, network)).content[0]?.text.endsWith(text),
    );
  });
}

for (const body of ["", "<html><body><script>renderApp()</script></body></html>"]) {
  test(`reports an empty or script-only page (${body.length} bytes)`, async (t) => {
    const { network } = await fixture(t, (_request, response) =>
      response.writeHead(200, { "content-type": "text/html" }).end(body),
    );
    await assert.rejects(fetchPage("http://example.test", undefined, network), /No readable text/u);
  });
}

for (const [name, body] of [
  ["line limit", "Line\n".repeat(2100)],
  ["byte limit", "世界".repeat(12_000)],
] as const) {
  test(`truncates at the ${name} and retains complete UTF-8 text in a private local file`, async (t) => {
    const { network } = await fixture(t, (_request, response) =>
      response.writeHead(200, { "content-type": "text/plain" }).end(body),
    );
    const result = await fetchPage("http://example.test", undefined, network);
    assert.equal(result.details.truncated, true);
    const path = result.details.fullOutputPath;
    assert.ok(path);
    t.after(() => rm(dirname(path), { recursive: true, force: true }));
    const preview = result.content[0]?.text ?? "";
    assert.match(preview, /Output truncated/u);
    assert.ok(preview.includes(path));
    assert.doesNotMatch(preview, /\uFFFD/u);
    assert.ok(Buffer.byteLength(preview) < 53_000);
    assert.ok((await readFile(path, "utf8")).endsWith(body));
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    }
  });
}
