# Web access

Two independent, opt-in Pi tools backed by user-enabled hosted providers
(**DeepSeek**, **Anthropic**, search-only **OpenAI** / **OpenAI Codex**, and
fetch-only **Google Gemini**):

- `web_fetch` returns a page title and Markdown or plain-text content.
- `web_search` returns ordered sources alongside provider summaries or grounded synthesis.

Neither tool invokes the other.

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

Configure authentication in Pi for each provider you intend to enable:

- **DeepSeek** (`deepseek`): `/login deepseek` or `DEEPSEEK_API_KEY` (no DeepSeek
  chat model selection is required).
- **Anthropic** (`anthropic`): `/login anthropic` (API key or Claude Pro/Max OAuth),
  `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN`.
- **Google** (`google`, fetch only): `/login google` or `GEMINI_API_KEY` (Gemini
  Developer API key; Vertex AI is not supported).
- **OpenAI** (`openai`, search only): `/login openai` (API key or Sign in with
  ChatGPT) or `OPENAI_API_KEY`.
- **OpenAI Codex** (`openai-codex`, search only): `/login openai-codex`
  (ChatGPT Plus/Pro subscription).

Keep credentials out of tool arguments and configuration.

Enable the capabilities and providers you want in `~/.pi/agent/web-access.json`
(its directory follows `PI_CODING_AGENT_DIR`):

```json
{
  "search": {
    "providers": {
      "deepseek": {},
      "anthropic": { "model": "claude-haiku-5-5" },
      "openai": {},
      "openai-codex": { "model": "gpt-6-luna" }
    },
    "defaultProvider": "deepseek"
  },
  "fetch": {
    "providers": {
      "deepseek": {},
      "anthropic": {},
      "google": { "model": "gemini-3.6-flash" }
    },
    "defaultProvider": "deepseek"
  }
}
```

Each entry under `providers` independently authorizes possible provider charges,
use of Pi-resolved credentials, and query or URL disclosure to that provider:

- `deepseek` uses standalone tool endpoints and accepts only `{}`.
- `anthropic` uses the Messages API and accepts an optional `"model"` ID
  (defaults to `claude-haiku-5-5`).
- `google` uses the Gemini API `generateContent` method with the built-in
  `url_context` tool and accepts an optional `"model"` ID (defaults to
  `gemini-3.6-flash`). It is fetch-only: the Gemini API terms for Grounding with
  Google Search require showing Google's rendered Search Suggestions with the
  results, unmodified, to the end user, which a terminal tool result consumed by
  the agent model cannot do, so `search` rejects it.
- `openai` and `openai-codex` use the Responses API `web_search` tool and accept
  an optional `"model"` ID (defaults to `gpt-5.4-mini` and `gpt-6-luna`). They
  are search-only: OpenAI offers no deterministic page-fetch tool, so `fetch`
  rejects them rather than approximating fetch through search.
- On each call, if the active Pi model's provider (`ctx.model.provider`) is
  listed in `providers`, that provider handles the request. Otherwise
  `defaultProvider` (which must also appear in `providers`) is used when set;
  without `defaultProvider`, the call fails before resolving credentials.
- There is no cross-provider fallback: once the target provider is selected,
  failures report directly without forwarding the query or URL elsewhere.

Omit `search` or `fetch` to disable that tool; a missing file or `{}` enables
neither. Project settings and tool arguments cannot grant permission. Replace
legacy `{ "provider": "deepseek" }` and `allowRanges` settings with the
`providers` map above.

Run `/reload` after enabling or disabling a tool. Explicit tool selection affects
visibility, not permission. Consent, routing, and credentials are rechecked on
every call; removing a capability or provider blocks subsequent calls even if Pi
keeps the tool active. In-flight calls retain starting consent. Restart Pi when
changing its launch environment.

Only `search` and `fetch` settings are supported. Malformed JSON, unknown fields,
empty `providers` maps, or invalid settings prevent both tools from loading;
invalid edits during a session fail on the next call. Fix the file and reload.

### Authentication and origin boundaries

Pi owns authentication and provider configuration:

| Provider | Required effective origin | Fixed endpoint | Default HTTP auth |
| --- | --- | --- | --- |
| `deepseek` | `https://api.deepseek.com` | `POST /v1/tools/fetch` or `/v1/tools/search` | `Authorization: Bearer <key>` |
| `anthropic` | `https://api.anthropic.com` | `POST /v1/messages` | `x-api-key: <key>`, or `Authorization: Bearer <token>` (including Claude Pro/Max OAuth) |
| `google` | `https://generativelanguage.googleapis.com` | `POST /v1beta/models/<model>:generateContent` | `x-goog-api-key: <key>` (an explicit `Authorization` or `x-goog-api-key` header replaces it) |
| `openai` | `https://api.openai.com` | `POST /v1/responses` | `Authorization: Bearer <key or ChatGPT token>` |
| `openai-codex` | `https://chatgpt.com` | `POST /backend-api/codex/responses` | `Authorization: Bearer <ChatGPT token>` plus `chatgpt-account-id` from the token's claims |

The effective auth base URL (auth override, otherwise provider default) must
match the required origin above. Provider headers, then resolved auth headers
override defaults case-insensitively, with `null` deleting a header. Required
authentication headers must remain after overrides, and the tools set JSON
`Content-Type`. As in Pi's own Codex transport, `openai-codex` always sends the
resolved ChatGPT token and its account ID, ignoring configured overrides of
those two headers; it defaults `originator: pi`.

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
- **Anthropic** sends `url` to `POST https://api.anthropic.com/v1/messages` with
  server tool `web_fetch_20250910` (`max_uses: 1`). Plain-text document results
  are read directly from `web_fetch_result` without assistant paraphrasing; PDF
  document results use the model's Markdown text after the last server tool
  block (adding an explicit incompleteness notice and
  `details.outputTokenLimitReached: true` if the model stops at `max_tokens`).
  Responses that refuse, pause before completion, exceed the context window,
  fail to invoke `web_fetch`, or return only `web_fetch_tool_result_error`
  results fail explicitly; a rejected extra call (`max_uses_exceeded`) after a
  successful fetch does not.
- **Google** sends the URL as the user message to `generateContent` with the
  `url_context` tool. Content is the model's Markdown rendering of the retrieved
  page, titled from the matching grounding chunk when Google provides one; it may
  be condensed despite instructions not to summarize. Thought summaries are
  excluded. The response must report `URL_RETRIEVAL_STATUS_SUCCESS` in
  `urlContextMetadata`; missing metadata, unsafe, paywalled, or failed
  retrievals, blocked prompts, safety finishes, and other abnormal finish reasons
  fail explicitly (`MAX_TOKENS` keeps the content with an incompleteness notice).
- Empty titles are valid; invalid schemas or whitespace-only content fail.
- The model-facing `Requested URL` and `details.url` identify the normalized
  **requested URL**, not a verified final redirect destination. Details also
  contain `provider`, optional `model`, `title`, `truncated`, optional
  `outputTokenLimitReached`, and optional `fullOutputPath`; no original
  `contentType` is returned.

There is no raw JSON/CSV/XML/plain-text pass-through guarantee. Provider content
may be incomplete, include navigation/comments, or lose links, code formatting,
and mathematical notation. Browser login and JavaScript rendering are not
guaranteed. See the [DeepSeek Fetch reference](https://api-docs.deepseek.com/api/fetch/),
[Anthropic web fetch documentation](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-fetch-tool),
and [Gemini URL context documentation](https://ai.google.dev/gemini-api/docs/url-context).

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
- **Anthropic** sends `query` to `POST https://api.anthropic.com/v1/messages` with
  server tool `web_search_20250305` (`max_uses: 1`). Queries accept **1–4,096
  Unicode characters**. Responses must contain a successful
  `web_search_tool_result` block (a rejected extra call after it is ignored)
  and finish cleanly (refusals, paused turns, and context-window overflows fail;
  `max_tokens` retains the retrieved sources and partial synthesis with an
  explicit incompleteness notice). Returns the grounded synthesis written after
  the last server tool block alongside deduplicated sources (cited URLs prioritized ahead of
  uncited results, capped locally to `count`), provider-reported page age, and
  cited excerpts when present. `need_content: true` adds a notice that full page
  bodies require `web_fetch`; Search never calls `web_fetch`.
- **OpenAI** and **OpenAI Codex** stream `query` to the Responses endpoint above
  with the hosted `web_search` tool (`store: false`; OpenAI also requests
  `web_search_call.action.sources`). Responses must contain a non-failed
  `web_search_call` and end with `response.completed`, `response.done`
  (Codex), or `response.incomplete`, judged by the response status as in Pi;
  ungrounded answers, failed searches, refusals, failed or cancelled responses,
  `error` events, and streams ending early fail explicitly (`max_output_tokens`
  incompleteness keeps the partial synthesis with a notice). Returns the synthesis written after
  the last search, `url_citation` sources first, then searched sources (capped
  locally to `count`). `need_content: true` adds the same `web_fetch` notice.
Invalid, non-HTTP(S), or credential-bearing source URLs are omitted with a count
before applying `count`. All-invalid results are distinguished from an empty
search. Titles, site names, and dates/ages use single-line whitespace; synthesis,
summaries, excerpts, and content retain paragraphs. Provider summaries and
syntheses are not verified quotations, and the extension never visits result URLs.

See the [DeepSeek Search reference](https://api-docs.deepseek.com/api/search/),
and [Anthropic web search documentation](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool).

## Tool cards in Pi

The tool names remain `web_fetch` and `web_search`; their cards display **Web fetch**
and **Web search**. Calls show the URL or query, with a compact result summary
(provider, optional helper model, result count, and Pi-reported execution time)
and up to three source titles for Search.

Use Pi's expand-tools shortcut (normally `ctrl+o`) to reveal Markdown content,
grounded synthesis, source URLs, summaries, and cited excerpts. The title and
summary keep the same style in both views; the shortcut hint follows your
keybindings. Provider text is untrusted and extraction may be incomplete. Errors,
omitted-source notices, and full-output file paths remain visible when collapsed.

Expansion only reveals the existing bounded preview: it does not fetch again or
read the full-output file. Use `read` for that file. Presentation metadata in
`details.display` references the model-facing text rather than storing another
copy of the page. Renderers remove terminal control sequences for display only;
model-facing content and saved full output are unchanged. Older session results
without presentation metadata retain a plain-text fallback.

## Shared limits and privacy

- Fetch has a **60-second** total deadline; Search has **120 seconds**. These cover
  authentication, request, response, and output. Cancellation aborts network work
  and stops waiting for credentials, though Pi's secret-manager work may continue.
- API responses (JSON bodies or OpenAI event streams) have a **2 MiB decoded
  limit**. Oversized responses fail without partial output, even after a
  potentially billable HTTP 200. Malformed, partial, wrong-content-type, and
  invalid UTF-8 API responses also fail explicitly. Event streams are read only
  until their terminal event.
- API requests do not follow redirects, retry automatically, or fall back to
  other providers. HTTP 408, 429, and 5xx (including 529 overloaded) diagnostics
  suggest retrying later. HTTP 401 indicates authentication failure, 402
  insufficient balance, and 429 rate limiting.
- Errors retain HTTP status, recognized provider tool or stream error codes, and
  recognized network codes, never raw provider bodies or transport messages. Unknown
  transport failures use a generic diagnostic.
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

Latest verified compatible version: **Pi 1.5.2**, on the runtimes recorded in
[Node.js compatibility](../../README.md#nodejs-compatibility).

SDK tests discover the package through its manifest, load its TypeScript extension,
and execute both tools across DeepSeek and Anthropic, search across OpenAI and
OpenAI Codex, and fetch through Google, using synthetic credentials
and local HTTP/controlled responses. They cover per-provider consent, active-model
routing without cross-provider fallback, visibility, reload, API-key and OAuth
authentication, effective-origin boundaries, decoding, resource limits,
cancellation, deadlines, and TUI card rendering. No live account is needed; these
checks do not guarantee site availability or extraction quality.

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
