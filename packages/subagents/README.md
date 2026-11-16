# @rchardx/pi-subagents

Background task delegation for Pi. Children start with fresh conversation context,
can edit files and run commands in the shared working directory, and report back
through Pi's steering mechanism. The parent can continue independent work.

## Usage

From the repository checkout:

```bash
pi -e ./packages/subagents
# Or install persistently:
pi install ./packages/subagents
```

Ask Pi to delegate a concrete task, for example:

> Have a subagent implement config validation and run the relevant tests while
> you investigate the documentation changes.

The model calls these tools, not shell commands or slash commands:

```typescript
subagent({
  task: "Implement maxJobs validation in src/config.ts, preserve unrelated changes, add tests, and report observed test results."
})

subagent_list({})
subagent_send({ to: "<UUID | 'main' | '*'>", message: "Share an intermediate finding or answer a question." })
subagent_wait({ timeoutSeconds: 120 })

subagent_cancel({ id: "<full UUID returned by subagent>" })
```

Each launch returns a full UUID after the child has loaded and is ready to work.
Completion arrives automatically as a `subagent:result` message (with a compact,
collapsible card in the TUI) using `deliverAs: "steer"` and `triggerTurn: true`.
An idle parent is awakened; a busy parent receives the report at a supported
steering boundary, without preempting running tools. Do not poll or use sleep
loops. If nothing independent remains, end the turn and wait for the notification.

### Inspect running subagents

While children are running, Pi's status area shows `subagents: N running`. The
count updates when a child finishes startup, completes, fails, is cancelled, or
shuts down with the session. RPC clients receive the corresponding status update.

Enter `/subagents` in Pi to show a read-only snapshot of running children in
this session without starting a model turn or adding context messages:

```text
Subagents · 2 running

550e8400-e29b-41d4-a716-446655440000  running  1m12s
  Implement config validation and run tests.

6ba7b810-9dad-41d1-80b4-00c04fd430c8  running  18s
  Review documentation changes.
```

With no running children it displays `No subagents running.` Collapsed
`subagent:result` and `subagent:message` cards show a single summary line in the
TUI; expanding reveals full IDs, metadata, and sanitized body text without
changing the model-facing message.

### Live session communication

Live agents in the same root session (`"main"` and running children) can exchange
messages without polling or monitoring a dashboard:

- `subagent_list` lists live agents in the current root session, marking the
  caller as `(self)` and omitting finished or cancelled children.
- `subagent_send` delivers a message (at most 16 KiB UTF-8) to `"main"`, a live
  child UUID, or `"*"` (broadcast to a snapshot of live peers excluding the
  sender). Sender identity is stamped by the root session runtime and cannot be
  forged or cross root-session boundaries. Delivery means the recipient accepted
  the `subagent:message` entry into its steering queue (`deliverAs: "steer"`,
  `triggerTurn: true`), not that the recipient has already processed it.
- `subagent_wait` suspends the current turn until an incoming message (or, in
  `"main"`, a child completion notification) arrives, no running children remain,
  `timeoutSeconds` elapses (default `120`, maximum `300`), or the turn is aborted.
- **Terminal finality:** ending a child turn without calling `subagent_wait` and
  with no queued messages permanently completes the child and exits its process.
  Autonomously completed (or failed, timed-out, limit-reached, or cancelled)
  children never receive further messages: direct sends to finished IDs fail with
  their terminal status, broadcast snapshots skip them, and late messages racing
  final settlement are either processed before settlement or explicitly rejected
  as undelivered rather than silently dropped. A child whose run is still active,
  including a continuation requested by another extension at Pi's pre-settlement
  boundary, remains reachable. Messages accepted by a child that is then
  cancelled, times out, or hits its request limit are not processed.
- **Host queue clearing:** queued updates wait in Pi's steering queue. Clearing
  that queue (RPC `clear_queue`, or restoring queued input in the TUI) drops
  queued peer messages and completion notifications without delivering them;
  senders keep their earlier queued receipt. Pi reports the removal to no
  extension event, so dropped updates stop counting toward the queue limit and
  `subagent_wait` only at the next turn or settlement boundary where Pi's queue is
  empty. One `subagent_wait` call before that boundary can return early.

## Task and execution boundaries

- **Fresh context:** children do not see parent conversation history or later
  messages. Include relevant decisions, constraints, and expected outcomes in the
  task; reference project files the child can read itself.
- **Capable, not read-only:** children receive the selected tools, including file
  mutation and commands when enabled in the parent. A task may request a read-only
  review, but that instruction is not a separate permission sandbox.
- **Shared filesystem:** edits are immediately visible. Avoid overlapping edits.
  Failure and cancellation do not roll back changes. Worktree use, file ownership,
  and merging are task/model decisions, not extension-managed operations.
- **No recursive delegation:** ordinary children do not register `subagent` or
  `subagent_cancel`. Children are instructed not to launch agent processes.
  Arbitrary shell access is not a sandbox that prevents every possible bypass.
- **Session-bound live messaging, no resume:** live agents in the same root
  session can communicate via `subagent_list`, `subagent_send`, and
  `subagent_wait`, with peer messages framed as coordination input rather than
  higher-priority instructions. Completed children exit immediately and cannot
  receive messages or be resumed for further conversation.

## Child environment

Each child is a separate Node/Pi CLI process using the host package's `cli.js`,
with an in-memory session. The package requires a Node installation of Pi with
that CLI available; standalone binary distributions are not verified.

This is **resource reloading**, not a clone of parent tool objects or extension
state. Children load normal user/project configuration and extensions in their own
process. The parent's current project-trust decision is passed explicitly.
Explicit `-e`/`--extension` sources are forwarded unchanged for Pi to interpret,
including npm, Git, built-in, and local sources. Relative sources resolve in the
child's working directory. Active file-backed tool extensions are also loaded
unless extension discovery was explicitly disabled. Inline/SDK tools without
reloadable paths cause launch to fail rather than silently disappear.

Parent CLI restrictions are retained: `-ne`/`--no-extensions`, `--no-mcp`,
`--offline`, `-ns`/`--no-skills`, `-nc`/`--no-context-files`, and
`-xt`/`--exclude-tools`. Under `-ne`, only explicit extension sources (plus the
internal child lifecycle extension) load; tool metadata does not reopen discovery.
`--no-mcp` also overrides an explicit `-e builtin:mcp`, following Pi's behavior.
An inherited `PI_OFFLINE` remains effective. Pi's offline mode limits automatic
network activity; it is not a network sandbox for arbitrary tools.

The current provider/model and thinking level are selected explicitly. A different
resolved model or missing required tool fails startup before model execution.
The registration whitelist includes both active tools and indirectly callable
`deferred`/`codemode` tools. After registration, the child restores the parent's
active tool set before building its first prompt: indirectly callable tools remain
available without being automatically declared to the model or adding their
active-only prompt guidelines. Existing tool exclusions still apply.
Providers must be available from the child's configuration or loaded extensions.
Runtime-only provider registrations, API-key overrides, custom extension flags,
and in-memory settings mutations are not copied. Configure these through normal
Pi configuration or a reloadable extension before delegation. Required MCP tools
must be available at startup; unavailable connections cause a clear launch failure.

The child builds its own system prompt from its resources, applicable project
instructions, selected tools, and extension hooks, then receives child-specific
task guidance. The parent's rendered prompt and delegation-tool guidelines are
not copied, and parent hook output is not fed through child hooks again.
Explicit `--system-prompt` and repeated `--append-system-prompt` inputs are
forwarded in order; existing prompt files are made absolute relative to the
parent process's working directory. Prompt changes injected only through an SDK
instance or parent-local runtime state are not copied; put required constraints
in reloadable resources, explicit CLI inputs, or the task.

No parent transcript is copied. Session-local extension state is reinitialized,
not inherited. UI-dependent extensions must support headless JSON mode; this
package does not provide a child approval dialog or proxy UI back to the parent.
Pi's own extension-loading diagnostics still apply; arbitrary extension side
effects and hook failures are not made transactional by this package.

Delegation uses the configured model credentials in the child environment and
incurs additional model usage. No hosted fallback is used, credentials are not
written to package-owned files, and task text is sent through a pipe rather than
command-line arguments. Explicit CLI prompt inputs remain CLI inputs in the child:
use prompt files rather than inline arguments for sensitive instructions. No
rendered parent prompt is transmitted or persisted. No child transcript or
package-owned execution log is persisted. Individual tools and extensions can
still create files and logs.

## Lifetime, cancellation, and limits

Background execution requires interactive (`tui`) or RPC mode in the parent.
Print and JSON parents are rejected. A child itself uses headless JSON mode so
background-shell extensions do not accidentally return before their commands finish.

- After successful launch, parent turn completion or Esc does not stop the child.
- `subagent_cancel` stops the child and waits for cleanup. It accepts only IDs
  owned by the current root session and does not resume finished tasks.
- Quit, new session, resume, fork, and reload cancel the root session's children.
- Children detect parent IPC disconnection and request termination; they are not
  independent services intended to survive the parent.
- Termination sends SIGTERM and allows Pi to clean up tools/extensions, then sends
  SIGKILL to the process group after two seconds. Extensions that hang, detach
  their own processes, or ignore the host lifecycle are not fully containable.
- Explicit cancellation reports through the cancel tool without an additional
  completion wake-up. Shutdown cancellation never wakes a replacement session.

| Limit | Default |
| --- | --- |
| Concurrent children per root session | 8, including startups; excess launches fail |
| Task input | 32 KiB UTF-8, nonempty |
| Peer message input | 16 KiB UTF-8, nonempty |
| Queued unprocessed messages per recipient | 32; excess sends fail without dropping accepted mail |
| Wait timeout (`subagent_wait`) | 120 seconds default, 300 seconds maximum |
| Startup deadline | 90 seconds |
| Total execution deadline, including startup | 30 minutes (`1800` seconds) |
| Model turns | At most 64 admitted turns; recovery/compaction requests are governed by Pi |
| Final child report | 32 KiB UTF-8, explicitly marked when truncated |
| Diagnostic stderr retained per child | 4 KiB |
| Retained terminal records per session | 256; older IDs expire |

### Settings

Optional user configuration at `~/.pi/agent/subagents.json`, re-read on each
`subagent` launch. A missing file uses defaults; invalid or unreadable
configuration fails the call before starting a child.

```json
{
  "maxConcurrent": 8,
  "maxRequests": 64,
  "deadlineSeconds": 1800
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `maxConcurrent` | `8` | Maximum concurrent children in a root session, including startups. |
| `maxRequests` | `64` | Maximum admitted model turns per child execution. |
| `deadlineSeconds` | `1800` | Total child execution deadline in seconds, including startup. |

There is no hidden task queue or whole-task automatic retry. Pi may retry provider
requests according to its settings. States distinguish `completed`, `failed`,
`cancelled`, `timed_out`, and `limit_reached`; empty final answers and incomplete
responses are not successful task results. A `completed` report is not proof that
implementation or validation claims are correct. Completion delivery is attempted
once, not persisted for replay.

## Compatibility

Developed against Pi `1.5.2` with Node `>=22.19.0`. Checks, tests, package discovery,
extension loading, and representative tool execution have been verified on
**Node 22.19.0 and Node 26.13.1 with Pi 1.5.2 on Linux**. The
process-group implementation also targets macOS, but macOS is not verified.
Windows launches are rejected because process-tree cleanup is not implemented.

Automated integration tests use a local mock model endpoint, not real credentials.
They exercise actual child CLI startup, package discovery, tool execution,
file changes, extension hooks, and parent completion delivery. Real-provider
compatibility is not implied by those tests.

See [ROADMAP.md](https://github.com/rchardx/pi-packages/blob/main/packages/subagents/ROADMAP.md) in the repository for possible user-defined roles and nested spawning lifecycle. These are not current features.
