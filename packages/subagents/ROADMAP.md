# Subagents roadmap

Possible extensions to the task-delegation and live-messaging primitives. These
are directions for future discussion, not shipped features or release
commitments. See [README.md](README.md) for current behavior and limits,
including live peer-to-peer and broadcast communication.

## Role-authorized spawning and routing

Built-in `explorer` and `librarian` roles and user-defined roles in
`~/.pi/agent/subagents.json` currently configure child instructions, model,
thinking level, tools, and per-child turn/deadline limits. Project-scoped role
discovery, role/group broadcast filtering, and role-enabled child spawning
remain future discussion topics.

Ordinary children remain unable to spawn. A future role option may explicitly opt in,
including creating another instance of itself. Each child's spawn capability
would come from its own role, not automatically from its parent's capability. Do not
impose a hidden fixed depth limit or prohibit cycles behind the user's back.
Resource budgets must be explicit and separate from spawn policy; deliberately
unbounded recursion can consume unbounded resources.

## Nested execution lifecycle

When role-authorized spawning is introduced, the root session must still own all
execution, message routing, and cleanup. Add parent relationships when they are
needed for routing and cancellation, rather than storing unused graph fields in
the current runtime.

Define subtree cancellation and the behavior when a direct parent finishes before
its children. Sending results to a live ancestor is one possible policy, not a
current promise. Prevent orphaned execution and delivery into disposed sessions.

All work remains session-bound. Closing the root session ends its children and
any descendants; a detached persistent worker service is not the goal.

## Deliberate boundaries

Models and task prompts own decomposition, coordination, file ownership, and
implementation strategy. The runtime owns execution, explicit configuration,
message delivery, cancellation, and cleanup.

Do not expand this package into:

- Runtime-managed worktrees, conflicting-edit detection, merges, or rollback.
- A separate subagent sandbox or approval system based on main/sub identity.
- Mandatory monitoring panels, transcript inspection, or tracing infrastructure.
- Cross-restart recovery, durable brokers, offline mailboxes, or workers that
  survive the root session.
- A workflow DSL or harness-owned automatic task decomposition.
- Delivering messages to or resuming completed children for further conversations.

Keep the implementation small. Add configuration and lifecycle mechanisms when
those features are implemented, not placeholder registries or storage layers in
anticipation of them.
