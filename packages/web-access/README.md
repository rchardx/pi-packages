# Web access

Two independent, opt-in Pi tools backed by DeepSeek's standalone APIs:

- `web_fetch` returns a page title and Markdown content.
- `web_search` returns ordered sources, summaries and optional page content.

Neither calls a chat model or invokes the other tool.

## Install

From the repository root, install dependencies and try it for one session:

```bash
npm ci
pi -e ./packages/web-access
```

To enable it persistently for your Pi user instead:

```bash
pi install ./packages/web-access
```

The local install refers to this checkout; keep it in place and reload Pi after
changes. Do not install both the directory and its entrypoint. The repository
root is not a Pi package.

## Enable tools

Configure DeepSeek authentication in Pi with `/login deepseek` or
`DEEPSEEK_API_KEY` in Pi's launch environment. No DeepSeek chat model selection
is needed. Keep credentials out of tool arguments and configuration.

Enable the capabilities you want in `~/.pi/agent/web-access.json`
(its directory follows `PI_CODING_AGENT_DIR`):

```json
{
  "search": { "provider": "deepseek" },
  "fetch": { "provider": "deepseek" }
}
```

Each entry independently authorizes possible provider charges, use of Pi-resolved
credentials, and query or URL disclosure to DeepSeek. Omit an entry to disable
that tool; a missing file or `{}` enables neither. Project settings and tool
arguments cannot grant permission.

Run `/reload` after enabling a tool. Explicit tool selection affects visibility,
not permission. Consent and credentials are rechecked on every call; removing an
entry blocks subsequent calls even if Pi keeps the tool active. In-flight calls
retain starting consent. Restart Pi when changing its launch environment.

Pi owns authentication and provider configuration. The effective auth base URL
(auth override, otherwise provider default) must have the
`https://api.deepseek.com` origin. Requests use the fixed endpoints below.
Pi's API key supplies default Bearer authentication; provider headers, then
resolved auth headers override defaults case-insensitively, with `null` deleting
a header. Authorization is required and the tools set JSON Content-Type.

Only `search` and `fetch` settings are supported. Malformed JSON, unknown fields
or invalid settings prevent both tools from loading; invalid edits during a
session fail on the next call. Fix the file and reload.

Direct fetch is not provided. Remove obsolete `allowRanges` settings and run
`npm ci` after updating the checkout. For localhost or intranet URLs, use
`curl` through `bash`: DeepSeek visits targets from its infrastructure, not your
machine. Fetching is subject to the service's security policy and target-site
access rules.

## Fetch

```typescript
web_fetch({ url: "https://example.com/article" })
```

- Sends only `{ "url": "..." }` to
  `POST https://api.deepseek.com/v1/tools/fetch`.
- Accepts one absolute HTTP(S) URL without an embedded username/password.
  Input and normalized URLs are limited to **8,192 characters**. Normalization
  removes fragments and may expand non-ASCII paths through escaping.
- Returns a single-line title and provider Markdown, preserving content paragraphs.
  Empty titles are valid; invalid fields or whitespace-only content fail.
- The model-facing `Requested URL` and `details.url` identify the normalized
  **requested URL**, not a verified final redirect destination. Details also contain
  `provider`, `title`, `truncated`, and optional `fullOutputPath`; no original `contentType` is returned.
- HTTP 403 means a service security-policy rejection. HTTP 404 means no usable
  content: this may include unavailable/blocked pages, unsupported formats or
  extraction failure, not just a missing URL.

There is no raw JSON/CSV/XML/plain-text pass-through guarantee. Provider content
may be incomplete, include navigation/comments, or lose links, code formatting
and mathematical notation. Browser login, JavaScript rendering and PDF extraction
are not guaranteed. See the [Fetch reference](https://api-docs.deepseek.com/api/fetch/).

## Search

```typescript
web_search({ query: "Node.js release notes site:nodejs.org" })
web_search({ query: "TypeScript releases site:github.com", count: 5, need_content: true })
```

- Sends `query`, `count` and `need_content` to
  `POST https://api.deepseek.com/v1/tools/search`.
- `query` is sent unchanged, including operators such as `site:`. DeepSeek requires
  1–128 Unicode characters and rejects blank queries.
- `count` defaults to **10**, with an allowed range of **1–50**. Fewer or zero
  results are valid.
- `need_content` defaults to **false**. Long summaries fall back to snippets.
  Enabling it requests available page content in the same Search response;
  prefer fewer results to limit output. It does not call `web_fetch`.

Results retain provider order. Invalid, non-HTTP(S) or credential-bearing source
URLs are omitted with a count; valid URLs are normalized, then limited to the
requested count. All-invalid results are distinguished from an empty search.
Titles, site names and dates use single-line whitespace; summaries and content
retain paragraphs. Dates are provider-reported and summaries are not verified
quotations. The extension does not visit result URLs.

See the [Search reference](https://api-docs.deepseek.com/api/search/) for operators
and response fields.

## Tool cards in Pi

The tool names remain `web_fetch` and `web_search`; their cards display **Web fetch**
and **Web search**. Calls show the URL or query, with a compact result summary and
Pi-reported execution time when available. Search previews show up to three titles.

Use Pi's expand-tools shortcut (normally `ctrl+o`) to reveal Markdown content,
source URLs and search summaries. The title and summary keep the same style in
both views; the shortcut hint follows your keybindings. Provider text is untrusted
and extraction may be incomplete. Errors, omitted-source notices and full-output
file paths remain visible when collapsed.

Expansion only reveals the existing bounded preview: it does not fetch again or
read the full-output file. Use `read` for that file. Presentation metadata in
`details.display` references the model-facing text rather than storing another
copy of the page. Renderers remove terminal control sequences for display only;
model-facing content and saved full output are unchanged. Older session results
without presentation metadata retain a plain-text fallback.

## Shared limits and privacy

- Fetch has a **60-second** total deadline; Search has **120 seconds**. These cover
  authentication, request, response and output. Cancellation aborts network work
  and stops waiting for credentials, though Pi's secret-manager work may continue.
- Both APIs have a **2 MiB decoded JSON response limit**. Oversized responses fail
  without partial output, even after a potentially billable HTTP 200. Malformed,
  partial, non-JSON and invalid UTF-8 API responses also fail explicitly.
- API requests do not follow redirects, retry automatically, or use a fallback.
  HTTP 408, 429 and 5xx diagnostics suggest retrying later. HTTP 401 indicates
  authentication failure, 402 insufficient balance, and 429 rate limiting.
- Errors retain HTTP status and recognized network codes, not raw provider bodies
  or transport messages. Unknown transport failures use a generic diagnostic.
- Previews are limited to **2,000 lines / 50 KiB**. Full formatted output is saved
  when truncated to `pi-web-fetch-*/content.txt` or `pi-web-search-*/content.txt`;
  continue with `read`. Directories are 0700 and files 0600 on POSIX. Failed writes
  are cleaned up; successful files remain until removed or OS temporary cleanup.
  Search files contain selected results and omission notices, not discarded entries.
- DeepSeek receives the query or normalized URL (including path/query) and request
  source IP, not conversation or repository content. Inputs and returned content
  enter the Pi conversation; do not include secrets. Results are untrusted data,
  not instructions, and full output files do not prove complete page retrieval.
  Browser cookies are not reused.

See the [Search & Fetch guide](https://api-docs.deepseek.com/guides/search) for
provider-controlled billing and rate limits. Cancellation cannot undo charges.

## Pi compatibility

Latest verified compatible version: **Pi 1.5.2**, on the runtimes recorded in
[Node.js compatibility](../../README.md#nodejs-compatibility).

SDK tests discover the package through its manifest, load its TypeScript extension
and execute both tools using synthetic credentials and local HTTP/controlled
responses. They cover consent, visibility, reload, Pi authentication and the
effective-origin boundary. Shared transport regressions cover decoding, resource
limits and cancellation; Fetch also verifies its own deadline and output handling.
No live account is needed; these checks do not guarantee site availability or
extraction quality.

Host-provided libraries use `"*"` peers as Pi recommends; this does not promise
compatibility with every Pi release. The package remains private and unpublished.

## Development

From the repository root:

```bash
node --import tsx --test 'packages/web-access/test/*.test.ts'
npm run check
npm test
npm pack --workspace @rchardx/pi-web-access --dry-run
```

See the [contribution workflow](../../CONTRIBUTING.md) and
[repository constraints](../../AGENTS.md).

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses.
