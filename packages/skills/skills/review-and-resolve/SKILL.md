---
name: review-and-resolve
description: Run an independent blind code review loop with a configured reviewer subagent, resolving every finding by fixing real defects, rebutting false positives or over-defensive suggestions with code evidence, or escalating genuine trade-offs, and re-verifying until the reviewer returns CLEAR.
disable-model-invocation: true
---

# Review and Resolve

Drive code changes to merge-ready quality through independent blind review
(`reviewer`), evidence-based triage, and focused re-verification until the
reviewer returns `CLEAR`.

Invoking `/skill:review-and-resolve` runs **closed-loop convergence** by default
(verify, fix, rebut, checkpoint, and re-verify). Switch to a single
**read-only** review pass only when the user asks not to modify files or Git
state.

Requires an interactive (`tui`) or `rpc` session with `@rchardx/pi-subagents`
active and a `reviewer` role configured in `subagents.json` (prefer binding
`reviewer` to a model family distinct from your primary coding model for
cross-model coverage). Use `ask` when available (or a concise direct question
otherwise) to escalate genuine design or scope trade-offs.

## Core philosophy

- **Clean checkpoints before every review:** Anchor against an explicit
  `BASE_SHA` and review a clean committed `HEAD` rather than loose in-scope
  edits—commit locally for local branches, and commit plus push when iterating
  on a remote branch or PR (confirming once first if repository rules prohibit
  commits/pushes without explicit approval beyond the command). Clean
  checkpoints keep `git diff`, `git archive`, new files, and PR views aligned.
- **Independent blind judgment:** Give `reviewer` objective context
  only—problem statement, `BASE_SHA..HEAD` scope, and project rule files
  (`AGENTS.md`, `CONTRIBUTING.md`). Withhold your own design rationale or
  justifications so the reviewer is not anchored.
- **Consequential defects over noise:** Target broken behavior, contract or doc
  drift, concurrency/lifecycle/cleanup races, missing validation at real
  untrusted boundaries, security flaws, and weak tests. Trust static types and
  documented host contracts; reject redundant runtime guards, speculative
  abstractions, error-swallowing wrappers, and stylistic nits.
- **Flexible reviewer, preserved checkout:** `reviewer` retains full
  investigative capability (including running fast targeted checks and `/tmp`
  reproductions), guided by natural-language rules never to mutate the checkout
  or Git state and verified by comparing `git status --porcelain` before and
  after each round. Avoid running slow full-repository suites inside `reviewer`
  when targeted tests suffice.
- **Evidence over deference:** Inspect every finding in source yourself. Fix
  real defects and test gaps directly; rebut false positives or over-defensive
  advice with concrete code, type, or contract citations rather than degrading
  the codebase; escalate genuine API or architectural trade-offs to the user.

## The workflow

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
`reviewer` to inspect `git diff <BASE_SHA>` plus untracked paths and copy
working-tree files rather than `git archive HEAD`.)

### 2. Dispatch independent blind review

Capture a `git status --porcelain` baseline snapshot (so pre-existing
out-of-scope edits are distinguished from unexpected reviewer mutations), then
launch `subagent` with `role: "reviewer"`, a neutral briefing (`BASE_SHA`,
`git diff <BASE_SHA>..HEAD`, `git log <BASE_SHA>..HEAD`, applicable project
docs), and reviewer expectations:

- Preserve the checkout strictly (scratch work in `/tmp` only, targeted fast
  commands, single final report with no intermediate messages).
- Report only consequential defects (`file:line`, concrete trigger, broken
  contract) ordered by impact, or reply `CLEAR` (with one short verification
  note) and nothing else when merge-ready.

Record the returned subagent ID and wait until it settles (use
`subagent_wait({ ids: [reviewerId], all: true })` so unrelated subagents in the
session do not wake or block the wait, and do not poll with messages—only reply
briefly if `reviewer` messages first). If `reviewer` fails, times out, or
stalls, cancel with `subagent_cancel` if needed and retry once; if it still
fails to complete, halt and report the reviewer failure clearly rather than
treating it as `CLEAR`. Never edit files while `reviewer` is still running.

### 3. Verify, resolve, and checkpoint

Compare `git status --porcelain` against the pre-review snapshot after
`reviewer` finishes (confirm with the user before discarding any unexpected
changes), then check each finding against the source:

- In **read-only** mode, present verified findings and brief code-backed notes
  on dismissed false positives, then stop.
- Otherwise, resolve each finding: **fix** real defects and missing tests,
  **rebut** invalid or over-defensive suggestions with specific `file:line` or
  contract evidence, and batch any genuine design forks for user decision (via
  `ask` when available, or a concise direct question otherwise). When fixes were
  made, pass the relevant checks, commit locally (or amend/squash per repository
  convention), and push when working against a remote branch/PR so the next
  round reviews a clean, synchronized `HEAD`.

### 4. Re-verify to convergence

If `reviewer` already returned `CLEAR`, proceed to final validation.

Whenever a round changed code or rebutted substantive findings without user
sign-off, capture a fresh `git status --porcelain` baseline and dispatch a
focused verification round to `reviewer` over the updated `BASE_SHA..HEAD`.
Summarize what was fixed and present the exact evidence for any rebuttals; ask
`reviewer` to verify fixes for regressions, evaluate rebuttals honestly against
the source, avoid opening unrelated topics on untouched code, and return `CLEAR`
if satisfied.

Keep convergence progress-driven: if `reviewer` disproves a rebuttal with
concrete evidence, fix and checkpoint it; if the same point remains deadlocked
after a rebuttal exchange, stop arguing and let the user decide (via `ask` when
available, or a direct question otherwise); if rounds stop making progress, halt
and surface the remaining open items clearly.

### 5. Final validation and report

Run the repository's full validation gates on the converged `HEAD` and ensure
local commits (and the remote branch/PR when applicable) are clean and synced.
Summarize rounds completed and reviewer verdicts, validation run, defects fixed,
rebuttals with one-line evidence, and any residual risks.
