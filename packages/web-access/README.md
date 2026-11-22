# @rchardx/pi-web-access

Two independent, opt-in Pi tools backed by DeepSeek's standalone hosted
web-tool endpoints:

- `web_fetch` returns a page title and Markdown or plain-text content.
- `web_search` returns ordered sources alongside provider-supplied summaries and
  optional page content.

Neither tool invokes the other, and neither routes through a chat-model
generation turn.

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

Configure authentication in Pi before enabling the tools:

- **DeepSeek** (`deepseek`): `/login deepseek` or `DEEPSEEK_API_KEY` (no DeepSeek
  chat model selection is required).

Keep credentials out of tool arguments and configuration.

Enable the capabilities you want in `~/.pi/agent/web-access.json` (its directory
follows `PI_CODING_AGENT_DIR`):

```json
{
  "search": {
    "providers": {
      "deepseek": {}
    }
  },
  "fetch": {
    "providers": {
      "deepseek": {}
    }
  }
}
```

Each `deepseek` entry under `providers` independently authorizes possible
provider charges, use of Pi-resolved credentials, and query or URL disclosure to
DeepSeek:

- `deepseek` is the only supported provider; it uses standalone tool endpoints
  and accepts only `{}`.
- `defaultProvider` is optional and, when set, must be `"deepseek"`.
- Routing is independent of the active Pi chat model (`ctx.model`), and failures
  report directly without retries or fallbacks.

Omit `search` or `fetch` to disable that tool; a missing file or `{}` enables
neither. Project settings and tool arguments cannot grant permission.

Run `/reload` after enabling or disabling a tool. Explicit tool selection affects
visibility, not permission. Consent, routing, and credentials are rechecked on
every call; removing a capability blocks subsequent calls even if Pi keeps the
tool active. In-flight calls retain starting consent. Restart Pi when changing
its launch environment.

Only `search` and `fetch` settings are supported. Malformed JSON, unknown fields,
empty `providers` maps, or invalid settings prevent both tools from loading;
invalid edits during a session fail on the next call. Fix the file and reload.

### Authentication and origin boundaries

Pi owns authentication and provider configuration:

| Provider | Required effective origin | Fixed endpoint | Default HTTP auth |
| --- | --- | --- | --- |
| `deepseek` | `https://api.deepseek.com` | `POST /v1/tools/fetch` or `/v1/tools/search` | `Authorization: Bearer <key>` |

The effective auth base URL (auth override, otherwise provider default) must
match the required origin above. Provider headers, then resolved auth headers
override defaults case-insensitively, with `null` deleting a header. Required
authentication headers must remain after overrides, and the tools set JSON
`Content-Type`.

Direct local fetching is not provided. For localhost or intranet URLs, use
`curl` through `bash`: hosted providers visit targets from their infrastructure,
not your machine. Fetching is subject to each service's security policy and
target-site access rules.

## Fetch

```typescript
web_fetch({ url: "https://example.com/article" })
```

- Accepts one absolute HTTP(S) URL without an embedded username/password.
  Input and normalized URLs are limited to **8,192 characters**. Normalization
  removes fragments and may expand non-ASCII paths through escaping.
- **DeepSeek** sends `{ "url": "..." }` to `POST https://api.deepseek.com/v1/tools/fetch`
  and returns a single-line title and provider Markdown, preserving paragraphs.
  HTTP 403 indicates a service security-policy rejection; HTTP 404 indicates no
  usable content could be retrieved.
- Empty titles are valid; invalid schemas or whitespace-only content fail.
- The model-facing `Requested URL` and `details.url` identify the normalized
  **requested URL**, not a verified final redirect destination. Details also
  contain `provider`, `title`, `truncated`, and optional `fullOutputPath`; no
  original `contentType` is returned.
- `web_fetch` declares an `outputSchema` and sets `structuredContent`
  (`{ provider, url, title, content }`) so Codemode scripts receive the
  extracted page text directly without parsing the model-facing header.

There is no raw JSON/CSV/XML/plain-text pass-through guarantee. Provider content
may be incomplete, include navigation/comments, or lose links, code formatting,
and mathematical notation. Browser login and JavaScript rendering are not
guaranteed. See the [DeepSeek Fetch reference](https://api-docs.deepseek.com/api/fetch/).

## Search

```typescript
web_search({ query: "Node.js release notes site:nodejs.org" })
web_search({ query: "TypeScript releases site:github.com", count: 5, need_content: true })
```

- `count` defaults to **10**, with an allowed range of **1–50**. Fewer or zero
  results are valid.
- **DeepSeek** sends `query`, `count`, and `need_content` (default `false`) to
  `POST https://api.deepseek.com/v1/tools/search`. Queries accept **1–128 Unicode
  characters** and search operators. Long summaries fall back to snippets;
  `need_content: true` requests available page content in the same Search call
  (prefer fewer results to limit output).

Invalid, non-HTTP(S), or credential-bearing source URLs are omitted with a count
before applying `count`. All-invalid results are distinguished from an empty
search. Titles, site names, and dates use single-line whitespace (empty or
whitespace-only search titles fall back to the result URL); summaries and page
content retain paragraphs. Provider summaries are not verified quotations, and
the extension never visits result URLs. `web_search` declares an `outputSchema`
and sets `structuredContent`
(`{ provider, query, results, omittedInvalidUrls }`) so Codemode scripts receive
structured sources directly.

See the [DeepSeek Search reference](https://api-docs.deepseek.com/api/search/).

## Tool cards in Pi

Cards display lowercase **`web_fetch`** and **`web_search`** headers matching
the tool names. Calls show the URL or query, with a compact result summary
(fetched page title for Fetch, plus provider, result count for Search, and
Pi-reported execution time).

Use Pi's expand-tools shortcut (normally `ctrl+o`) to reveal Markdown content,
numbered search results, source URLs, summaries, and optional page content. The
title and summary keep the same style in both views; the shortcut hint follows
your keybindings. Errors, omitted-source notices, and full-output file paths
remain visible on current provider cards when collapsed.

Expansion only reveals the existing bounded preview: it does not fetch again or
read the full-output file. Use `read` for that file. Presentation metadata in
`details.display` references the model-facing text rather than storing another
copy of the page. Renderers remove terminal control sequences for display only;
model-facing content and saved full output are unchanged. Older session results
without presentation metadata or from removed providers use a 5-line plain-text
preview when collapsed and reveal their full saved text on expansion.

## Shared limits and privacy

- Fetch has a **60-second** total deadline; Search has **120 seconds**. These cover
  authentication, request, response, and output. Cancellation aborts network work
  and stops waiting for credentials, though Pi's secret-manager work may continue.
- API responses have a **2 MiB decoded limit**. Oversized responses fail without
  partial output, even after a potentially billable HTTP 200. Malformed, partial,
  wrong-content-type, and invalid UTF-8 API responses also fail explicitly.
- API requests do not follow redirects, retry automatically, or fall back to
  other providers. HTTP 408, 429, and 5xx (including 529 overloaded) diagnostics
  suggest retrying later. HTTP 401 indicates authentication failure, 402
  insufficient balance, and 429 rate limiting.
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
and execute both tools through DeepSeek using synthetic credentials and local
HTTP/controlled responses. They cover explicit consent, chat-model-independent
routing without fallback, visibility, reload, API-key and header authentication,
effective-origin boundaries, decoding, resource limits, cancellation, deadlines,
Codemode structured output, and TUI card rendering. No live account is needed;
these checks do not guarantee site availability or extraction quality.

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
