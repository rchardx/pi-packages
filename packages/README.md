# Packages

Each direct child directory is an independently owned Pi package and npm
workspace. Install only the capabilities you need; the repository root is not an
installable Pi bundle.

## Available packages

| Package | Entrypoint | Surface | User config (optional) | Modes | Guide |
| --- | --- | --- | --- | --- | --- |
| `@rchardx/pi-ask` | `packages/ask/index.ts` | `ask` tool | None | `tui`, `rpc` (hidden in `print`/`json`) | [ask/README.md](ask/README.md) |
| `@rchardx/pi-web-access` | `packages/web-access/index.ts` | `web_fetch`, `web_search` tools | `~/.pi/agent/web-access.json` (required to enable tools) | `tui`, `rpc`, `print`, `json` | [web-access/README.md](web-access/README.md) |
| `@rchardx/pi-background` | `packages/background/index.ts` | `bash` tool override, `/background` | `~/.pi/agent/background.json` | Backgrounding in `tui`/`rpc`; foreground-only in `print`/`json` | [background/README.md](background/README.md) |
| `@rchardx/pi-subagents` | `packages/subagents/index.ts` | `subagent`, `subagent_cancel`, `subagent_list`, `subagent_send`, `subagent_wait`, `/subagents` | `~/.pi/agent/subagents.json` | `tui`, `rpc` on Linux/macOS | [subagents/README.md](subagents/README.md) |
| `@rchardx/pi-statusline` | `packages/statusline/index.ts` | Custom 2-line footer | None | `tui` only | [statusline/README.md](statusline/README.md) |

All user configuration paths honor `PI_CODING_AGENT_DIR` when set.

## Summaries

- **[ask](ask/README.md):** collects structured pre-execution clarification
  through 1–4 multiple-choice questions (2–5 options each, optional
  `multiSelect`, plus automatic `Other…` free-text input) with a custom TUI
  prompt and RPC dialog fallback.
- **[web-access](web-access/README.md):** provides opt-in hosted `web_fetch` and
  `web_search` across standalone tool endpoints (**Exa** and **DeepSeek**) using
  dedicated environment API keys, independent of Pi's chat-model registry and
  without cross-provider fallback.
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
  extension statuses inline on line 1 above model, context, cost, and
  token/cache statistics on line 2.

## Installation and boundaries

See [Installation and Nightly Snapshots](../docs/installation.md) for checkout
and nightly tarball installation, and [AGENTS.md](../AGENTS.md#package-boundaries)
before adding or modifying a package. Create a directory only when it contains a
working capability.
