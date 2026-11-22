# @rchardx/pi-subagents

Background task delegation for Pi. Children start with fresh conversation context,
can edit files and run commands in the shared working directory, and report back
automatically. The parent can continue independent work.

## Usage

From the repository checkout:

```bash
pi -e ./packages/subagents
# Or install persistently:
pi install ./packages/subagents
```

For a checkout-free development snapshot, follow the
[nightly tarball installation guide](../../docs/installation.md#install-a-nightly-snapshot).
Nightlies are rolling prereleases, not npm registry publications.

Ask Pi to delegate a concrete task, for example:

> Have a subagent implement config validation and run the relevant tests while
> you investigate the documentation changes.

The model calls these tools, not shell commands or slash commands:

```typescript
subagent({
  task: "Locate maxJobs validation in src/config.ts and report its constraints with file and line references.",
  role: "explorer" // optional: built-in "explorer" / "librarian", or a custom role from subagents.json
})

subagent_list({})
subagent_send({ to: "<full UUID returned by subagent>", message: "Answer a question or correct the task." })
subagent_wait({ timeoutSeconds: 120 })
subagent_wait({ all: true, timeoutSeconds: 1800 }) // wait for every child

subagent_cancel({ id: "<full UUID returned by subagent>" })
```

Each launch returns a full UUID after the child has loaded and is ready to work.
Completion arrives automatically as a `subagent:result` message (with a compact,
collapsible card in the TUI). An idle parent is awakened; a busy parent receives
the report after its current turn, without preempting running tools. Do not poll
or use sleep loops. If nothing independent remains, end the turn and wait for the
notification. See [Delivery to the root session](#delivery-to-the-root-session)
for how hosts observe these updates.

`subagent`, `subagent_list`, `subagent_send` (root and child), and
`subagent_cancel` declare an `outputSchema` and set `structuredContent`
(`{ id, role? }`, `{ agents }` with `{ id, role?, elapsedMs, task }` where
`task` is a single-line summary up to 120 characters, `{ to }`, and
`{ id, status, report, requests, tokens }`) for Codemode scripts. Root and child
`subagent_wait` use `exposure: "model-only"` (without an `outputSchema`) because
queued messages and completion reports are delivered at turn boundaries: they
remain directly declared to the model even in `codemode.mode: "only"` and are
not callable from scripts.

### Inspect and stop running subagents

While children are running, Pi's status area shows `subagents: N running`. The
count updates when a child finishes startup, completes, fails, is cancelled, or
shuts down with the session. RPC clients receive the corresponding status update.

Enter `/subagents` in Pi to show a read-only snapshot of running children in
this session without starting a model turn or adding context messages:

```text
Subagents · 2 running

550e8400-e29b-41d4-a716-446655440000  running  1m12s
  Implement config validation and run tests.

6ba7b810-9dad-41d1-80b4-00c04fd430c8  explorer  running  18s
  Review documentation changes.
```

With no running children it displays `No subagents running.` Tool calls
(`subagent`, `subagent_send`, `subagent_list`, `subagent_wait`, and
`subagent_cancel`) and incoming `subagent:result` / `subagent:message` cards
render compact lowercase summaries when collapsed; expanding reveals full IDs,
metadata, and sanitized Markdown task, message, or report bodies without
changing model-facing messages.

To stop one running child owned by the current session, enter:

```text
/subagents stop 550e8400-e29b-41d4-a716-446655440000
```

In interactive TUI mode, argument completion suggests `stop` and running full
UUIDs with optional role, elapsed duration, and a single-line task preview.
Stopping a child terminates its process group, records `cancelled` status in
this session, updates the `subagents` status indicator, and confirms the stop
without emitting `subagent:result` or waking an idle parent (an active
`subagent_wait` resolves cleanly once no running children remain). Missing
arguments or unknown or finished IDs report an error notification and leave
running children untouched.

### Live session communication

The root session (`"main"`) and each running child can exchange messages without
polling or monitoring a dashboard. Children cannot message one another, and no
message is broadcast: the root session is the only route between them.

In the root session:

- `subagent_list` lists the running children with their role, elapsed time, and
  a one-line task summary. Finished or cancelled children are omitted.
- `subagent_send` delivers a message (at most 16 KiB UTF-8) to one running child
  by UUID. The child treats it as a supplement or correction to its task.
- `subagent_wait` suspends the current turn until a child message or completion
  notification arrives, no running children remain, `timeoutSeconds` elapses
  (default `120`, maximum `3600`), or the turn is aborted. With `all: true`,
  completions are held until every child has finished and are then handed over
  together; a message from a child still ends the wait, because that child may
  need an answer. When such a wait times out, the result reports how many
  children are still running.

In a child:

- `subagent_send` takes only a `message` and delivers it to the root session.
  The runtime stamps the sender, so it cannot be forged.
- `subagent_wait` suspends the turn until a message from the root session
  arrives, `timeoutSeconds` elapses (default `120`, maximum `300`), or the turn
  is aborted.
- `subagent_list` is not available.

Delivery means the recipient accepted the `subagent:message` for its next turn,
not that the recipient has already processed it.

**Terminal finality:** ending a child turn without calling `subagent_wait` and
with no queued messages permanently completes the child and exits its process.
Autonomously completed (or failed, timed-out, limit-reached, or cancelled)
children never receive further messages: sends to finished IDs fail with their
terminal status, and late messages racing final settlement are either processed
before settlement or explicitly rejected as undelivered rather than silently
dropped. A child whose run is still active, including a continuation requested
by another extension at Pi's pre-settlement boundary, remains reachable.
Messages accepted by a child that is then cancelled, times out, or hits its
request limit are not processed.

### Delivery to the root session

Completion reports and child messages for `"main"` stay in the extension until Pi
can take them; they never wait in Pi's steering queue. Clearing that queue (RPC
`clear_queue`, or restoring queued input in the TUI) therefore does not drop
them, and the 32-message limit counts exactly the child messages not yet handed
over.

- **Busy root:** updates are appended as session entries when the current turn
  ends and the run continues with them. RPC and JSON hosts observe an
  `entry_appended` event whose entry has `type: "custom_message"`.
- **Idle root:** the oldest update starts a run, requested once even when Pi
  defers the start until its `agent_settled` handlers finish. Hosts observe the
  update as a custom `message_start` / `message_end`. One further pending update
  joins any starting run as an extra starting message; the rest follow at that
  run's first turn boundary.
- **Aborted run:** updates pending when a run is aborted are recorded in the
  session without starting another run. The model sees them on its next turn.
- **Compaction or branch summary on an idle root:** an update arriving meanwhile
  is delivered with the next run or the next update, because Pi signals the end
  of that work to no extension event.
- Another extension that replaces the entry list at the same boundary instead of
  extending it removes these updates. Handoff is attempted once.

Children run headless, where nothing clears the steering queue, so messages for
a child are steered into its active run and processed before it settles.

## Task and execution boundaries

- **Fresh context:** children do not see parent conversation history or later
  messages. Include relevant decisions, constraints, and expected outcomes in the
  task; reference project files the child can read itself.
- **Capable unless narrowed by role:** by default, children receive the parent's
  selected tools, including file mutation and commands when enabled in the parent.
  A configured `role` can restrict tools (for example, `["read", "grep", "find", "ls"]`
  or `[]`), whereas a task prompt alone is not a separate permission sandbox.
- **Shared filesystem:** edits are immediately visible. Avoid overlapping edits.
  Failure and cancellation do not roll back changes. Worktree use, file ownership,
  and merging are task/model decisions, not extension-managed operations.
- **No recursive delegation:** ordinary children do not register `subagent` or
  `subagent_cancel`. Children are instructed not to launch agent processes.
  Arbitrary shell access is not a sandbox that prevents every possible bypass.
- **Session-bound live messaging, no resume:** the root session and its running
  children communicate via `subagent_send` and `subagent_wait`. A child treats a
  message from the root session as a supplement or correction to its task; the
  root session treats child messages and reports as agent outputs, not user
  instructions. Completed children exit immediately and cannot receive messages
  or be resumed for further conversation.

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

The current provider/model and thinking level are selected explicitly unless
overridden by a configured `role`. When a role overrides `provider` and `model`
without setting `thinking`, Pi resolves the configured thinking level for that
model. A different resolved model, missing provider authentication, or missing
required tool fails startup before model execution.
By default, the registration whitelist includes both active tools and indirectly
callable `deferred`/`codemode` tools; after registration, the child restores the
selected active tool set before building its first prompt so indirectly callable
tools remain available without being automatically declared to the model or
adding their active-only prompt guidelines. A role's `tools` list can either
replace the selection with exact tool names (including inactive built-in tools
available in the parent such as `grep`, `find`, and `ls`, or `[]` for no tools)
or modify the inherited selection with `+name` and `-name` entries. Parent CLI
restrictions and tool exclusions still apply; roles cannot enable tools blocked
in the parent or enable `subagent` / `subagent_cancel`.
Providers must be available from the child's configuration or loaded extensions.
Runtime-only provider registrations, API-key overrides, custom extension flags,
and in-memory settings mutations are not copied. Configure these through normal
Pi configuration or a reloadable extension before delegation.

Tools from Pi's built-in MCP support are not required at startup: when a child's
selected tools include neither MCP tools nor tools that reach other tools (such
as `explorer`, `tools: []`, or when the parent has no reachable MCP tools), it
starts with `--no-mcp` and does not connect MCP servers; otherwise each child
connects its own MCP servers and registers their tools as they connect (when the
selection includes MCP tools from the parent, only those MCP tools remain
reachable). A server that cannot connect in the child surfaces as a failed tool
call, not as a launch failure. See
[Pi's MCP documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)
for when Pi waits for a server. Tools that other extensions register
asynchronously are still required at startup.

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
- `subagent_cancel` and `/subagents stop <id>` stop a child owned by the current
  root session and wait for cleanup; `/subagents stop <id>` requires a currently
  running UUID, whereas `subagent_cancel` also returns retained terminal records.
  Neither resumes finished tasks or reverts file changes.
- Quit, new session, resume, fork, and reload cancel the root session's children.
- Children detect parent IPC disconnection and request termination; they are not
  independent services intended to survive the parent.
- Termination sends SIGTERM and allows Pi to clean up tools/extensions, then sends
  SIGKILL to the process group after two seconds. Extensions that hang, detach
  their own processes, or ignore the host lifecycle are not fully containable.
- Explicit cancellation (`subagent_cancel` or `/subagents stop <id>`) never
  emits a `subagent:result` wake-up. Shutdown cancellation never wakes a
  replacement session.

| Limit | Default |
| --- | --- |
| Concurrent children per root session | 8, including startups; excess launches fail |
| Task input | 32 KiB UTF-8, nonempty |
| Role description | 512 bytes UTF-8, single-line nonempty when set |
| Role instructions | 16 KiB UTF-8, nonempty when set |
| Message input | 16 KiB UTF-8, nonempty |
| Queued unprocessed messages per recipient | 32; excess sends fail without dropping accepted mail |
| Wait timeout (`subagent_wait`) | 120 seconds default; 3600 seconds maximum in the root session, 300 in a child |
| Startup deadline | 90 seconds |
| Total execution deadline, including startup | 30 minutes (`1800` seconds) |
| Model turns | At most 64 admitted turns; recovery/compaction requests are governed by Pi |
| Final child report | 32 KiB UTF-8, explicitly marked when truncated |
| Diagnostic stderr retained per child | 4 KiB |
| Retained terminal records per session | 256; older IDs expire |

### Roles and settings

Two built-in roles are available by default without creating a configuration
file:

- `explorer` — local codebase search and navigation with `["read", "grep", "find", "ls"]`.
- `librarian` — find documentation and reference material and cite sources. Uses
  `["+grep", "+find", "+ls", "-edit", "-write", "-bash", "-powershell"]`, keeping
  enabled web, MCP, and messaging tools while removing local edit and shell tools.

Neither role overrides the parent's model or thinking level by default. Omit
`role` for tasks that require writing code or running experiments. The librarian's
tool selection is not a read-only sandbox for retained MCP or custom tools.

Optional user configuration at `~/.pi/agent/subagents.json` is re-read on each
`subagent` launch (and before parent runs to advertise active roles in a
`<subagent_roles>` system-prompt section while `subagent` is active). A missing
file uses defaults; invalid or unreadable configuration fails the `subagent`
call before starting a child.

```json
{
  "maxConcurrent": 8,
  "maxRequests": 64,
  "deadlineSeconds": 1800,
  "roles": {
    "explorer": {
      "provider": "anthropic",
      "model": "claude-haiku-4-5",
      "thinking": "low"
    },
    "librarian": {
      "maxRequests": 16,
      "deadlineSeconds": 300
    }
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `maxConcurrent` | `8` | Maximum concurrent children in a root session, including startups. |
| `maxRequests` | `64` | Maximum admitted model turns per child execution. |
| `deadlineSeconds` | `1800` | Total child execution deadline in seconds, including startup. |
| `roles` | `explorer`, `librarian` | Role presets merged over the built-in roles; set a role to `false` to disable it. |

Role names use 1–64 ASCII letters, digits, hyphens, or underscores starting with
a letter or digit. Partial overrides on `explorer` or `librarian` retain their
other built-in fields; set `"explorer": false` or `"librarian": false` to
disable a built-in role. Unknown or empty `role` arguments fail before launch.
Each role object supports:

| Role field | Meaning |
| --- | --- |
| `description` | Optional single-line summary (at most 512 bytes) shown to the parent model. |
| `provider`, `model` | Optional model override; must be specified together and have configured Pi authentication. |
| `thinking` | Optional thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). |
| `tools` | Optional tool list following Pi's `--tools` rules: plain names replace the selection (`[]` disables all tools; omit `subagent_send`/`subagent_wait` if messaging the root session is unwanted, or include them explicitly), whereas `+name`/`-name` entries modify the inherited selection in order. Plain names and modifiers cannot be mixed; `*` patterns and the root-session tools `subagent`/`subagent_cancel`/`subagent_list` are rejected. |
| `instructions` | Optional role instructions (at most 16 KiB UTF-8) appended to the child's system prompt separately from `task`. |
| `maxRequests` | Optional per-child model-turn limit overriding top-level `maxRequests`. |
| `deadlineSeconds` | Optional per-child execution deadline overriding top-level `deadlineSeconds`. |

There is no hidden task queue or whole-task automatic retry. Pi may retry provider
requests according to its settings. States distinguish `completed`, `failed`,
`cancelled`, `timed_out`, and `limit_reached`; empty final answers and incomplete
responses are not successful task results. Incomplete runs retain accumulated
request/token counts and append bounded in-memory partial progress (the latest
nonempty assistant message and recent tool activity) when available. A `completed`
report is not proof that implementation or validation claims are correct.
Completion delivery is attempted once, not persisted for replay.

## Compatibility

Developed against Pi `1.6.0` with Node `>=22.19.0`. Package discovery, extension
loading, and tool execution (including print-mode rejection) have been verified
on **Node 22.19.0 and Node 26.13.1 with Pi 1.6.0 on Linux**. The
process-group implementation also targets macOS, but macOS is not verified.
Windows launches are rejected because process-tree cleanup is not implemented.

Automated integration tests use a local mock model endpoint, not real credentials.
They exercise actual child CLI startup, package discovery, tool execution,
file changes, extension hooks, and parent completion delivery. Real-provider
compatibility is not implied by those tests.
