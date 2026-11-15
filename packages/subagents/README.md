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

subagent_cancel({ id: "<full UUID returned by subagent>" })
```

Each launch returns a full UUID after the child has loaded and is ready to work.
Completion arrives automatically as a `subagent:result` message using
`deliverAs: "steer"` and `triggerTurn: true`. An idle parent is awakened; a busy
parent receives the report at a supported steering boundary, without preempting
running tools. Do not poll or use sleep loops. If nothing independent remains,
end the turn and wait for the notification.

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
- **No recursive delegation:** ordinary children do not register this package's
  management tools. Children are instructed not to launch agent processes.
  Arbitrary shell access is not a sandbox that prevents every possible bypass.
- **One-shot tasks:** no mid-task messages, peer communication, broadcast, polling,
  or resuming completed children. A missing decision or authorization should be
  reported as a blocker, not waited on indefinitely.

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

| Limit | Value |
| --- | --- |
| Concurrent children per root session | 4, including startups; excess launches fail |
| Task input | 32 KiB UTF-8, nonempty |
| Startup deadline | 60 seconds |
| Total execution deadline, including startup | 30 minutes |
| Model turns | At most 64 admitted turns; recovery/compaction requests are governed by Pi |
| Final child report | 32 KiB UTF-8, explicitly marked when truncated |
| Diagnostic stderr retained per child | 4 KiB |
| Retained terminal records per session | 128; older IDs expire |

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

See [ROADMAP.md](https://github.com/rchardx/pi-packages/blob/main/packages/subagents/ROADMAP.md) in the repository for possible roles, explicit spawning
policy, and peer-to-peer/broadcast communication. These are not current features.
