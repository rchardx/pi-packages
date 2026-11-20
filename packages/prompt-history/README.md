# @rchardx/pi-prompt-history

Persistent per-directory interactive prompt history for Pi coding agent. Records
submitted interactive prompts while enabled and seeds Pi's `Up` / `Down` editor
history across fresh sessions, `/new`, `/reload`, and restarts in the same
working directory (`cwd`).

## What changes

Pi `1.5.2` keeps `Up` / `Down` prompt recall within a running session and
replays messages when resuming an existing session, but fresh sessions start
with an empty input history. With this package enabled:

- **Recording:** captures interactive TUI prompts (including initial interactive
  CLI prompts, steering submissions, and follow-up submissions) from Pi's
  `input` event before `/skill:name` or prompt-template expansion. For CLI
  `@file` startup arguments (such as `pi @notes.txt "summarize"`), Pi expands
  referenced text files into the initial prompt text before emitting `input`, so
  the expanded `<file>` block is recorded as part of the prompt text (subject to
  the per-entry size limit), whereas image binary data in `event.images` is not
  persisted.
- **Filtering:** ignores whitespace-only input, collapses consecutive identical
  prompts, and stores the exact text delivered to `input` (preserving multiline
  structure and internal whitespace while following Pi's submitted-text
  trimming). Built-in slash commands, extension slash commands, `!` / `!!`
  shell-mode commands, unsent drafts, extension-injected messages, ephemeral
  `--no-session` runs, and RPC/headless inputs are not recorded. Existing
  session files are never scanned or imported.
- **Recall:** seeds the session's editor history once on `session_start`
  (oldest-to-newest so `Up` recalls newest-first) and leaves runtime editing,
  multiline cursor movement, and `Down` draft restoration to Pi's native editor
  without auto-submitting recalled text. Image attachment payloads are not
  persisted or restored.

## Usage

Try for one session from the repository checkout:

```bash
pi -e ./packages/prompt-history
```

Install persistently:

```bash
pi install ./packages/prompt-history
```

For a checkout-free development snapshot, follow the
[nightly tarball installation guide](../../docs/installation.md#install-a-nightly-snapshot).
Nightlies are rolling prereleases, not npm registry publications.

No tools, slash commands, or configuration files are added.

## Storage, limits, and safety

- **Location:** `<agentDir>/prompt-history/<sha256(path.resolve(cwd))>/`
  (honoring `PI_CODING_AGENT_DIR` via `getAgentDir()`), never inside the project
  checkout. On POSIX platforms, directories use mode `0700` and immutable
  per-entry `.json` files use mode `0600`.
- **Directory keying:** `path.resolve(ctx.cwd)` keys each working directory
  lexically without `realpath` symlink merging or project-root/worktree
  grouping, and stores `cwd` inside each JSON entry for collision checking.
- **Retention limits:** keeps at most **`100` entries** and **`2 MiB`** of
  serialized UTF-8 per `cwd`, evicting whole oldest entry files first when
  exceeded. Single prompts larger than **`256 KiB`** UTF-8 are skipped with a
  warning notification rather than stored truncated.
- **Concurrency and failure degradation:** writes each submission to a fresh
  temporary file and atomically renames it to a monotonically ordered entry file
  without lockfiles, then idempotently unlinks obsolete entry files outside the
  retention window so concurrent or paused Pi processes in the same `cwd` never
  overwrite each other's completed writes. Corrupt history storage is left
  untouched and reported with a deduplicated warning; unwritable or corrupt
  storage falls back to in-session memory history without crashing Pi or
  blocking prompt submission.

## Behavior notes

- **Interactive (`tui`) mode with session persistence only.** Print, JSON, RPC,
  and ephemeral `pi --no-session` runs neither read nor write persisted prompt
  history and do not replace Pi's native in-memory editor history.
- **Custom editor composition.** On `session_start`, the extension reads
  `ctx.ui.getEditorComponent()` so an earlier extension's custom editor factory
  is preserved and seeded through `editor.addToHistory?.(entry)` without
  stacking wrappers across `/reload` or session switches. Another extension that
  runs later and replaces `setEditorComponent()` without wrapping
  `getEditorComponent()` will supersede the seeded editor instance.
- **Resumed sessions.** Enabling this package never scans or imports older
  session transcripts into persisted history on disk. Switching sessions
  in-process (`/resume`) seeds the editor from the target `cwd`'s persisted
  prompt history. On a cold-start resume (`pi -c`, `pi -r`, or `--session`), Pi
  replays the resumed session's own user messages onto the editor after
  `session_start`, so those session messages appear ahead of earlier persisted
  prompts for `Up` recall in that session without being written back to disk.

## Compatibility

Developed against Pi `1.5.2` with Node `>=22.19.0`. Verified on **Node 22.19.0
and Node 24.21.0 with Pi 1.5.2 on Linux**.
