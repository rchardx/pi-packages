# Packages

Each direct child directory is an independently owned Pi package and npm
workspace. Install only the capabilities you need; the repository root is not an
installable Pi bundle.

## Available packages

| Package | Entrypoint | Surface | User config (optional) | Modes | Guide |
| --- | --- | --- | --- | --- | --- |
| `@rchardx/pi-ask` | `packages/ask/index.ts` | `ask` tool | None | `tui`, `rpc` (hidden in `print`/`json`) | [ask/README.md](ask/README.md) |
| `@rchardx/pi-lsp` | `packages/lsp/index.ts` | `lsp` tool, `/lsp`, `edit`/`write` diagnostic hook | `~/.pi/agent/lsp.json` | `tui`, `rpc`, `print`, `json` | [lsp/README.md](lsp/README.md) |
| `@rchardx/pi-web-access` | `packages/web-access/index.ts` | `web_fetch`, `web_search` tools | `~/.pi/agent/web-access.json` (required to enable tools) | `tui`, `rpc`, `print`, `json` | [web-access/README.md](web-access/README.md) |
| `@rchardx/pi-background` | `packages/background/index.ts` | `bash` tool override, `/background` | `~/.pi/agent/background.json` | Backgrounding in `tui`/`rpc`; foreground-only in `print`/`json` | [background/README.md](background/README.md) |
| `@rchardx/pi-subagents` | `packages/subagents/index.ts` | `subagent`, `subagent_cancel`, `subagent_list`, `subagent_send`, `subagent_wait`, `/subagents` | `~/.pi/agent/subagents.json` | `tui`, `rpc` on Linux/macOS | [subagents/README.md](subagents/README.md) |
| `@rchardx/pi-statusline` | `packages/statusline/index.ts` | Custom 2-line footer | None | `tui` only | [statusline/README.md](statusline/README.md) |
| `@rchardx/pi-prompt-history` | `packages/prompt-history/index.ts` | Persistent per-`cwd` editor history | None | `tui` only | [prompt-history/README.md](prompt-history/README.md) |

All user configuration paths honor `PI_CODING_AGENT_DIR` when set.

## Summaries

- **[ask](ask/README.md):** collects structured pre-execution clarification
  through 1–4 multiple-choice questions (2–5 options each, optional
  `multiSelect`, plus automatic `Other…` free-text input) with a custom TUI
  prompt and RPC dialog fallback.
- **[lsp](lsp/README.md):** appends a file's errors and warnings to successful
  `edit` and `write` results within a 0.8s budget and provides a read-only
  single-file/symbol `lsp` tool (`diagnostics`, `definition`, `references`,
  `hover`) backed by locally installed language servers in trusted projects.
- **[web-access](web-access/README.md):** provides opt-in hosted `web_fetch` and
  `web_search` across user-authorized providers (DeepSeek, Anthropic, search-only
  OpenAI / OpenAI Codex, and fetch-only Google Gemini), routing to the active
  model's provider when enabled or `defaultProvider` without cross-provider
  fallback.
- **[background](background/README.md):** replaces `bash` with a same-named
  override that supports explicit `background: true` and automatic backgrounding
  after a configurable threshold (default `120s` when no explicit `timeout` is
  set), logging up to `8MiB` of raw
  command output per job (plus truncation and lifecycle markers) and delivering
  collapsible completion notifications.
- **[subagents](subagents/README.md):** delegates tasks to child Pi CLI
  processes with fresh context, built-in `explorer` and `librarian` roles,
  configurable limits/roles, cancellation, and live bidirectional messaging
  between the root session and running children.
- **[statusline](statusline/README.md):** replaces Pi's interactive footer with
  a fixed two-line layout that renders `subagents`, `background`, and other
  extension statuses inline on line 1 above token, cache, cost, context, and
  model statistics on line 2.
- **[prompt-history](prompt-history/README.md):** records submitted interactive
  TUI prompts per `cwd` (up to `100` entries / `2 MiB` per directory, `256 KiB`
  per entry) under `<agentDir>/prompt-history/` and seeds Pi's `Up` / `Down`
  editor history on `session_start`.

## Installation and boundaries

See [Installation and Nightly Snapshots](../docs/installation.md) for checkout
and nightly tarball installation, and [AGENTS.md](../AGENTS.md#package-boundaries)
before adding or modifying a package. Create a directory only when it contains a
working capability.
