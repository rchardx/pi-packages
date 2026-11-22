# @rchardx/pi-web-access

Two independent, opt-in Pi tools backed by standalone hosted web-tool endpoints
(**Exa**, **Parallel**, and **DeepSeek**):

- `web_fetch` returns a page title and Markdown or plain-text content.
- `web_search` returns ordered sources alongside provider-supplied summaries
  (or extractive excerpts/highlights) and optional page content.

Neither tool invokes the other, and neither routes through a chat-model
generation turn or Pi's chat-model provider registry.

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

For a checkout-free development snapshot, follow the
[nightly tarball installation guide](../../docs/installation.md#install-a-nightly-snapshot).
Nightlies are rolling prereleases, not npm registry publications.

The local install refers to this checkout; keep it in place and reload Pi after
changes. Do not install both the directory and its entrypoint. The repository
root is not a Pi package.

## Enable tools

Export the API key in Pi's launch environment for each provider you intend to
enable:

| Provider | Environment variable | Hardcoded endpoints | HTTP authentication |
| --- | --- | --- | --- |
| `exa` | `EXA_API_KEY` | `POST https://api.exa.ai/search` or `/contents` | `x-api-key: <key>` |
| `parallel` | `PARALLEL_API_KEY` | `POST https://api.parallel.ai/v1/search` or `/v1/extract` | `x-api-key: <key>` |
| `deepseek` | `DEEPSEEK_API_KEY` | `POST https://api.deepseek.com/v1/tools/search` or `/v1/tools/fetch` | `Authorization: Bearer <key>` |

Endpoints are fixed in code and cannot be overridden. Credentials are read
exclusively from the environment variables above—never from Pi's `/login`
store (`auth.json`), `models.json`, tool arguments, or `web-access.json`.
Restart Pi after changing its launch environment.

Enable the capabilities and providers you want in `~/.pi/agent/web-access.json`
(its directory follows `PI_CODING_AGENT_DIR`):

```json
{
  "search": {
    "providers": {
      "exa": { "mode": "auto", "maxAgeHours": 24 },
      "parallel": { "mode": "fast" },
      "deepseek": {}
    },
    "defaultProvider": "exa"
  },
  "fetch": {
    "providers": {
      "exa": { "maxAgeHours": 24 },
      "parallel": {},
      "deepseek": {}
    },
    "defaultProvider": "exa"
  }
}
```

Each entry under `providers` independently authorizes possible provider charges,
use of the corresponding environment API key, and query or URL disclosure to
that provider:

- `exa` accepts optional `mode` (`"lite"`, `"auto"`, `"deep-lite"`, or `"deep"`,
  default `"auto"`; search only) and `maxAgeHours` (integer `-1` to `720`: `0`
  requests a live fetch, `-1` restricts retrieval to cached content only, and
  `1`–`720` sets a target maximum cache age in hours; omitted uses Exa's default
  cache policy). Per Exa's Contents API, `0` may still reuse a fetch from the
  previous 60 seconds, and a positive threshold may return older cached content
  if a live refresh fails. Search `mode: "lite"` serves cached content only and
  cannot be combined with `maxAgeHours`.
- `parallel` accepts optional `mode` (`"turbo"`, `"fast"`, `"basic"`, or
  `"advanced"`, default `"fast"`; search only) and `maxAgeHours` (`-1` to `720`
  on search, `0` to `720` on fetch: omitted on search serves Parallel's cached
  index without live site fetches, `-1` on search forces index-only retrieval,
  `0` maps to Parallel's 600-second minimum `max_age_seconds` live-refresh
  window, and `1`–`720` maps to `maxAgeHours * 3600` seconds; Parallel Fetch
  offers no cache-only guarantee and rejects `-1`).
- `deepseek` accepts only `{}`.
- When a single provider is enabled in `providers`, `defaultProvider` may be
  omitted; when multiple providers are enabled, `defaultProvider` is required
  and must also appear in `providers`.
- Routing is independent of the active Pi chat model (`ctx.model`), and there is
  no cross-provider fallback: once the target provider is selected, failures
  report directly without forwarding the query or URL elsewhere.
- When `exa` or `parallel` is the active provider on load or `/reload`, the
  registered tool guidelines inform Pi of the configured defaults, per-call
  override parameters, and user `web-access.json` configuration.

Omit `search` or `fetch` to disable that tool; a missing file or `{}` enables
neither. Project settings and tool arguments cannot grant permission.

Run `/reload` after enabling, disabling, or changing configured defaults so tool
visibility and prompt guidelines refresh. Consent, routing, and API keys are
rechecked on every call; removing a capability or provider blocks subsequent
calls even if Pi keeps the tool active. In-flight calls retain starting consent.

Only `search` and `fetch` settings are supported. Malformed JSON, unknown fields,
empty `providers` maps, or invalid settings prevent both tools from loading;
invalid edits during a session fail on the next call. Fix the file and reload.

Direct local fetching is not provided. For localhost or intranet URLs, use
`curl` through `bash`: hosted providers visit targets from their infrastructure,
not your machine. Fetching is subject to each service's security policy and
target-site access rules.

## Fetch

```typescript
web_fetch({ url: "https://example.com/article" })
web_fetch({ url: "https://example.com/changelog", max_age_hours: 0 })
```

- Accepts one absolute HTTP(S) URL without an embedded username/password.
  Input and normalized URLs are limited to **8,192 characters** (**2,048
  characters** after normalization on **Exa**). Normalization removes fragments
  and may expand non-ASCII paths through escaping.
- `max_age_hours` (optional integer `-1` to `720`) overrides the configured
  freshness target on providers that support cache control (`exa` and
  `parallel`). On **Exa**, `0` requests a live fetch (reusing fetches within 60
  seconds), `-1` restricts retrieval to cache only, and `1`–`720` sets a target
  maximum cache age in hours. On **Parallel**, `0` sets
  `fetch_policy.max_age_seconds` to `600` (Parallel's 10-minute minimum) and
  `1`–`720` sets `maxAgeHours * 3600` seconds, while `-1` fails explicitly
  before reading credentials. Passing `max_age_hours` when `deepseek` is active
  also fails explicitly before reading credentials.
- **Exa** sends `{ "urls": [url], "text": true }` (plus `maxAgeHours` when set)
  to `POST https://api.exa.ai/contents` and returns a single-line title and
  extracted Markdown/text. Crawl errors reported in `statuses` (such as
  restricted sources, HTTP 404, `CRAWL_HTTP_<status>`, or timeouts) and
  cache-only misses fail with sanitized diagnostics; `max_age_hours` does not
  change Exa's per-page rate.
- **Parallel** sends `{ "urls": [url], "advanced_settings": { "full_content": true } }`
  (plus `advanced_settings.fetch_policy` when `max_age_hours` / `maxAgeHours` is
  set) to `POST https://api.parallel.ai/v1/extract` and returns a single-line
  title and extracted Markdown (`full_content`, falling back to `excerpts` if
  `full_content` is `null`). Entries in `errors` fail with sanitized diagnostics
  without exposing raw upstream error bodies.
- **DeepSeek** sends `{ "url": "..." }` to `POST https://api.deepseek.com/v1/tools/fetch`
  and returns a single-line title and provider Markdown, preserving paragraphs.
  HTTP 403 indicates a service security-policy rejection; HTTP 404 indicates no
  usable content could be retrieved.
- Empty titles are valid; invalid schemas or whitespace-only content fail.
- The model-facing `Requested URL` and `details.url` identify the normalized
  **requested URL**, not a verified final redirect destination. Details also
  contain `provider`, `title`, `truncated`, optional `maxAgeHours`, and optional
  `fullOutputPath`; no original `contentType` is returned.
- `web_fetch` declares an `outputSchema` and sets `structuredContent`
  (`{ provider, url, title, content }`) so Codemode scripts receive the
  extracted page text directly without parsing the model-facing header.

There is no raw JSON/CSV/XML/plain-text pass-through guarantee. Provider content
may be incomplete, include navigation/comments, or lose links, code formatting,
and mathematical notation. Browser login and JavaScript rendering are not
guaranteed. See the [Exa Contents reference](https://docs.exa.ai/reference/get-contents),
[Parallel Extract reference](https://docs.parallel.ai/api-reference/extract/extract),
and [DeepSeek Fetch reference](https://api-docs.deepseek.com/api/fetch/).

## Search

```typescript
web_search({ query: "Node.js release notes site:nodejs.org" })
web_search({ query: "React Server Components caching", mode: "deep", max_age_hours: 24 })
web_search({ query: "TypeScript releases site:github.com", count: 5, need_content: true })
```

- `count` defaults to **10**, with an allowed range of **1–50** (public
  **Parallel** search modes cap returned results at **20**). Fewer or zero
  results are valid.
- `mode` (Exa: `"lite"`, `"auto"`, `"deep-lite"`, `"deep"`; Parallel: `"turbo"`,
  `"fast"`, `"basic"`, `"advanced"`) and `max_age_hours` (`-1` to `720`)
  optionally override configured defaults per call. Passing a mode belonging to
  another provider, or passing `mode` / `max_age_hours` when `deepseek` is
  active, fails explicitly before reading credentials.
- **Exa** sends `query`, `type` (from `mode`, default `"auto"`), `numResults`
  (`count`), and a single content view in `contents` (`{ "highlights": true }`
  when `need_content` is `false`, or `{ "text": true }` when `need_content` is
  `true`, plus `maxAgeHours` when applicable) to `POST https://api.exa.ai/search`
  rather than downloading both views at once. Exa's base rate for the selected
  `mode` covers up to 10 results, with per-result charges above 10 returned
  results; `max_age_hours` does not change request pricing. A per-call
  `mode: "lite"` override ignores a configured `maxAgeHours` default, while
  passing `max_age_hours` when the effective `mode` is `"lite"` fails
  explicitly.
- **Parallel** sends `mode` (default `"fast"`), `search_queries: [query.trim()]`
  (**1–200 Unicode characters** after trimming), and `advanced_settings`
  (`max_results: count`, plus `fetch_policy: { max_age_seconds }` when
  `maxAgeHours >= 0`, using a 600-second minimum for `0` and omitting
  `fetch_policy` when omitted or `-1` so retrieval stays on Parallel's cached
  index) to `POST https://api.parallel.ai/v1/search`. Parallel's base rate for
  the selected `mode` (`turbo`/`fast` vs `basic`/`advanced`) covers up to 10
  results, with per-result charges above 10. Parallel Search returns Markdown
  `excerpts` as summaries and rejects `need_content: true` explicitly before
  reading credentials (use `web_fetch` for full page text).
- **DeepSeek** sends `query`, `count`, and `need_content` (default `false`) to
  `POST https://api.deepseek.com/v1/tools/search`. Queries accept **1–128 Unicode
  characters** and search operators. Long summaries fall back to snippets;
  `need_content: true` requests available page content in the same Search call
  (prefer fewer results to limit output).

Invalid, non-HTTP(S), or credential-bearing source URLs are omitted with a count
before applying `count`. All-invalid results are distinguished from an empty
search. Titles, site names, and dates use single-line whitespace (empty or
whitespace-only search titles fall back to the result URL); summaries/excerpts
and page content retain paragraphs. Provider summaries are not verified
quotations, and the extension never visits result URLs. `web_search` declares an
`outputSchema` and sets `structuredContent`
(`{ provider, query, results, omittedInvalidUrls }`) so Codemode scripts receive
structured sources directly.

See the [Exa Search reference](https://docs.exa.ai/reference/search),
[Parallel Search reference](https://docs.parallel.ai/api-reference/search/web),
and [DeepSeek Search reference](https://api-docs.deepseek.com/api/search/).

## Tool cards in Pi

Cards display lowercase **`web_fetch`** and **`web_search`** headers matching
the tool names. Calls show the URL or query, with a compact result summary
(fetched page title for Fetch, plus provider, search mode when applicable,
result count for Search, and Pi-reported execution time).

Use Pi's expand-tools shortcut (normally `ctrl+o`) to reveal Markdown content,
numbered search results, source URLs, compact publication dates, summaries, and
optional page content. The title and summary keep the same style in both views;
the shortcut hint follows your keybindings. Errors, omitted-source notices, and
full-output file paths remain visible on current provider cards when collapsed.

Expansion only reveals the existing bounded preview: it does not fetch again or
read the full-output file. Use `read` for that file. Presentation metadata in
`details.display` references the model-facing text rather than storing another
copy of the page. Renderers remove terminal control sequences and shorten ISO
timestamps for display only; model-facing content and saved full output are
unchanged. Older session results without presentation metadata or from removed
providers use a 5-line plain-text preview when collapsed and reveal their full
saved text on expansion.

## Shared limits and privacy

- Fetch has a **60-second** total deadline; Search has **120 seconds**. These cover
  request preparation, network transfer, response decoding, and output. Cancellation
  aborts outbound network work immediately.
- API responses have a **2 MiB decoded limit**. Oversized responses fail without
  partial output, even after a potentially billable HTTP 200. Malformed, partial,
  wrong-content-type, and invalid UTF-8 API responses also fail explicitly.
- API requests do not follow redirects, retry automatically, or fall back to
  other providers. HTTP 408, 429, and 5xx (including 529 overloaded) diagnostics
  suggest retrying later. HTTP 401 indicates authentication failure, 402
  insufficient balance or credit/budget limit, and 429 rate limiting.
- Errors retain HTTP status, recognized network codes, and stable diagnostics,
  never raw provider bodies or transport messages. Unknown transport failures use
  a generic diagnostic.
- Previews are limited to **2,000 lines / 50 KiB**. Full formatted output is saved
  when truncated to `pi-web-fetch-*/content.txt` or `pi-web-search-*/content.txt`;
  continue with `read`. Directories are 0700 and files 0600 on POSIX. Failed writes
  are cleaned up; successful files remain until removed or OS temporary cleanup.
  Search files contain selected results and omission notices, not discarded entries.
- The selected provider receives only the query or normalized URL (including
  path/query) and request source IP, never conversation or repository content.
  Inputs and returned content enter the Pi conversation; do not include secrets.
  Results are untrusted data, not instructions, and full output files do not
  prove complete page retrieval. Browser cookies are never reused.

Cancellation cannot undo provider charges or server-side tool usage.

## Pi compatibility

Verified with **Pi 1.6.0 on Linux** using **Node 22.19.0 and Node 26.13.1**.

SDK tests discover the package through its manifest, load its TypeScript extension,
and execute both tools across Exa, Parallel, and DeepSeek using synthetic
environment API keys and local HTTP/controlled responses. They cover
per-provider consent, environment-only authentication decoupled from Pi's model
registry, visibility, prompt guidelines, reload, decoding, resource limits,
cancellation, deadlines, Codemode structured output, and TUI card rendering. No
live account is needed; these checks do not guarantee site availability or
extraction quality.

Host-provided libraries use `"*"` peers as Pi recommends; this does not promise
compatibility with every Pi release. The package remains `private: true` and is not
published to npm.

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
