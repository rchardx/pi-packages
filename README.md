# pi-packages

Personal [Pi coding agent](https://github.com/earendil-works/pi) packages maintained
in one npm-workspaces repository. Each capability lives in its own
[`packages/<capability>/`](packages/README.md) directory.

Install individual packages from a checkout or, when available, the rolling
[Nightly GitHub release](https://github.com/rchardx/pi-packages/releases/tag/nightly).
Packages are not published to npm; the repository root is not an installable bundle.

## Setup

For development, install Pi, the default Node.js version in
[`.node-version`](.node-version), npm, and [Git LFS](https://git-lfs.com/).
Clone the repository and install its dependencies:

```bash
git clone https://github.com/rchardx/pi-packages.git
cd pi-packages
npm ci
```

All package commands below run from this repository root. Local Pi installs refer
to this checkout rather than copying it; keep the checkout in place. Choose either
a temporary session or a persistent install, not both for the same package.

For iterative development against independent installation copies, use the
[installed-package development workflow](CONTRIBUTING.md#develop-against-an-installed-package).
It packs local npm tarballs into independent installation copies and registers
these in your normal Pi environment, so plain `pi` uses them without publishing
or separate credentials. Isolated Pi configuration is optional; source loading
alone does not validate packaged dependency resolution.

## Packages: installation and usage

| Package | Surface | Try for one session | Install for your Pi user | Usage guide |
| --- | --- | --- | --- | --- |
| ask | `ask` | `pi -e ./packages/ask` | `pi install ./packages/ask` | [Usage, limits, and compatibility](packages/ask/README.md) |
| lsp | `lsp`, `/lsp`, post-edit diagnostics | `pi -e ./packages/lsp` | `pi install ./packages/lsp` | [Usage, limits, and compatibility](packages/lsp/README.md) |
| web-access | `web_fetch`, `web_search` | `pi -e ./packages/web-access` | `pi install ./packages/web-access` | [Usage, limits, and compatibility](packages/web-access/README.md) |
| background | `bash` (override), `/background` | `pi -e ./packages/background` | `pi install ./packages/background` | [Usage, limits, and compatibility](packages/background/README.md) |
| subagents | `subagent`, `subagent_cancel`, `subagent_list`, `subagent_send`, `subagent_wait`, `/subagents` | `pi -e ./packages/subagents` | `pi install ./packages/subagents` | [Usage, limits, and compatibility](packages/subagents/README.md) |
| statusline | Interactive TUI footer | `pi -e ./packages/statusline` | `pi install ./packages/statusline` | [Usage, limits, and compatibility](packages/statusline/README.md) |

### ask

Collect structured pre-execution user clarification through 1–4 multiple-choice
questions (2–5 options each, optional `multiSelect`, plus an automatic `Other…`
free-text input) instead of guessing across ambiguous requirements. Interactive
`tui` sessions render a keyboard-navigable multi-tab prompt with CJK IME cursor
support; `rpc` sessions fall back to `select` and `input` dialogs; `print` and
`json` sessions (including delegated subagent runs) hide `ask` via
`prepareLoadout` without removing it from persisted session tool selections, and
fail closed if invoked directly. See the [ask usage guide](packages/ask/README.md)
for schema and mode details.

### lsp

Append a file's errors and warnings to successful `edit` and `write` results,
and provide a read-only `lsp` tool for one file or symbol at a time
(`diagnostics`, `definition`, `references`, `hover`) across interactive, RPC,
print, and subagent sessions. Language servers are not bundled: one starts in a
trusted project when a matching executable is installed (a project-local
TypeScript 7 `tsc`, `typescript-language-server`, `basedpyright-langserver` /
`pyright-langserver` / `pylsp`, `rust-analyzer`, `gopls`, `clangd`, or custom
`~/.pi/agent/lsp.json` entries; see the
[installation guide](packages/lsp/README.md#installing-language-servers)).
Edits wait at most 0.8s; a server that has not answered is never reported as a
clean file. See the [lsp usage guide](packages/lsp/README.md) for actions,
configuration, and limits.

### web-access

Use user-enabled hosted providers (**DeepSeek** standalone tool APIs,
**Anthropic** Messages `web_search` / `web_fetch`, search-only **OpenAI** /
**OpenAI Codex** Responses `web_search`, and fetch-only **Google Gemini**
`url_context`) to search the web or fetch a page.
Both tools require [explicit per-provider opt-in](packages/web-access/README.md#enable-tools)
in `~/.pi/agent/web-access.json` and matching authentication configured in Pi
(`/login deepseek` or `DEEPSEEK_API_KEY`; `/login anthropic`, `ANTHROPIC_API_KEY`,
or `ANTHROPIC_AUTH_TOKEN`; `/login openai` or `OPENAI_API_KEY`;
`/login openai-codex`; `/login google` or `GEMINI_API_KEY`). Enabling a provider authorizes possible provider
charges and query or URL disclosure; tool selection alone never grants permission.

After setup and `/reload`, ask Pi to use either tool:

```typescript
web_fetch({ url: "https://example.com" })
web_search({ query: "Node.js release notes site:nodejs.org" })
```

Calls route to the active Pi model's provider when enabled in `providers`,
otherwise to `defaultProvider` when configured; there is no cross-provider
fallback on failure. Fetch has a 60-second total deadline; Search defaults to
10 results with a 120-second total deadline (`need_content: true` requests
available page content on DeepSeek Search without invoking `web_fetch`). Each
API response is limited to 2 MiB; long output is saved in a private local file
for continuing with Pi's `read` tool. Content is untrusted and may be incomplete
or lose original formatting. Pi displays compact `web_fetch` / `web_search`
cards; expanding adds Markdown synthesis, excerpts, and content beneath the same
summary without changing the model-facing output.

Fetching is performed by the selected hosted provider, not your local network.
Use `curl` through `bash` for localhost or intranet URLs. Direct local fetch is
not provided; replace legacy `{ "provider": "deepseek" }` and `allowRanges`
settings with the `providers` authorization map.

Missing configuration enables neither tool. Invalid `web-access.json` prevents
the entire extension from loading until fixed and reloaded. Authentication is
resolved by Pi for each provider's official origin, not silently sent around an
effective gateway route. Errors retain HTTP status, recognized provider tool
or stream error codes, or recognized network codes without exposing raw provider bodies or
transport messages. HTTP 408, 429, and 5xx errors suggest retrying later; the
extension does not retry automatically.

### background

Run long `bash` commands in the background in interactive or RPC mode and receive
completion notifications instead of polling. Logs retain up to 8MiB of raw output
per job; reaching the limit does not stop the command or its notification tail.
Logs mark omitted early output when the pre-background seed buffer overflows.
The status area shows `background: N running`; `/background` displays a read-only
snapshot of elapsed times and full commands without starting a model turn.
Print and JSON modes remain foreground-only. See the
[background usage guide](packages/background/README.md) for configuration and limits.

### subagents

Delegate well-scoped work to background child agents (up to 8 concurrent by
default) with fresh context and a shared working directory. Children can edit
files and run commands; completion reaches the parent automatically with a
collapsible TUI card and without polling. Live agents in the same root session
can discover peers (`subagent_list`), exchange direct or broadcast messages
(`subagent_send`), and wait for replies (`subagent_wait`); finished children
exit immediately and never receive further messages. Use `subagent_cancel` to
stop a child and `/subagents` to inspect running tasks. Tasks belong to the root
session and do not survive its shutdown.
See the [subagents usage guide](packages/subagents/README.md) for resource reloading,
model access, process requirements, built-in `explorer` and `librarian` roles,
optional `~/.pi/agent/subagents.json` limits and role overrides, and boundaries.
Children rebuild their own system prompts and retain supported parent CLI
restrictions and explicit prompt inputs. Indirectly callable deferred/codemode
tools stay available without being implicitly added to the tools declared to the
model. Nested spawning is not exposed.

### statusline

Replace Pi's interactive footer with a fixed two-line layout that renders active
extension statuses inline after `~/path (branch)` (`subagents` first, then
`background`, then other keys alphabetically) while keeping token, cost, context,
and model statistics on line 2. Print, JSON, and RPC modes are unaffected. See
the [statusline usage guide](packages/statusline/README.md) for behavior notes.

After updating the checkout, run `npm ci` when dependencies changed and restart Pi
or use `/reload` to load the updated extension.

## Node.js compatibility

[`.node-version`](.node-version) selects the default development runtime.
[`package.json`](package.json) defines the supported runtime floor; each package
also declares its own `engines.node`. A newer development runtime does not raise
the minimum version required to use the packages.

Checks, tests, and Pi SDK package discovery, extension loading, and tool execution
have been verified on **Node 22.19.0 and Node 26.13.1** with Pi 1.5.2.
CI derives the exact minimum from the root `engines.node` and tests it alongside
the default development version. Both must pass the required `check` gate.
Node type declarations stay on the minimum supported major to help prevent use of
newer-only APIs; runtime tests are still required to establish compatibility.

## Pi compatibility

| Status | Pi version |
| --- | --- |
| Development target | `@earendil-works/pi-coding-agent@1.5.2` |
| Latest verified compatible version | Pi `1.5.2` — package discovery, extension loading, and tool execution |

Each package's README records the scope of its compatibility checks and network
limitations. npm's latest release is not automatically a supported version.
See [compatibility rules](AGENTS.md#compatibility) for how this is maintained.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for checkout setup, validation, signed
commits, and the pull request workflow. [AGENTS.md](AGENTS.md) defines execution
constraints, package boundaries, and compatibility requirements.

## Distribution

The repository root is private development infrastructure, not an installable
Pi bundle. `pi install git:github.com/rchardx/pi-packages` is not a substitute for
the individual package installations above.

Packages remain marked `private: true` and have not been published to npm.
Publication is a separate decision from source licensing.

### Nightly tarballs

The [nightly workflow](.github/workflows/nightly.yml) checks `main` daily at
00:00 UTC and supports manual dispatch on `main` with optional `force` (default
`false`). It skips unchanged published commits unless forced.

After checks, tests, and installed-tarball smoke tests pass on both Node
runtimes, it updates one rolling `nightly` tag and **Nightly** prerelease
(never Latest) with one `pi-<capability>-nightly.tgz` archive per package under
`packages/`. Package versions use `<base>-nightly.<github.run_number>.g<full SHA>`
while source versions stay unchanged and `private: true`.

Nightlies are automated development snapshots, not stable releases. Follow
[install a nightly snapshot](CONTRIBUTING.md#install-a-nightly-snapshot) to
install downloaded tarballs into a fresh npm prefix and register the installed
directories with Pi. See
[nightly publishing and recovery](CONTRIBUTING.md#nightly-publishing-and-recovery)
for failure handling.

## License

This repository and its packages are licensed under the [MIT License](LICENSE).
Third-party dependencies retain their own licenses.
