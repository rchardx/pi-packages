# @rchardx/pi-statusline

Two-line interactive footer for Pi that renders extension statuses inline on the
path line instead of adding a third status row below token and model statistics.

## What changes

Pi's built-in footer renders extension statuses from `ctx.ui.setStatus()` on a
separate third line sorted alphabetically by key. This package replaces the
interactive footer with a fixed two-line layout:

- **Line 1:** working directory (with `~` home shortening), Git branch, optional
  session name (`• <name>`), and active extension statuses joined by ` · `.
  When terminal width is constrained, active statuses are preserved first by
  truncating the location prefix with `...` (or omitting it when no room remains
  for a shortened prefix).
- **Line 2:** left-aligned segments joined by ` · ` in priority order — active
  model, thinking level, and multi-provider suffix (`(<provider>)`), followed by
  context-window usage, cost/subscription status, and cumulative token/cache
  counters — right-truncated with `...` when narrow so active model details and
  context usage precede cost and cumulative token/cache counters.

```text
~/projects/pi-packages (main) · subagents: 2 running · background: 1 running
claude-opus-4-6 • high (anthropic) · 9.9%/1.0M (auto) · $0.809 · ↑208k ↓25k R1.4M CH97.4%
```

Extension statuses are ordered with `subagents` first, `background` second, and
any remaining extension keys sorted alphabetically. Empty or whitespace-only
statuses are omitted; when no extension status is active, line 1 shows only the
path, branch, and optional session name.

## Usage

Try for one session from the repository checkout:

```bash
pi -e ./packages/statusline
```

Install persistently:

```bash
pi install ./packages/statusline
```

For a checkout-free development snapshot, follow the
[nightly tarball installation guide](../../docs/installation.md#install-a-nightly-snapshot).
Nightlies are rolling prereleases, not npm registry publications.

Combine with `@rchardx/pi-subagents` and `@rchardx/pi-background` so their
running counts appear inline on line 1 without shifting the layout when work
starts or finishes.

## Behavior notes

- **Interactive (`tui`) mode only.** Print, JSON, and RPC sessions do not install
  a custom footer; RPC clients continue receiving raw `setStatus` updates through
  Pi's extension UI protocol.
- **Single footer owner.** Pi allows one custom footer at a time (`ctx.ui.setFooter`).
  Do not combine this package with another extension that replaces the footer.
- **Public host data.** Line 2 computes token, cache, cost, context, subscription,
  and model state from Pi's public session, settings, and model-registry APIs.
  Host-internal fields not exposed to extensions (such as active virtual-model
  routing targets) are not displayed.

## Compatibility

Developed against Pi `1.6.0` with Node `>=22.19.0`. Verified on Linux with
Pi `1.6.0` on Node `22.19.0` and `26.13.1`: Pi discovered and loaded the
package, and its interactive CLI (PTY) rendered an extension status inline on
the path line.
