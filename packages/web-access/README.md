# Web access

A small Pi extension providing two independent tools:

- `web_fetch` reads HTTP(S) URLs directly, without an API key or hosted extraction
  service. Public networks require no configuration; optional `allowRanges`
  settings support trusted networks such as a TUN proxy's fake-IP address pool.
- `web_search` queries DeepSeek's standalone Search API after explicit user setup.
  It returns provider summaries and optional page content without calling
  `web_fetch` or a chat model.

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
changing the extension. Do not install both the directory and its entrypoint.
The repository root is not a Pi package.

## Use

Ask Pi to read a URL, or explicitly request a `web_fetch` call:

```typescript
web_fetch({ url: "https://example.com" })
```

HTML/XHTML becomes readable plain text with headings, lists, code and links.
Scripts, styles, navigation, footers, forms, images, frames, and explicitly hidden
elements are omitted; this is text extraction, not browser rendering or a
guarantee that only article content remains. Relative links are resolved against
the final page URL. Plain text, Markdown, CSV, JSON (including `+json` media
types), and XML are returned as text without HTML conversion.

The result includes the final source URL and media type. Retrieved content is
untrusted data, never instructions. A page can contain malicious instructions,
inaccurate text, or a login/challenge page even when its HTTP status is successful.

## Limits and failure behavior

These limits apply to `web_fetch`; search has its own limits below.

- One URL per call, at most 2,048 characters.
- A 60-second deadline covers DNS, connection, redirects, and body download.
  User cancellation stops waiting and closes active HTTP requests. OS DNS work
  cannot itself be interrupted, but a late answer cannot start a request.
- At most five redirects; each destination is validated again. HTTPS-to-HTTP
  downgrades, embedded URL credentials, and non-HTTP(S) schemes are rejected.
- Destinations must be public or explicitly included in `allowRanges`. Every DNS
  answer is checked, including after redirects, and the chosen address is pinned
  for the actual connection to prevent a second DNS lookup from changing it.
  TLS certificate verification remains enabled. See the proxy trust boundary below.
- Response bodies are limited to 2 MiB, including chunked responses. Oversized
  responses fail rather than masquerading as a complete page.
- Output previews use Pi's 2,000-line / 50 KiB limit, followed by a truncation
  notice when needed. The full extracted text is then stored in a private
  temporary directory and can be read with Pi's `read` tool. These files are
  not automatically deleted by the extension; use normal OS temporary-file
  cleanup or remove them after use.
- HTTP errors, partial HTTP responses, empty text, unsupported content types,
  invalid text encodings, network errors, and timeouts fail explicitly.
- HTTP charset declarations are honored; UTF-8 is assumed otherwise. HTML
  charset meta tags are not sniffed.
- Requests ask for `Accept-Encoding: identity`. Servers returning compressed
  content anyway are rejected rather than decompressed.

There is no JavaScript execution, cookie jar, login, custom request headers,
explicit HTTP/SOCKS proxy transport, retry/fallback chain, search, PDF extraction, image
download, or local-file access. `web_fetch` does not use browser cookies or Pi
model credentials. URLs and extracted text enter the Pi conversation; do not put
secrets in URLs. Network access exposes the requested URL to its destination and
your network infrastructure.

### Network configuration: allowRanges

The optional user configuration file is `~/.pi/agent/web-access.json`. Its directory
follows Pi's `PI_CODING_AGENT_DIR` override when set. No project-local configuration
or model-supplied network permission parameters are read.

For a TUN proxy using the `198.18.0.0/16` fake-IP pool, create:

```json
{
  "allowRanges": ["198.18.0.0/16"]
}
```

Use your proxy's actual address pool, not a broader range. TUN already handles
routing; no SOCKS settings or proxy auto-detection are needed.

- A missing file, `{}`, or `{"allowRanges": []}` permits public addresses only.
- `allowRanges` is an additive list of IPv4/IPv6 CIDRs, not a replacement for
  public access. It applies to both DNS results and IP literals in URLs, on every
  redirect hop. All DNS answers must be public or explicitly allowed.
- Use IPv4 CIDRs for IPv4-mapped IPv6 addresses; mapped addresses are normalized
  for matching. CIDR prefixes containing host bits are matched as their network.
- Malformed JSON, unknown fields, invalid CIDRs, and all-address `/0` ranges fail
  explicitly. Invalid `web-access.json` prevents the entire extension from loading
  at startup/reload, making both tools unavailable. Invalid edits during a session
  fail on the next tool call; fix the configuration and reload.
- The file is re-read for each call. Changes apply to the next call without
  restarting Pi; an in-flight call keeps the permissions it started with.
- This only changes address permissions. Protocol restrictions, URL credential
  rejection, TLS verification, redirect limits, cancellation, and size limits
  remain in effect. It does not make retrieved content trusted.

Only configure networks you intend the tool to reach. Allowing a private range
also permits access to services inside that range. With a fake-IP proxy, the
client sees the synthetic address and cannot independently verify the proxy's
final destination: that part of the access policy is delegated to your trusted
proxy. Keep any necessary internal-network restrictions in the proxy's egress
policy. Do not use this exception as a substitute for network isolation in a
multi-user service.

## Search

### Enable DeepSeek search

Configure DeepSeek authentication in Pi with `/login deepseek` or
`DEEPSEEK_API_KEY` in Pi's launch environment. No DeepSeek chat model selection is
needed. Keep credentials out of tool arguments and `web-access.json`.

Add this to the user-level `web-access.json`, preserving any `allowRanges`:

```json
{
  "search": { "provider": "deepseek" }
}
```

This authorizes billable search using Pi-resolved credentials, which may also be
used for DeepSeek chat. Pi owns provider configuration and authentication.
The effective auth base URL (auth override, otherwise provider default) must have
the `https://api.deepseek.com` origin. Only its origin is used; requests always
use the fixed Search endpoint below.

Run `/reload` after enabling search. Search defaults to inactive without this
setting; explicit tool selection changes visibility, not permission. Consent is
checked and authentication resolved on every call. Removing `search` blocks subsequent
calls even if Pi keeps the tool active across reloads; in-flight calls retain
their starting consent. Restart Pi when changing its launch environment.

### Search usage

```typescript
web_search({ query: "Node.js release notes site:nodejs.org" })
web_search({ query: "TypeScript releases site:github.com", count: 5, need_content: true })
```

- `query` is sent unchanged, including operators such as `site:`. DeepSeek requires
  1–128 Unicode characters and rejects blank queries; long queries fail locally.
- `count` defaults to **10**, with an allowed range of **1–50**. Fewer or zero
  results are valid.
- `need_content` defaults to **false**. Results include long provider summaries,
  falling back to snippets. Enabling it requests available page content in the
  same response; prefer fewer results to limit output.

Results preserve provider order and include titles, source URLs, summaries and
available dates/site names. Unparseable, non-HTTP(S), or credential-bearing URLs
are omitted with a count; valid URLs are normalized. Only the first `count`
usable results are returned, even if DeepSeek sends more than 50. All-invalid
results are distinguished from an empty search. Whitespace in titles, site names
and dates is collapsed to single lines; summaries and page content retain paragraphs.

### Search limits and privacy

- Requests go only to `POST https://api.deepseek.com/v1/tools/search`, with
  `query`, `count`, and `need_content`. No conversation or repository content is
  attached; DeepSeek sees the query and source IP. Do not include secrets.
  The extension does not fetch source URLs, call chat models, follow redirects,
  retry, or use another backend.
- Pi's API key supplies the default Bearer header. Provider headers, then resolved
  auth headers override it case-insensitively; `null` suppresses a header.
  Authorization is required; the tool sets JSON Content-Type.
- A **120-second deadline** covers authentication, the request, response and
  output. Cancellation stops waiting for credentials and aborts network work;
  late credentials cannot start a request. Pi's secret-manager work may continue.
- The **2 MiB decoded-response limit** and strict response schema reject
  oversized, malformed, partial, non-JSON or invalid UTF-8 responses. Cancellation
  or local rejection cannot undo provider charges.
- Previews are limited to **2,000 lines / 50 KiB**. When truncated, complete
  formatted output for selected results and invalid-URL notices is saved in a
  private `pi-web-search-*/content.txt`; continue with `read`. Omitted entries
  are not saved, and files are not automatically deleted.
- HTTP errors retain their status; network errors include recognized codes such as
  `ENOTFOUND`, `ECONNREFUSED`, `CERT_HAS_EXPIRED`, and `UND_ERR_CONNECT_TIMEOUT`.
  Raw error bodies and transport messages are not exposed. Unrecognized transport
  errors use a generic diagnostic. HTTP 401 indicates authentication failure,
  402 insufficient balance, and 429 rate limiting. There is no credential fallback.
- Results are untrusted data, not instructions. Dates are provider-reported;
  summaries are not verified quotations, and page content may be incomplete.
  `allowRanges` applies only to direct `web_fetch`, not hosted search.

See the [Search reference](https://api-docs.deepseek.com/api/search/) and
[Search & Fetch guide](https://api-docs.deepseek.com/guides/search) for operators,
account limits and pricing. Billing is per successful non-empty search request,
not per result.

## Pi compatibility

Latest verified compatible version: **Pi 1.5.2**. The verified Node runtimes are
recorded in the repository's [Node.js compatibility](../../README.md#nodejs-compatibility)
section; this package retains its `engines.node` minimum.

The automated SDK tests discover this package through its `pi` manifest, load
its TypeScript extension, and execute both tools with only network boundaries
replaced. They verify private-target rejection for fetch and search opt-in,
default visibility, Pi credential and header resolution, and the effective-origin
boundary.
Tests use synthetic keys; no live model or search account is required. This
establishes Pi integration, not live DeepSeek search quality or account access. Live website availability is not part of the CI guarantee.

Host-provided libraries are declared as `"*"` peer dependencies as Pi recommends.
That does not promise compatibility with every Pi release. This package remains
private and unpublished.

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
