# Web access

A small Pi extension providing one tool: `web_fetch`. It fetches HTTP(S) URLs
directly, with no API key, search provider, browser, or hosted extraction service.
Public networks require no configuration; optional `allowRanges` settings support
trusted networks such as a TUN proxy's fake-IP address pool.

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

- One URL per call, at most 2,048 characters.
- A 20-second deadline covers DNS, connection, redirects, and body download.
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
download, or local-file access. No browser cookies or Pi model credentials are
read. URLs and extracted text enter the Pi conversation; do not put secrets in
URLs. Network access exposes the requested URL to its destination and your
network infrastructure.

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
  explicitly before any request; they do not silently restore default permissions.
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

## Pi compatibility

Latest verified compatible version: **Pi 1.5.2**. The verified Node runtimes are
recorded in the repository's [Node.js compatibility](../../README.md#nodejs-compatibility)
section; this package retains its `engines.node` minimum.

The automated SDK test discovers this package through its `pi` manifest, loads
its TypeScript extension, and executes `web_fetch` against a local HTTP fixture
with only the network boundary replaced. It also verifies that private targets
are rejected. No model request or credentials are needed for these tests.
Live website availability is not part of CI or a compatibility guarantee.

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
