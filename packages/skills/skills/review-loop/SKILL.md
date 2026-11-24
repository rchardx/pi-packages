---
name: review-loop
description: Run a multi-round cross-model code review loop with parallel reviewer_a and reviewer_b subagents, fixing real defects, rebutting false positives or over-defensive suggestions with code evidence, and re-verifying until both reviewers return CLEAR.
disable-model-invocation: true
---

# Review Loop

Drive code changes to merge-ready quality through parallel, heterogeneous blind
reviews (`reviewer_a` and `reviewer_b`), evidence-based triage, and focused
re-verification until both reviewers return `CLEAR`.

Invoking `/skill:review-loop` runs **closed-loop convergence** by default
(verify, fix, rebut, checkpoint, and re-verify). Switch to a single
**read-only** review pass only when the user asks not to modify files or Git
state.

Requires an interactive (`tui`) or `rpc` session with `@rchardx/pi-subagents`
active and `reviewer_a` / `reviewer_b` bound to distinct models in
`subagents.json`. Use `ask` when available (or a concise direct question
otherwise) to escalate genuine design or scope trade-offs.

## Core philosophy

- **Clean checkpoints before every review:** Anchor against an explicit
  `BASE_SHA` and review a clean committed `HEAD` rather than loose in-scope
  edits—commit locally for local branches, and commit plus push when iterating
  on a remote branch or PR (confirming once first if repository rules prohibit
  commits/pushes without explicit approval beyond the command). Clean
  checkpoints keep `git diff`, `git archive`, new files, and PR views aligned.
- **Independent blind judgment:** Give both reviewers the exact same objective
  context—problem statement, `BASE_SHA..HEAD` scope, and project rule files
  (`AGENTS.md`, `CONTRIBUTING.md`). Withhold your own design rationale or
  justifications so neither model is anchored.
- **Consequential defects over noise:** Target broken behavior, contract or doc
  drift, concurrency/lifecycle/cleanup races, missing validation at real
  untrusted boundaries, security flaws, and weak tests. Trust static types and
  documented host contracts; reject redundant runtime guards, speculative
  abstractions, error-swallowing wrappers, and stylistic nits.
- **Flexible reviewers, preserved checkout:** Reviewers retain full investigative
  capability (including running fast targeted checks and `/tmp` reproductions),
  guided by natural-language rules never to mutate the checkout or Git state and
  verified by comparing `git status --porcelain` before and after each round.
  Avoid running slow full-repository suites inside a reviewer when targeted
  tests suffice.
- **Evidence over deference:** Inspect every finding in source yourself. Fix
  real defects and test gaps directly; rebut false positives or over-defensive
  advice with concrete code, type, or contract citations rather than degrading
  the codebase; escalate genuine API or architectural trade-offs to the user.

## The loop

### 1. Anchor base and checkpoint state

Confirm subagent delegation is available before making changes. Pin one fixed
comparison commit `BASE_SHA` (`git merge-base <target> HEAD`; if starting from
uncommitted edits directly on the base branch in closed-loop mode, switch to a
feature branch from that `HEAD` first so the base remains clean).

In closed-loop mode, run the relevant validation gates first—fix failures caused
by the change under review and report unrelated baseline failures separately
rather than pulling out-of-scope edits into the branch without user approval.
Commit any uncommitted in-scope work onto the branch following repository commit
and signing conventions, and push if driving a remote branch or open PR. (In
explicit read-only mode on dirty working trees, leave Git untouched and instruct
reviewers to inspect `git diff <BASE_SHA>` plus untracked paths and copy
working-tree files rather than `git archive HEAD`.)

### 2. Dispatch parallel blind reviews

Capture a `git status --porcelain` baseline snapshot (so pre-existing
out-of-scope edits are distinguished from unexpected reviewer mutations), then
launch `reviewer_a` and `reviewer_b` in parallel with the identical neutral
briefing (`BASE_SHA`, `git diff <BASE_SHA>..HEAD`, `git log <BASE_SHA>..HEAD`,
applicable project docs) and reviewer expectations:

- Preserve the checkout strictly (scratch work in `/tmp` only, targeted fast
  commands, single final report with no intermediate messages).
- Report only consequential defects (`file:line`, concrete trigger, broken
  contract) ordered by impact, or reply `CLEAR` (with one short verification
  note) and nothing else when merge-ready.

Record both returned subagent IDs and wait until **both tracked reviewers**
settle (use `subagent_wait({ ids: [idA, idB], all: true })` so unrelated
subagents in the session do not wake or block the wait, and do not poll
reviewers with messages—only reply briefly if a reviewer messages first). If a
reviewer fails, times out, or stalls, cancel if needed and retry that slot once;
if it still fails to complete, mark the slot degraded rather than treating it as
`CLEAR`. Never edit files while a reviewer is still running.

### 3. Verify, fix, rebut, and checkpoint

Compare `git status --porcelain` against the pre-review snapshot after reviewers
finish (confirm with the user before discarding any unexpected changes).
Deduplicate findings and check each against the source:

- In **read-only** mode, present verified findings, brief code-backed notes on
  dismissed false positives, and any degraded reviewer status, then stop.
- Otherwise, **fix** real defects and missing tests, **rebut** invalid or
  over-defensive suggestions with specific `file:line` or contract evidence, and
  batch any genuine design forks for user decision (via `ask` when available, or
  a concise direct question otherwise). When fixes were made, pass the relevant
  checks, commit locally (or amend/squash per repository convention), and push
  when working against a remote branch/PR so the next round reviews a clean,
  synchronized `HEAD`.

### 4. Re-verify to convergence

If both reviewers already returned `CLEAR`, proceed to final validation.

Whenever a round changed code or rebutted substantive findings without user
sign-off, capture a fresh `git status --porcelain` baseline and dispatch a
focused verification round to the working reviewer(s) over the updated
`BASE_SHA..HEAD`. Summarize what was fixed and present the exact evidence for
any rebuttals; ask reviewers to verify fixes for regressions, evaluate rebuttals
honestly against the source, avoid opening unrelated topics on untouched code,
and return `CLEAR` if satisfied.

Keep the loop progress-driven: if a reviewer disproves a rebuttal with concrete
evidence, fix and checkpoint it; if the same point remains deadlocked after a
rebuttal exchange, stop arguing and let the user decide (via `ask` when
available, or a direct question otherwise); if rounds stop making progress, halt
and surface the remaining open items clearly. If one reviewer slot is
permanently degraded, converge with the working reviewer and report incomplete
single-reviewer convergence rather than full merge-readiness.

### 5. Final validation and report

Run the repository's full validation gates on the converged `HEAD` and ensure
local commits (and the remote branch/PR when applicable) are clean and synced.
Summarize rounds completed and reviewer verdicts, validation run, defects fixed,
rebuttals with one-line evidence, and any residual risks.
