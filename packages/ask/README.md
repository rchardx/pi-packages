# @rchardx/pi-ask

Structured pre-execution user clarification for Pi coding agent. Gives the model
an `ask` tool to batch 1–4 multiple-choice questions before editing files or
committing to ambiguous trade-offs.

## Usage

Try for one session from the repository checkout:

```bash
pi -e ./packages/ask
```

Install persistently:

```bash
pi install ./packages/ask
```

For a checkout-free development snapshot, follow the
[nightly tarball installation guide](../../docs/installation.md#install-a-nightly-snapshot).
Nightlies are rolling prereleases, not npm registry publications.

Example call:

```typescript
ask({
  questions: [
    {
      id: "auth",
      header: "Auth",
      question: "Which authentication flow should the CLI use?",
      options: [
        {
          label: "Device code (Recommended)",
          description: "Works over SSH and headless terminals without localhost redirects.",
        },
        {
          label: "Localhost OAuth callback",
          description: "Opens the system browser and listens on 127.0.0.1.",
        },
      ],
    },
    {
      id: "scopes",
      header: "Scopes",
      question: "Which token scopes should be requested by default?",
      multiSelect: true,
      options: [
        { label: "read:org" },
        { label: "repo" },
        { label: "workflow" },
      ],
    },
  ],
})
```

## Schema and limits

- **`questions`:** 1–4 questions per `ask` call (`executionMode: "sequential"`).
  Duplicate question `id` values are rejected.
- **`options`:** 2–5 distinct choices per question (`label` plus optional
  `description`). Duplicate labels and explicit `"Other"` / `"Other…"` labels
  are rejected because every question automatically provides a built-in
  `Other…` free-text input.
- **`multiSelect`:** optional boolean (default `false`). Single-select submits
  as soon as an option or non-empty `Other…` answer is confirmed; multi-select
  toggles option rows with `Space` or `Enter` and submits on `✓ Confirm selection`.

## Host mode behavior

- **Interactive (`tui`):** opens a keyboard-driven component via
  `ctx.ui.custom()` with OSC 7501 `blocked: { kind: "question" }` status,
  single-line `Input` with hardware cursor / CJK IME positioning for `Other…`,
  and `Tab` / `Shift+Tab` / `←` / `→` tab navigation across multi-question
  prompts before final review on `✓ Submit`. Pressing `Escape` cancels the
  entire prompt (`cancelled: true`, `answers: []`).
- **RPC (`rpc`):** falls back to sequential `ctx.ui.select()` and
  `ctx.ui.input()` dialogs, preserving single-select, multi-select toggling,
  `Other…` free-text entry, and `AbortSignal` cancellation.
- **Headless (`print`, `json`, including delegated subagent runs):** `ask` stays
  active in the session loadout so resuming a session across `print` and `tui`
  modes preserves tool selection, while `prepareLoadout` hides `ask` from model
  declarations and prompt guidelines whenever no interactive UI is bound. Direct
  calls in non-interactive modes fail closed with an explicit error.

## Tool cards in Pi

Cards use a lowercase **`ask`** header (`ask  <question>` for one question or
`ask (N questions)  <headers>` for multi-question calls) and a two-line
collapsed summary (`Answered: …` or `Answered N questions`, or `Cancelled`).
Expanding (`ctrl+o`) reveals each question and its selected or custom answer.

## Compatibility

Developed against Pi `1.5.2` with Node `>=22.19.0`. Checks, tests, package
discovery, extension loading, and representative `ask` tool execution (including
live PTY `pi` CLI TUI rendering and RPC fallback) have been verified on **Node
22.19.0, Node 24.21.0, and Node 26.13.1 with Pi 1.5.2 on Linux** using a local
mock model endpoint rather than live provider credentials.
