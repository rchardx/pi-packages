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
| Upstream host | [`earendil-works/pi`](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`, `pi-tui`), [`badlogic/pi-skills`](https://github.com/badlogic/pi-skills) | Pi `1.6.0`, `pi-skills@90bb51c` (`2026-11-22T12:00:00Z`) | Built-in tools, extension hooks, `prepareLoadout`, virtual models, Codemode, `tool_search`, TUI primitives |
| Peer CLI harnesses | [`anthropics/claude-code`](https://github.com/anthropics/claude-code), [`openai/codex`](https://github.com/openai/codex), [`CognitionAI/devin-cli`](https://github.com/CognitionAI/devin-cli) (`docs.devin.ai`), [`google-gemini/gemini-cli`](https://github.com/google-gemini/gemini-cli), [`anomalyco/opencode`](https://github.com/anomalyco/opencode) | `2026-11-22T12:00:00Z` | Delegation, background execution, OS sandboxing, session branching, TUI ergonomics |
| IDE and hybrid harnesses | Cursor (`cursor.com/changelog`, IDE + CLI), Google Antigravity (current docs; best-effort) | `2026-11-22T12:00:00Z` | Inner-loop clarification, model routing, worktree isolation, reactive async wakeup |
| Protocols and conventions | [`agentsmd/agents.md`](https://github.com/agentsmd/agents.md), [`agentskills/agentskills`](https://github.com/agentskills/agentskills), [`modelcontextprotocol/modelcontextprotocol`](https://github.com/modelcontextprotocol/modelcontextprotocol), [`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol) | `agents.md@d001185`, `agentskills@83021e2` (`2026-11-22T12:00:00Z`) | Progressive context disclosure, deferred/programmatic tool calling vs. static schemas |
| Model provider APIs | Anthropic, OpenAI, Google Gemini, and DeepSeek API changelogs / release notes (plus best-effort current tool docs when undated) | `2026-11-22T12:00:00Z` | Server-side search/fetch, prompt caching, context compaction, thinking/effort controls |

## Capability matrix

Reflects the latest synthesized assessment across tracked targets; each row maps
one capability domain to a single signal and a single stance, and the `Pi host`
column describes the repository's locally pinned Pi version. Historical
transitions appear in the [Signal log](#signal-log).

| Capability domain | Signal | Observed ecosystem trajectory | Pi host (`1.6.0`) | `pi-packages` stance |
| --- | --- | --- | --- | --- |
| Structured pre-execution clarification | `Strengthening` | Harnesses converged on structured multiple-choice user clarification prompts when an interactive UI or caller input channel is available (Claude Code, OpenCode, Cursor, Google Antigravity) | Dialog primitives (`ctx.ui`), OSC 7501 status; no built-in model tool | **`Maintain`** in [`ask`](../packages/ask/README.md) (1–4 sequential questions with automatic `Other…` in `tui`/`rpc`, hidden in headless `print`/`json` modes via `prepareLoadout`) |
| Hosted web search and page fetching | `Strengthening` | Moving from brittle local scrapers to hosted web search and page-extraction endpoints (standalone tool APIs such as DeepSeek alongside provider server tools in Anthropic, OpenAI, and Google Gemini) with explicit billing/disclosure boundaries | None built in | **`Maintain`** in [`web-access`](../packages/web-access/README.md) around deterministic standalone tool endpoints (DeepSeek, per-capability opt-in, no fallback; chat-model-wrapped providers removed in `#70`) |
| Async shell execution and reactive wakeup | `Strengthening` | Long-running shell commands moved off blocking foreground turns via background session handles (OpenAI Codex CLI, Claude Code) and reactive push completion notifications that wake the agent without `sleep` polling (Google Antigravity, Claude Code) | Foreground built-in shell tools (`bash`, `powershell`) | **`Maintain`** in [`background`](../packages/background/README.md) (`bash` override + `/background`) |
| Steerable parent-child subagents | `Strengthening` | Fire-and-forget delegation evolving into addressable child sessions with live messaging (`send`/`wait`), multi-model parent/child pairing (Devin CLI `Fusion`), and default tool-selection presets (Claude Code, Google Antigravity, OpenAI Codex CLI) | None built in | **`Maintain`** in [`subagents`](../packages/subagents/README.md) (root-routed messaging, `/subagents`, explicit per-role `model`/tool configuration in `subagents.json` with no built-in role presets—not security sandboxes; leave workflow personas such as `reviewer` to skills) |
| High-density TUI observability | `Strengthening` | Terminal harnesses surface persistent footer/status telemetry for workspace, active model, context-window usage, and session cost (Pi, Claude Code `statusLine`, OpenCode TUI) | Built-in footer (expands to a 3rd line when extension statuses are active) and `ctx.ui.setFooter` | **`Maintain`** in [`statusline`](../packages/statusline/README.md) (fixed 2-line layout placing `subagents`/`background` statuses inline on line 1 above model, context, cost, and cumulative token/cache counters; zero model tools) |
| Programmatic tool composition (Codemode) | `Strengthening` | Scripted orchestration over typed tool outputs reduces multi-turn token round-trips for fan-out work (Pi `builtin:codemode`, Anthropic programmatic tool calling) | Native `builtin:codemode` (`outputSchema`, `structuredContent`) | **`Delegate to host`**; expose clean `outputSchema` in [`subagents`](../packages/subagents/README.md) while keeping `subagent_wait` `model-only` |
| Project instructions and reusable skills | `Strengthening` | Reusable workflows standardized around repository-checked Markdown instruction files and on-demand skills rather than bespoke extensions or machine-local JSON configs (Pi, Claude Code, OpenAI Codex CLI, Devin CLI, OpenCode) | Native `AGENTS.md` / `CLAUDE.md` discovery, skills (`SKILL.md`), and prompt templates | **`Delegate to host`**; express workflow personas, review rubrics, and recipes as skills rather than extension config |
| Stateless agentic codebase search | `Strengthening` | Terminal harnesses standardize on stateless `grep`/glob/file navigation rather than local background embedding daemons—directly in the host (Pi, OpenAI Codex CLI) or paired with host-provided exploration subagents (Claude Code, Gemini CLI `codebase_investigator`, OpenCode) | Built-in `read`, `bash`, `grep`, `find`, `ls` (no built-in subagent) | **`Delegate to host`** for search primitives (optionally paired with user-configured read-only roles in [`subagents`](../packages/subagents/README.md)); do not build local vector/RAG indexer packages |
| Workspace and OS sandbox isolation | `Strengthening` | Parallel agents increasingly pair Git worktrees with OS-level process/filesystem sandboxes and network gates (OpenAI Codex CLI, Claude Code, Cursor) | Shared working directory; manual `git worktree` via `bash` | **`Hold`**; prefer `bash`/skill recipes unless worktree or sandbox lifecycle proves impossible without extension state |
| Per-request automatic model routing | `Strengthening` | Classifier- or heuristic-driven routing of individual requests within one session across fast/cheap and frontier models (Cursor Router `Auto`, Gemini CLI `Auto` Flash/Pro routing, Pi virtual-model hooks) | Multi-provider catalog, manual selection, and per-request routing hooks (`pi.registerVirtualModel()`) without a built-in router policy | **`Hold`** on shipping an opinionated virtual-model router package; `pi.registerVirtualModel()` supplies the host hook while explicit per-role `model` overrides in [`subagents`](../packages/subagents/README.md) cover deterministic tiering |
| Conversation tree and session branching | `Strengthening` | CLI harnesses support branching or forking session transcripts to explore alternatives without losing context (Pi, Claude Code, Devin CLI, OpenCode) | Native `/tree` and session `fork`; local session storage | **`Delegate to host`**; rely on Pi's built-in `/tree` and `fork` (and Git for file state) |
| Local-to-cloud session handoff | `Introduced` | Handing off an active local CLI session to a remote cloud sandbox to continue unattended (Devin CLI `/handoff`, Cursor CLI cloud handoff) | Local sessions only | **`Reject`**; requires managed remote sandbox infrastructure outside local package scope |
| Upfront static MCP tool catalogs | `Attenuating` | Preloading large multi-server MCP schemas consumes context budget, inflates initial request tokens, and degrades tool selection, while catalog mutations invalidate cached prompt prefixes; harnesses are shifting to deferred discovery (Claude Code Tool Search, Pi `tool_search`) and Codemode | Native `builtin:mcp`, `builtin:tool-search` (`deferred` exposure), and `builtin:codemode` | **`Delegate to host`** for MCP connectivity; declare model tools only when model invocation is needed, keeping tool-exposing packages narrow (UI-only packages such as [`statusline`](../packages/statusline/README.md) declare zero) |
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
     on every sweep, even when also performing a local Pi dependency bump.
   - *Commit-tracked repositories without releases (`badlogic/pi-skills`, `agentsmd/agents.md`, `agentskills/agentskills`):*
     inspect reachable default-branch commits between the recorded commit SHA
     and the current default-branch tip (`<recorded-sha>..HEAD`, re-anchoring
     from recent history if the branch was rewritten).
   - *Local pinned Pi version upgrades (`@earendil-works/pi-coding-agent`, `pi-tui`):*
     when bumping the repository's pinned Pi version, additionally compare
     `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` sections and
     `docs/` between the previously recorded pinned Pi version and the newly
     installed version so the `Pi host` column reflects the exact pinned target.
   - *Date-only changelogs and release-note pages (sources publishing `YYYY-MM-DD` without time-of-day or timezone):*
     inspect entries dated on or after one day before the UTC calendar day of
     `watermark` (`UTC_date(watermark) - 1 day`, or in the source's known
     timezone) to cover local-date lag west of UTC; treat web changelogs as
     best-effort against retroactive backfills rather than strict append-only
     feeds.
   - *Undated documentation pages (such as Google Antigravity or provider guides without chronological changelogs):*
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
   - *Route workflows to skills, mechanisms to packages:* Propose `Maintain` or
     `Refine` in `pi-packages` only when solving a concrete user friction
     requires runtime extension mechanisms—such as host lifecycle hooks, TUI
     components, child-process control, host-enforced tool/loadout filtering, or
     model tools that enforce per-call user-consent configs, Pi-resolved
     provider credentials, and cancellation boundaries. Role personas,
     multi-step prompts, and CLI conventions belong in skills or project
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
