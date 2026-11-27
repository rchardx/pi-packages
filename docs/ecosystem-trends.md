# Ecosystem Trends and Capability Radar

Self-contained radar tracking capability shifts across upstream
[Pi](https://github.com/earendil-works/pi), peer AI coding harnesses, protocols,
and model provider APIs. Its purpose is to guide `pi-packages` scope
decisions—what to introduce, refine, shrink, or retire—while upholding the
anti-parity rules in [CONTRIBUTING.md](../CONTRIBUTING.md#feature-proposal-principles).

This document owns its own [sweep workflow](#running-a-trend-sweep), tracked
sources, current assessment, and change history. It records external ecosystem
evidence and repository stances, not a roadmap or backlog; concrete proposals
belong in GitHub issues.

## Signal and stance taxonomy

Each capability domain carries one **ecosystem signal** describing external
momentum and one **repository stance** describing how `pi-packages` responds.

### Ecosystem signals

- **`Introduced`:** Newly shipped by one or two harnesses; workflow durability
  and maintenance trade-offs are not yet proven.
- **`Strengthening`:** Independently converged on or actively deepened across
  multiple harnesses to solve a recurring workflow bottleneck.
- **`Attenuating`:** Being simplified, disabled by default, or replaced by
  lighter primitives (such as plain CLI tools, skills, or subagents) due to
  context bloat, fragility, or high maintenance cost.
- **`Retired`:** Removed across peer tools or rendered obsolete as a client-side
  pattern (for example, superseded by model-native APIs or simpler primitives).

### Repository stances

- **`Maintain`:** Owned by an existing package under [`packages/`](../packages/README.md);
  keep contracts sharp and surface area minimal.
- **`Refine`:** Candidate for targeted improvement within an existing package
  when real usage hits friction.
- **`Shrink`:** Reduce configuration, surface area, or custom logic as the
  locally pinned Pi host or simpler patterns cover the need.
- **`Delegate to host`:** Covered by the locally pinned Pi host, project
  instructions / skills, or standard `bash` tools; do not build or keep
  duplicate package code (retiring any superseded package capability once the
  locally pinned Pi version absorbs and verifies it).
- **`Hold`:** Watch real-world friction before committing maintenance surface.
- **`Reject`:** Out of scope for personal local packages (for example, vendor
  cloud lock-in or heavy background indexing daemons).

## Tracked baselines

Watermarks record the last reviewed UTC cutoff timestamp
(`YYYY-MM-DDTHH:MM:SSZ`), paired with the locally pinned Pi version and
default-branch tip SHAs for release-free Git repositories so subsequent sweeps
inspect incremental deltas where available (and record review timestamps for
best-effort undated documentation).

| Layer | Canonical targets and sources | Baseline / watermark | Primary watch areas |
| --- | --- | --- | --- |
| Upstream host | [`earendil-works/pi`](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`, `pi-tui`), [`badlogic/pi-skills`](https://github.com/badlogic/pi-skills) | Pi `1.6.1`, `pi-skills@90bb51c` (`2026-11-27T14:03:42Z`) | Built-in tools, extension hooks, `prepareLoadout`, virtual models, Codemode, `tool_search`, message threads / cache warming, TUI primitives |
| Peer CLI harnesses | [`anthropics/claude-code`](https://github.com/anthropics/claude-code), [`openai/codex`](https://github.com/openai/codex), [`CognitionAI/devin-cli`](https://github.com/CognitionAI/devin-cli) (`docs.devin.ai`), [`google-gemini/gemini-cli`](https://github.com/google-gemini/gemini-cli), [`anomalyco/opencode`](https://github.com/anomalyco/opencode) | `2026-11-27T14:03:42Z` | Delegation, background execution, OS sandboxing, scheduled tasks, session branching, TUI ergonomics |
| IDE and hybrid harnesses | Cursor (`cursor.com/changelog`, IDE + CLI), Google Antigravity (`antigravity.google/docs/changelog.md`, App + `agy` CLI + SDK) | `2026-11-27T14:03:42Z` | Inner-loop clarification, model routing, worktree isolation, reactive async wakeup, swarms and scheduled routines |
| Protocols and conventions | [`agentsmd/agents.md`](https://github.com/agentsmd/agents.md), [`agentskills/agentskills`](https://github.com/agentskills/agentskills), [`modelcontextprotocol/modelcontextprotocol`](https://github.com/modelcontextprotocol/modelcontextprotocol) (AAIF), [`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol) | `agents.md@d001185`, `agentskills@83021e2` (`2026-11-27T14:03:42Z`) | Progressive context disclosure, deferred/programmatic tool calling vs. static schemas, MCP server cards, ACP session/subagent schemas |
| Model and tool provider APIs | Anthropic, OpenAI, Google Gemini, DeepSeek, Exa (`exa.ai/changelog`), and Parallel (`docs.parallel.ai`) API changelogs / release notes (plus best-effort current tool docs when undated) | `2026-11-27T14:03:42Z` | Server-side search/fetch and excerpt extraction, message threads, prompt caching, server-side compaction, tool retrieval, thinking/effort controls |

## Capability matrix

Reflects the latest synthesized assessment across tracked targets; each row maps
one capability domain to a single signal and a single stance, and the `Pi host`
column describes the repository's locally pinned Pi version. Historical
transitions appear in the [Signal log](#signal-log).

| Capability domain | Signal | Observed ecosystem trajectory | Pi host (`1.6.1`) | `pi-packages` stance |
| --- | --- | --- | --- | --- |
| Structured pre-execution clarification | `Strengthening` | Harnesses converged on structured multiple-choice user clarification prompts and terminal blocked-status reporting when an interactive UI or caller input channel is available (Claude Code, OpenCode, Cursor, Google Antigravity) | Dialog primitives (`ctx.ui` with `blockedKind`), OSC 7501 status; no built-in model tool | **`Maintain`** in [`ask`](../packages/ask/README.md) (1–4 sequential questions with automatic `Other…` in `tui`/`rpc` and OSC 7501 `question` status, hidden in headless `print`/`json` modes via `prepareLoadout`) |
| Hosted web search and page fetching | `Strengthening` | Moving from brittle local scrapers to hosted web search and targeted excerpt/highlight extraction with explicit freshness and billing boundaries (standalone tool APIs in Exa 3.0 `lite` / Dynamic Highlights, Parallel, and DeepSeek alongside provider server tools in Anthropic, OpenAI, and Google Gemini) | None built in | **`Maintain`** in [`web-access`](../packages/web-access/README.md) around deterministic standalone tool endpoints (Exa, Parallel, and DeepSeek; `objective` excerpts, `max_age_hours` cache control, domain/date filters, per-capability opt-in, no fallback; chat-model-wrapped providers removed in `#70`) |
| Async shell execution and reactive wakeup | `Strengthening` | Long-running or timed-out shell commands move off blocking foreground turns into background handles instead of being killed (OpenAI Codex CLI, Claude Code, OpenCode V2) with reactive push completion notifications that wake the agent without `sleep` polling (Google Antigravity, Claude Code) | Foreground built-in shell tools (`bash`, `powershell`) | **`Maintain`** in [`background`](../packages/background/README.md) (`bash` override with threshold auto-backgrounding, `bash_cancel`, `bash-job:notification`, and `/background`) |
| Steerable parent-child subagents | `Strengthening` | Fire-and-forget delegation evolved into addressable background child sessions with live messaging (`send`/`wait`), compact TUI transcript summaries, and multi-model parent/child pairing (Claude Code, Google Antigravity, OpenAI Codex CLI, OpenCode V2, Devin CLI `Fusion`, ACP subagent sessions) | None built in | **`Maintain`** in [`subagents`](../packages/subagents/README.md) (root-routed messaging, selective `subagent_wait({ ids })`, `/subagents`, `prepareLoadout` hiding in `print`/`json`, and explicit per-role `model`/tool configuration in `subagents.json` with no built-in role presets—not security sandboxes) |
| High-density TUI observability | `Strengthening` | Terminal harnesses surface persistent footer/status telemetry for workspace, active model, context-window usage, and session cost (Pi, Claude Code `statusLine`, OpenCode TUI) | Built-in footer (expands to a 3rd line when extension statuses are active) and `ctx.ui.setFooter` | **`Maintain`** in [`statusline`](../packages/statusline/README.md) (fixed 2-line layout placing `subagents`/`background` statuses inline on line 1 above model, context, cost, and cumulative token/cache counters; zero model tools) |
| Reusable multi-step workflow skills | `Strengthening` | Multi-turn research and iterative code-review workflows are packaged as zero-runtime-dependency `SKILL.md` playbooks orchestrating host and extension primitives rather than hardcoded extension persona logic (Pi, Claude Code, Google Antigravity, AgentSkills) | Native skill execution (`/skill:<name>` and model-invocable skills) without bundled research or cross-model review loops | **`Maintain`** in [`skills`](../packages/skills/README.md) (`deep-research` and dual-model `/skill:review-loop`, composing [`subagents`](../packages/subagents/README.md), [`web-access`](../packages/web-access/README.md), and [`ask`](../packages/ask/README.md) with zero runtime dependencies) |
| Programmatic tool composition (Codemode) | `Strengthening` | Scripted orchestration over typed tool outputs reduces multi-turn token round-trips and moves heavy or fan-out calls out of top-level tool declarations (Pi `builtin:codemode`, Anthropic multi-cloud Code Mode, OpenAI Codex CLI Code Mode, OpenCode V2 Code Mode, Google Antigravity `run_workflow`) | Native `builtin:codemode` (`outputSchema`, `structuredContent`, `models.classify()`) | **`Delegate to host`**; expose clean `outputSchema` and `structuredContent` across [`web-access`](../packages/web-access/README.md), [`background`](../packages/background/README.md), and [`subagents`](../packages/subagents/README.md) while keeping `subagent_wait` `model-only` |
| Project instructions and skill loading | `Strengthening` | Repository instructions and portable skill formats standardized under neutral open governance rather than bespoke per-harness loaders (AAIF `AGENTS.md` and `AgentSkills`, Pi, Claude Code `CLAUDE.md` and MCP-provided skills, OpenAI Codex CLI, Devin CLI, OpenCode) | Native `AGENTS.md` / `CLAUDE.md` discovery, `SKILL.md` loading, and prompt templates | **`Delegate to host`**; rely on Pi's native instruction and skill discovery rather than building custom skill loaders or machine-local persona parsers |
| Server-side session state, incremental threads, and compaction | `Strengthening` | Model APIs and harnesses shift conversation state, prefix caching, and context compaction onto server-side or non-blocking host pipelines—penalizing mid-session tool-list or prompt-prefix mutations (Anthropic Message Threads and server-side compaction, OpenAI Responses API async compaction and 12h caching, Pi message threads and idle cache warming, OpenCode V2 background compaction) | Native Anthropic message threads, `cacheWarming: "idle"`, compaction, and per-notice cache/reasoning-drop telemetry | **`Delegate to host`**; keep package prompt guidelines and tool loadouts deterministic per host mode (`prepareLoadout`) so extensions do not invalidate prompt caches, drop reasoning prefixes, or break incremental message threads |
| Editor-decoupled agent protocols (ACP and headless RPC) | `Strengthening` | CLI agents expose structured JSON-RPC / `stdio` protocols so IDEs and headless clients reuse terminal harnesses with synchronized plans, subagent trees, and compaction notices (ACP `schema-v1.35.0`—with subagent, plan, notice, and compaction schemas stabilized across `v1.25.0`–`v1.34.0`—and Zed/JetBrains ACP Registry across Gemini CLI, Google Antigravity `agy acp`, and peers; OpenCode V2 client/server mode) | Native `rpc`, `json`, and `print` modes plus SDK (`AgentSessionRuntime`, RPC extension UI dialogs, OSC 7501) | **`Delegate to host`** for editor/client transport protocols; ensure interactive packages ([`ask`](../packages/ask/README.md), [`background`](../packages/background/README.md), [`subagents`](../packages/subagents/README.md)) support both `tui` and `rpc` cleanly and degrade or hide via `prepareLoadout` in `print`/`json` |
| Stateless agentic codebase search | `Strengthening` | Terminal harnesses standardize on stateless `grep`/glob/file navigation rather than local background embedding daemons—directly in the host (Pi, OpenAI Codex CLI) or paired with host-provided exploration subagents (Claude Code, Gemini CLI `codebase_investigator`, OpenCode) | Built-in `read`, `bash`, `grep`, `find`, `ls` (no built-in subagent) | **`Delegate to host`** for search primitives (optionally paired with user-configured read-only roles in [`subagents`](../packages/subagents/README.md)); do not build local vector/RAG indexer packages |
| Conversation tree and session branching | `Strengthening` | CLI harnesses support branching or forking session transcripts—including across moved directories—to explore alternatives without losing context (Pi, Claude Code, Devin CLI, OpenCode) | Native `/tree` and session `fork` (including missing-directory fork); local session storage | **`Delegate to host`**; rely on Pi's built-in `/tree` and `fork` (and Git for file state) |
| Workspace and OS sandbox isolation | `Strengthening` | Harnesses harden directory trust gates, Git worktree isolation (`--worktree`, subagent `isolation: "worktree"`), and OS-level process/filesystem/network sandboxes (Claude Code, OpenAI Codex CLI `--trust`, Cursor CLI `privateTmp` and keyring, Gemini CLI Seatbelt) | Project trust prompt, shared working directory, and manual `git worktree` via `bash` | **`Hold`**; OS/network sandboxing belongs in the host or OS boundary rather than extension wrappers, while worktree lifecycle stays in `bash`/skill recipes unless [`subagents`](../packages/subagents/README.md) hits concrete friction without extension state |
| Per-request automatic model routing | `Strengthening` | Classifier- or orchestrator-driven routing of individual turns across fast/cheap and frontier models within one session (Cursor Router `Auto`, Gemini CLI `Auto`, Google Antigravity Neon Orchestrator, OpenAI Decisions API, Pi virtual-model hooks) | Multi-provider catalog, manual selection, decision-model classification (`ctx.modelRegistry.classify()`), and per-request routing hooks (`pi.registerVirtualModel()`) without a built-in router policy | **`Hold`** on shipping an opinionated virtual-model router package; `pi.registerVirtualModel()` supplies the host hook while explicit per-role `model` overrides in [`subagents`](../packages/subagents/README.md) cover deterministic tiering |
| Scheduled routines, autonomous goal loops, and multi-agent swarms | `Strengthening` | Harnesses add persistent `/goal` loops, cron/timer/event-triggered automations, and shared-board multi-worker swarms (Devin CLI `/goal`, Claude Code `/loop` and scheduled `/tasks`, OpenCode V2 Automations, Google Antigravity `/goal`, `/schedule`, and `/swarm`, Cursor Agent SDK triggers) | Interactive/headless single-session runs; no built-in scheduler, persistent goal loop, or shared swarm board | **`Hold`** on dedicated scheduler or swarm-board packages; watch real-world friction while bounded multi-round loops live in [`skills`](../packages/skills/README.md), fan-out delegation uses [`subagents`](../packages/subagents/README.md), and unattended schedules invoke `pi -p` via OS `cron`/`systemd` |
| Local-to-cloud session handoff | `Introduced` | Handing off an active local CLI session or bot definition to a vendor-managed cloud sandbox to continue unattended (Devin CLI `/handoff`, Cursor CLI cloud handoff and Agent SDK `deploy`) | Local sessions only | **`Reject`**; requires managed remote sandbox infrastructure outside local package scope |
| Upfront static MCP tool catalogs | `Attenuating` | Preloading large multi-server MCP schemas consumes context budget, inflates initial request tokens, and invalidates cached prompt prefixes when catalogs mutate; providers and harnesses shift to server-side tool retrieval, pre-connection server cards, lazy server startup, and Codemode (Google Gemini API Tool Retrieval, MCP `2026-07-28` + `server-card` SEP-2127, Claude Code Tool Search, OpenAI Codex CLI on-demand stdio MCP startup, Pi `tool_search`) | Native `builtin:mcp`, `builtin:tool-search` (`deferred` exposure), and `builtin:codemode` | **`Delegate to host`** for MCP connectivity; declare model tools only when model invocation is needed, keeping tool-exposing packages narrow (UI-only packages such as [`statusline`](../packages/statusline/README.md) declare zero) |
| Agent-managed LSP integration in CLI harnesses | `Strengthening` | Peers invest in optional or host-managed LSP—Claude Code supports opt-in LSP plugins, and OpenCode shipped per-filetype LSP in V1 with a V2 port tracked in [`anomalyco/opencode#38528`](https://github.com/anomalyco/opencode/issues/38528) (V2 currently advises running project CLI checks until ported)—while minimalist cores (Pi, OpenAI Codex CLI) omit built-in LSP | None built in; project CLI checks via `bash` | **`Reject`** (`@rchardx/pi-lsp` removed in `#67`); stateful language servers drift stale across `bash`, formatter, and subagent edits without full cross-platform watchers—rely on `rg` + batch CLI typecheckers (`tsc --noEmit`) |

## Running a trend sweep

This file is self-contained: no separate skill, cron workflow, or helper script
is required. Run a sweep at three natural checkpoints—when upgrading the pinned
`@earendil-works/pi-coding-agent` version, before proposing a new package or
major surface expansion, or during a periodic check-in (every 2–4 weeks, such as
alongside monthly [Dependabot](../.github/dependabot.yml) reviews)—by asking Pi in
this repository:

> Read `docs/ecosystem-trends.md` and run a trend sweep.

When executing a sweep (manually or with an agent), follow these steps in order:

1. **Fix a UTC cutoff and collect incremental deltas.** Record the sweep start
   time `T` in UTC (`YYYY-MM-DDTHH:MM:SSZ`). For each row in [Tracked baselines](#tracked-baselines):
   - *Timestamped release feeds (GitHub Releases `published_at` on `earendil-works/pi`, peer CLI harnesses, `modelcontextprotocol/modelcontextprotocol`, and `agentclientprotocol/agent-client-protocol`):*
     always inspect releases published in the half-open window `(watermark, T]`
     on every sweep, even when also performing a local Pi dependency bump. For
     repositories that also publish high-frequency `alpha`, `preview`, or
     `nightly` tags (such as `openai/codex`, `google-gemini/gemini-cli`, and
     `anomalyco/opencode`), evaluate stable releases (`prerelease: false`) as
     primary signal evidence and treat prerelease tags as early context rather
     than standalone signal transitions.
   - *Commit-tracked repositories without releases (`badlogic/pi-skills`, `agentsmd/agents.md`, `agentskills/agentskills`):*
     inspect reachable default-branch commits between the recorded commit SHA
     and the current default-branch tip (`<recorded-sha>..HEAD`, re-anchoring
     from recent history if the branch was rewritten).
   - *Local pinned Pi version upgrades (`@earendil-works/pi-coding-agent`, `pi-tui`):*
     when bumping the repository's pinned Pi version, additionally compare
     `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` sections and
     `docs/` between the previously recorded pinned Pi version and the newly
     installed version so the `Pi host` column reflects the exact pinned target.
   - *Date-only changelogs and release-note pages (sources publishing `YYYY-MM-DD` without time-of-day or timezone, such as Cursor, Google Antigravity, model providers, Exa, and Parallel):*
     inspect entries dated on or after one day before the UTC calendar day of
     `watermark` (`UTC_date(watermark) - 1 day`, or in the source's known
     timezone) to cover local-date lag west of UTC; treat web changelogs as
     best-effort against retroactive backfills rather than strict append-only
     feeds.
   - *Undated documentation pages (such as provider tool guides without chronological changelogs):*
     perform a best-effort spot check of current documentation against the
     matrix; for these targets, `T` records when current docs were last checked
     rather than guaranteeing diff-complete historical coverage.
   - *Parallel lookup discipline:* when `subagent` is active in the session, a
     user-configured lookup role can reach the required sources, and every tool
     exposed to that child is non-mutating, delegate parallel child lookups and
     use `subagent_wait` (answering child questions or continuing waits as
     needed) until every delegated lookup reaches a terminal result; otherwise
     inspect sources directly from the root session or manually.
2. **Filter noise and enforce the extension-vs-skill boundary** (discard ~90% of
   release items):
   - *Drop product noise:* UI tweaks, pricing/quotas, SaaS dashboards,
     enterprise admin controls, and routine bug fixes never enter this file.
   - *Distinguish convergence from isolated experiments:* A single harness newly
     shipping a capability stays omitted or `Introduced` unless it hits a
     concrete Pi workflow gap. Transition to `Strengthening`, `Attenuating`, or
     `Retired` only when multiple harnesses (or underlying provider APIs) move
     in the same direction. If a newer unpinned upstream Pi release adds or
     changes a capability, note it in `Observed ecosystem trajectory` (and
     `Signal log` when significant), updating `Pi host` cells and re-evaluating
     the **repository stance** (for example, toward `Shrink` or
     `Delegate to host` once covered) only after the locally pinned Pi version
     includes and verifies it—never by marking an active ecosystem capability
     `Retired`.
   - *Route workflows to skills, mechanisms to extension packages:* Propose
     `Maintain` or `Refine` for a runtime extension package only when solving a
     concrete user friction requires runtime extension mechanisms—such as host
     lifecycle hooks, TUI components, child-process control, host-enforced
     tool/loadout filtering, or model tools that enforce per-call user-consent
     configs, Pi-resolved provider credentials, and cancellation boundaries.
     Delegate `AGENTS.md` / `SKILL.md` discovery and execution to Pi
     (`Delegate to host`), maintain reusable zero-runtime-dependency multi-step
     playbooks in [`skills`](../packages/skills/README.md) (`Maintain` /
     `Refine`), and keep project-specific CLI conventions in repository
     instruction files (`Delegate to host`).
3. **Synthesize by capability theme and confirm stances.** Merge related changes
   from multiple vendors into one capability-level observation naming those
   harnesses as evidence—never write per-vendor changelogs. Keep one signal and
   one stance per [Capability matrix](#capability-matrix) row, splitting rows
   when sub-capabilities warrant different stances. In interactive sessions,
   confirm any proposed stance changes or matrix additions/removals with the
   maintainer (using `ask` when available) before editing stances.
4. **Apply the four-step atomic update and validate:**
   - Advance a row's UTC `Baseline / watermark` in [Tracked baselines](#tracked-baselines)
     to `T` (and any commit-tracked `<repo>@<sha>` markers in that row to their
     inspected default-branch tips) **only** when every target in that layer was
     inspected without failure or timeout; retain prior watermarks for any
     incomplete layer so the next sweep does not skip uninspected changes.
     Advance the recorded `Pi <version>` prefix and update the
     `Pi host (<version>)` column header and cells in
     [Capability matrix](#capability-matrix) **only** when the repository's
     locally pinned Pi version changes (never for a newer unpinned upstream
     release).
   - Update [Capability matrix](#capability-matrix) rows in place so it reflects
     current state only; merge or prune stale rows to keep the table compact.
   - Prepend a dated `### YYYY-MM-DD — <batch focus>` section to [Signal log](#signal-log)
     **only** when a signal transitions or significant evidence alters/reinforces
     a boundary. If a completed sweep finds no meaningful shift, advance only
     the verified watermarks.
   - Track follow-up code changes in GitHub issues rather than inline TODOs, then
     validate with `npm run lint:docs` and `git diff --check`.

## Signal log

Reverse-chronological record of capability transitions and their impact on
`pi-packages`.

### 2026-11-27 — Workflow skills, server-side session state, ACP, and automation boundaries

- **`Strengthening` — Zero-runtime-dependency workflow skills separated from host skill loading**
  (AAIF `AGENTS.md` and `AgentSkills` governance, Claude Code MCP-provided skills, Google Antigravity, Upstream Pi `1.6.1`):
  Repository instruction and `SKILL.md` formats consolidated under Linux
  Foundation AAIF governance while harnesses increasingly ship multi-step
  research and review playbooks as portable Markdown skills rather than custom
  extension runtimes.
  - *Impact on `pi-packages`:* Split the capability matrix into **`Delegate to host`**
    for `AGENTS.md` / `SKILL.md` discovery and **`Maintain`** in
    [`skills`](../packages/skills/README.md) (`#74`, `#80`) for `deep-research`
    and dual-model `/skill:review-loop` orchestrating [`subagents`](../packages/subagents/README.md),
    [`web-access`](../packages/web-access/README.md), and [`ask`](../packages/ask/README.md).
- **`Strengthening` — Server-side session threads, prompt-cache preservation, and background compaction**
  (Anthropic Message Threads beta and server-side compaction with `2026-10-21` client-compaction removal, OpenAI Responses API async compaction and 12-hour caching, Upstream Pi `1.5.1`–`1.6.1` message threads + `cacheWarming: "idle"` + per-notice telemetry, OpenCode V2 background compaction):
  Providers and harnesses moved multi-turn state, cache retention, and context
  compaction onto server-side or non-blocking host pipelines where mid-session
  tool-catalog or prompt-prefix mutations break byte-exact caches, drop
  reasoning prefixes (`prefix_mismatch`), or force full-history thread replays.
  - *Impact on `pi-packages`:* **`Delegate to host`**; keep package tool
    visibility and prompt guidelines deterministic per host mode via
    `prepareLoadout` (including `#79` in [`subagents`](../packages/subagents/README.md))
    and avoid client-side summarization or dynamic per-turn prompt rewriting.
- **`Strengthening` — Editor-decoupled agent protocols and multi-surface session modes**
  (ACP `schema-v1.35.0` with subagent/plan schemas stabilized in `v1.34.0` and notice/compaction schemas stabilized in `v1.25.0`, plus Zed/JetBrains ACP Registry across Gemini CLI, Google Antigravity `agy acp`, and peers; OpenCode V2 client/server mode; Upstream Pi `1.6.1` `rpc`/`json` modes and OSC 7501 `blockedKind`):
  Terminal harnesses standardized structured JSON-RPC / `stdio` transports so
  IDEs and headless hosts reuse CLI agents without bespoke editor ports.
  - *Impact on `pi-packages`:* **`Delegate to host`** for editor/client
    transport protocols; preserve dual `tui`/`rpc` support (including OSC 7501
    `blockedKind` alignment in [`ask`](../packages/ask/README.md), `#82`) and
    explicit `print`/`json` degradation across interactive packages.
- **`Strengthening` — Scheduled routines, autonomous goal loops, and shared-board swarms**
  (Devin CLI `/goal`, Claude Code `/loop` and scheduled `/tasks`, OpenCode V2 Automations, Google Antigravity `/goal`, `/schedule`, and `/swarm`, Cursor Agent SDK event/cron triggers):
  Harnesses added recurring cron/event triggers, persistent multi-turn goal
  loops, and coordinator/worker swarm boards alongside parent-child subagents.
  - *Impact on `pi-packages`:* **`Hold`** on shipping scheduler or swarm-board
    packages while watching real-world friction; express bounded convergence
    loops in [`skills`](../packages/skills/README.md), fan-out delegation in
    [`subagents`](../packages/subagents/README.md) (with selective
    `subagent_wait({ ids })` in `#77`), and unattended schedules via OS
    `cron`/`systemd` invoking `pi -p`.
- **`Strengthening` / `Attenuating` — Targeted web excerpts, auto-backgrounded timeouts, worktree sandboxes, and server-side tool retrieval**
  (Exa 3.0 `lite` and GA Dynamic Highlights, Parallel MCP 2.0 and strict `source_policy`, DeepSeek standalone search/fetch APIs; OpenCode V2 timeout auto-backgrounding and Code Mode tool offloading; Claude Code `--worktree` and subagent `isolation: "worktree"`, OpenAI Codex CLI `--trust` and on-demand stdio MCP startup; Google Gemini API Tool Retrieval and MCP SEP-2127 `server-card`):
  External APIs and peer CLIs reinforced targeted excerpt extraction over
  full-page dumps, non-destructive shell backgrounding, OS/worktree isolation,
  and lazy or server-retrieved tool schemas.
  - *Impact on `pi-packages`:* Reinforces `objective` excerpts, `max_age_hours`,
    and structured filters in [`web-access`](../packages/web-access/README.md)
    (`#73`), threshold auto-backgrounding in [`background`](../packages/background/README.md),
    **`Hold`** on host/OS sandbox wrappers, and **`Delegate to host`** for
    deferred MCP discovery and Codemode (`outputSchema` / `structuredContent`).

### 2026-11-22 — Initial baseline (Pi 1.6.0)

- **`Strengthening` — Non-blocking shell jobs, addressable subagents, and multi-model delegation**
  (Claude Code, Google Antigravity, Devin CLI `Fusion`, OpenAI Codex CLI):
  Peer harnesses moved long commands and delegated tasks off blocking
  foreground turns—combining background shell handles (OpenAI Codex CLI, Claude
  Code), reactive completion or child-message wakeups that resume the parent
  without `sleep` polling (Google Antigravity, Claude Code), and multi-model
  lead/sidekick delegation (Devin CLI `Fusion`).
  - *Impact on `pi-packages`:* Validates [`background`](../packages/background/README.md)
    auto-backgrounding + `bash-job:notification` and [`subagents`](../packages/subagents/README.md)
    bidirectional `subagent_send` / `subagent_wait`, `/subagents` controls, and
    explicit per-role `model` overrides.
- **`Strengthening` — Hosted web search and page extraction over custom scrapers**
  (DeepSeek standalone tool endpoints; Anthropic, OpenAI Responses API, and Google Gemini `url_context` server tools):
  Providers standardized first-party hosted web search and URL-fetching
  endpoints—either as direct standalone tool endpoints or model-integrated
  server tools—with explicit billing and disclosure boundaries.
  - *Impact on `pi-packages`:* Validates [`web-access`](../packages/web-access/README.md)
    using user-authorized hosted endpoints without headless browsers or silent
    fallback, while narrowing the package in `#70` to deterministic standalone
    endpoints (DeepSeek) so `web_search` and `web_fetch` avoid an extra
    chat-model generation hop that degrades code and table fidelity.
- **`Strengthening` — Structured pre-execution clarification**
  (Claude Code, Google Antigravity, Cursor, OpenCode):
  Harnesses standardized structured multiple-choice question prompts before
  irreversible or ambiguous implementation steps whenever an interactive UI or
  caller input handler is bound.
  - *Impact on `pi-packages`:* Validates maintaining [`ask`](../packages/ask/README.md)
    with a bounded 1–4 question schema and automatic `Other…` in `tui`/`rpc`,
    while hiding it via `prepareLoadout` when no interactive UI is bound
    (`print`/`json`).
- **`Strengthening` — Persistent terminal telemetry for model, context, and cost**
  (Upstream Pi `1.6.0`, Claude Code `statusLine`, OpenCode TUI):
  Terminal harnesses converged on surfacing workspace context, active model,
  context-window utilization, and session cost directly in persistent status
  surfaces so users can anticipate compaction and monitor spend.
  - *Impact on `pi-packages`:* Validates maintaining [`statusline`](../packages/statusline/README.md)
    as a zero-tool TUI footer that renders `subagents` and `background` counts
    inline on line 1 above model, context, cost, and cumulative token/cache
    counters without third-row layout shifts.
- **`Strengthening` — Programmatic orchestration and Markdown instructions/skills over static role configs**
  (Upstream Pi `1.6.0`, Claude Code, OpenAI Codex CLI, Devin CLI, OpenCode):
  Upstream Pi `1.6.0` natively provides `builtin:codemode` and `builtin:tool-search`,
  while peer harnesses converged on repository-checked Markdown instruction
  files (such as `AGENTS.md` and `CLAUDE.md`) and on-demand reusable skills
  instead of static per-machine role configurations.
  - *Impact on `pi-packages`:* Keep [`subagents`](../packages/subagents/README.md)
    free of built-in role presets (users configure model/tool roles explicitly
    in `subagents.json`, without treating tool selection as a security sandbox)
    and expose Codemode `outputSchema` (`subagent_wait` kept `model-only`);
    delegate higher-level personas (such as code reviewers) and playbooks to
    skills.
- **`Strengthening` — Stateless agentic code search in CLI harnesses**
  (Upstream Pi `1.6.0` and OpenAI Codex CLI built-in file/shell search; Claude Code, Gemini CLI `codebase_investigator`, and OpenCode exploration subagents):
  Terminal harnesses standardized on stateless `grep`/glob file navigation—either
  directly in the host or paired with host-provided exploration
  subagents—rather than bundling local background embedding daemons.
  - *Impact on `pi-packages`:* Delegate search primitives to Pi's built-in tools
    (optionally paired with user-configured read-only roles in
    [`subagents`](../packages/subagents/README.md), since Pi itself omits
    built-in subagents); do not build local vector/RAG indexer packages.
- **`Strengthening` — Per-request automatic model routing**
  (Cursor Router `Auto`, Gemini CLI `Auto` Flash/Pro routing, Upstream Pi `1.6.0` `pi.registerVirtualModel()`):
  Multiple harnesses classify individual prompts within one session across
  fast/low-cost and frontier models by task complexity rather than requiring
  manual mid-session model switches.
  - *Impact on `pi-packages`:* **`Hold`** on shipping an opinionated virtual-model
    router package; Pi `1.6.0` already supplies `pi.registerVirtualModel()`,
    while explicit per-role `model` overrides in [`subagents`](../packages/subagents/README.md)
    cover deterministic tiering.
- **`Introduced` — Local-to-cloud session handoff**
  (Devin CLI `/handoff`, Cursor CLI cloud handoff):
  Devin CLI and Cursor CLI shipped commands to hand off an active local terminal
  session to a vendor-managed cloud sandbox so long-running work can continue
  unattended.
  - *Impact on `pi-packages`:* **`Reject`**; requires managed remote sandbox
    infrastructure outside local package scope.
- **`Attenuating` — Upfront static MCP tool catalogs**
  (Claude Code MCP Tool Search / `defer_loading`, Upstream Pi `1.6.0` `deferred` exposure + `builtin:tool-search` + `builtin:codemode`):
  Preloading dozens of MCP tool schemas consumes substantial context budget,
  inflates initial input tokens, and degrades tool-selection accuracy (while
  mutating the tool catalog invalidates cached prompt prefixes), prompting
  harnesses to defer MCP schemas behind on-demand search or programmatic
  execution.
  - *Impact on `pi-packages`:* Delegate MCP connectivity and deferred discovery
    to Pi's built-in extensions, and declare model tools only when model
    invocation is required (keeping tool-exposing packages narrow and UI-only
    packages at zero tools).
- **`Strengthening` — Optional and host-managed LSP integration**
  (Claude Code opt-in LSP plugins, OpenCode V1 built-in LSP and V2 port tracked in [`anomalyco/opencode#38528`](https://github.com/anomalyco/opencode/issues/38528); omitted from Pi core and OpenAI Codex CLI):
  Peers continue investing in LSP—Claude Code exposes LSP through opt-in
  plugins, and OpenCode bundled per-filetype LSP in V1 while tracking a V2 port
  (temporarily advising direct project CLI checks until V2 LSP lands)—whereas
  minimalist cores leave language-server lifecycles out of the host.
  - *Impact on `pi-packages`:* **`Reject`** (`@rchardx/pi-lsp` removed in `#67`);
    without full cross-platform filesystem watching and open-document
    reconciliation across `bash`, formatters, and child subagents, stateful
    LSP caches go stale—rely on stateless `rg` search and batch CLI checks
    (`tsc --noEmit`).
