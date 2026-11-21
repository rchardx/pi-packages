# @rchardx/pi-background

Background execution for Pi's `bash` tool with completion notifications. Long
commands stop blocking the turn: they keep running, append output to a log file,
and send Pi a message with the exit code and output tail when they finish.

## What changes

This package replaces Pi's built-in `bash` tool with a same-named override that
adds one optional parameter:

- In interactive (`tui`) and RPC modes, `background: true` returns immediately
  with a job id and log path while the command keeps running. Print and JSON
  modes support foreground execution only.
- When automatic backgrounding is enabled and no explicit `timeout` is set,
  any command still running after the threshold
  (default **120s**) moves to the background automatically instead of blocking
  the turn. The process is **not** killed.
- An explicit `timeout` keeps the built-in semantics: the process tree is
  killed at the deadline and the call fails.

Foreground commands that finish before the threshold behave exactly like the
built-in `bash` tool — this package wraps pi's own local shell backend —
including output truncation, temp files, and aborting with Esc. Foreground
commands leave no log files on disk.

When a background job finishes, Pi receives a `bash-job:notification` message
(with a compact, collapsible card in the TUI) containing the exit code, duration, an
ANSI-stripped tail of the output, and the log path, and is resumed
automatically. The raw output is at
`~/.pi/agent/bash-jobs/<sessionId>/<jobId>.log`; use `read` or `grep` on it.
Log files are created only once a command is backgrounded — foreground
commands never touch the disk. For auto-backgrounded commands, the log starts
at the threshold, seeded with up to the last 256KB of earlier output. If that
buffer overflowed, the log begins with `[pi-background] earlier output omitted`.
The seed buffer is cleared after writing and is no longer updated once the log
is open; explicit-background jobs with a log do not collect a seed.
Each log accepts at most **8MiB of raw output**, including that seed, plus
truncation markers and a lifecycle trailer. The same budget bounds pending output
writes when the disk is slow. At the limit, logging stops but the command keeps
running and its 16KB in-memory tail keeps updating. Notifications can therefore
contain recent output absent from the capped log. Notification tails normalize
CRLF and carriage-return progress updates to newlines; logs keep raw bytes.
Collapsed completion cards show the job id, status, and duration before the
command so long commands truncate first. Cards occupy one content row with one
blank row above and below. Expanding reveals the log path and output tail without
extra padding between fields. Pi retains its normal spacing between messages.

The tool description summarizes foreground and background results; the
`timeout` parameter notes that omitting it allows automatic backgrounding.
Background-only modes are reported when a call asks for them. Prompt
guidelines explain waiting for completion notifications without polling or
duplicate commands; these rules are not repeated in each result. Explicit
background starts return only the job id and log path (or a log-unavailable
notice). Automatic transitions also report
the foreground threshold and any buffered output preview. Completion messages
mention the log size limit only when it was reached.

Asking Pi to "run the tests in the background" works without special wording.

## Usage

Try for one session from the repository checkout:

```bash
pi -e ./packages/background
```

Install persistently:

```bash
pi install ./packages/background
```

For a checkout-free development snapshot, follow the
[nightly tarball installation guide](../../docs/installation.md#install-a-nightly-snapshot).
Nightlies are rolling prereleases, not npm registry publications.

### Inspect and stop running jobs

While jobs are running, Pi's status area shows `background: N running`.
The count updates on lifecycle changes and disappears when no jobs remain or the
session shuts down. RPC clients receive the corresponding status update.

Enter `/background` in Pi to show a snapshot of this session's running
background jobs:

```text
Background jobs · 2 running

bg_6f6bb444  running  1m23s
  npm run build

bg_a812c903  running  18s
  npm test
```

Each entry includes its job id, elapsed time since command startup (including
any foreground time), and full command, preserving multiple lines. Durations
use seconds, minutes/seconds, or hours/minutes; multi-day jobs keep accumulating
hours (for example, three days is `72h0m`). With no
running jobs it displays `No background jobs running.` Completed jobs are
omitted; their results remain in the existing completion notifications.

This user slash command shows a read-only snapshot of the in-memory registry
through a Pi UI notification in interactive or RPC mode, without starting a model
turn or adding model-context messages. There is no automatic refresh: enter
`/background` again for a new snapshot.

To stop one running job owned by the current session, enter:

```text
/background stop bg_6f6bb444
```

In interactive TUI mode, argument completion suggests `stop` and running
`bg_<hex>` job ids with elapsed durations and single-line command previews.
Stopping a job kills its process tree, updates the `background` status
indicator, and confirms the stop without waking the model. Missing arguments or
unknown or finished job ids report an error notification and leave running jobs
untouched.

## Settings

Optional user configuration at `~/.pi/agent/background.json`, re-read on every
command. Invalid or unreadable configuration fails the call before the command
starts; it does not silently restore defaults or enable automatic backgrounding.
A missing file uses defaults.

```json
{
  "thresholdSeconds": 120,
  "maxJobs": 16
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `thresholdSeconds` | `120` | Foreground commands running longer than this move to the background; `0` disables auto-backgrounding. Only applies without an explicit `timeout`. |
| `maxJobs` | `16` | Concurrent background jobs; starting more fails until one finishes. |

## Behavior notes

- **Esc kills foreground commands only.** Interrupting the turn kills a command
  still in its foreground window, like the built-in tool; a job that already
  moved to the background is independent of the turn and survives Esc. Aborted
  jobs never send a completion notification.
- **Print and JSON mode have no background execution.** `background: true` is
  rejected and commands never auto-background, because the session ends when
  the turn ends and would kill the job; commands block as with the built-in
  tool. RPC and interactive sessions are unaffected.
- **Session end kills jobs.** Quit, `/reload`, `/new`, resume, and fork all
  emit `session_shutdown`, which kills the session's remaining background jobs
  and appends a `killed: session ended` trailer to their logs. A subagent
  session's jobs end with the subagent's run.
- **Sensitive output of background jobs lands on disk** (log files are mode
  `0600` under `~/.pi/agent/bash-jobs/`) until pruned; redirect secrets away
  from stdout as usual. At session start, logs whose last modification was more
  than 24 hours ago are pruned across session directories. This is an age-based
  cleanup, not a liveness check: it can remove another session's log if that job
  has been silent for over 24 hours (or has stopped logging at the size cap).
  If the agent directory is not writable, jobs run without a log file and
  only the notification's output tail remains available.
- `maxJobs` caps jobs started explicitly with `background: true`. Commands
  that move to the background at the threshold are always allowed — the
  process is already running at that point, and killing it would break the
  no-kill promise. `maxJobs` is therefore not a bound on concurrent
  processes; parallel foreground commands can exceed it as well.
- **Stopping a job:** enter `/background stop <job-id>` in interactive (`tui`)
  or `rpc` mode to kill that session-owned job's process tree (`SIGKILL` on
  Unix, `taskkill /F /T` on Windows), append a `killed: stopped by user`
  trailer to its log when open, and close the log without emitting
  `bash-job:notification` or waking the model. There is no model-facing cancel
  tool; ending the session still kills all remaining jobs.
- If several background jobs are running, each completion sends its own
  notification; Pi sees them queued in order.
- The tool's `outputSchema` accepts the built-in foreground result or
  `{ job_id, log_path?, output }` for a command still running in the
  background, where `output` holds what was captured before backgrounding.
  Codemode scripts receive one of these objects.
- If another extension also replaces `bash`, the last one registered wins (Pi
  emits no warning). Do not combine this package with other `bash` overrides.

## Compatibility

With **Pi 1.6.0 on Linux**, package discovery, extension loading, foreground
commands, and background job completion, logging, and notification were
verified on **Node 22.19.0 and 26.13.1**. Process-tree cleanup also covers
macOS (process groups) and Windows (`taskkill /T`), but those platforms are
not continuously tested.
