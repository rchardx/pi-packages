# @rchardx/pi-statusline

Two-line interactive footer for Pi that renders extension statuses inline on the
path line instead of adding a third status row below token and model statistics.

## What changes

Pi's built-in footer renders extension statuses from `ctx.ui.setStatus()` on a
separate third line sorted alphabetically by key. This package replaces the
interactive footer with a fixed two-line layout:

- **Line 1:** working directory (with `~` home shortening), Git branch, optional
  session name (`• <name>`), and active extension statuses joined by ` · `:

  ```text
  ~/projects/pi-packages (main) · subagents: 2 running · background: 1 running
  ```

- **Line 2:** cumulative token, cache-hit, cost, and context-window usage on the
  left, with the active provider, model, and thinking level right-aligned on the
  right.

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

Developed and tested against Pi `1.5.2` with Node `>=22.19.0` on Linux.
