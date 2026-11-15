# Subagents roadmap

Possible extensions to the task-delegation primitive. These are directions for
future discussion, not shipped features or release commitments. See
[README.md](README.md) for current behavior and limits.

## User-defined roles

Allow a role to select instructions, model, tools, and whether it can spawn agents.
A solver specialist is one example. A possible call is
`subagent({ role: "solver", task })`; the configuration format, discovery paths,
and precedence remain undecided.

Keep role instructions, per-task input, and execution configuration distinct.
Roles select capabilities; main/sub identity does not introduce a separate
permission or approval system. Applicable host restrictions still apply.

Ordinary children remain unable to spawn. A custom role may explicitly opt in,
including creating another instance of itself. Each child's spawn capability
comes from its own role, not automatically from its parent's capability. Do not
impose a hidden fixed depth limit or prohibit cycles behind the user's back.
Resource budgets must be explicit and separate from spawn policy; deliberately
unbounded recursion can consume unbounded resources.

## Peer-to-peer and broadcast communication

Allow live agents in the same root session to communicate: main-to-child,
child-to-main, and sibling-to-sibling. Support direct addressing and broadcast,
without requiring users to monitor a dashboard.

Use canonical agent UUIDs and runtime-assigned sender identity. An address is not
permission to cross root-session boundaries. Prefer Pi-native steering and wake-up
semantics; peer messages must not become higher-priority instructions.

Decisions to make when implementing communication:

- How agents discover peers, their roles, and whether they are still available.
- Broadcast recipients and timing: a snapshot of live peers excluding the sender
  is a candidate default. Role/group filtering can be considered separately.
- Ordering, queue bounds, fan-out limits, and partial delivery when recipients exit.
- How to distinguish accepted delivery from a recipient actually processing it.
- How an agent waits for a reply without polling or prematurely completing its task.
  A settled model run and a completed task need not mean the same thing.
- Whether queued messages must be processed before terminal teardown.

Do not automatically rebroadcast messages. Durable brokers, offline mailboxes,
and reopening completed conversations are not required by this direction.

## Nested execution lifecycle

When role-authorized spawning is introduced, the root session must still own all
execution and cleanup. Add parent relationships when they are needed for routing
and cancellation, rather than storing unused graph fields in the current runtime.

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
- Cross-restart recovery or workers that survive the root session.
- A workflow DSL or harness-owned automatic task decomposition.
- Resuming completed children for further conversations.

Keep the implementation small. Add configuration and communication mechanisms
when those features are implemented, not placeholder registries, buses, or storage
layers in anticipation of them.
