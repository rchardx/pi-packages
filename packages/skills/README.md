# @rchardx/pi-skills

Zero-runtime-dependency workflow skills designed to work with the packages in
this repository.

## Install

From the repository root, try it for one session:

```bash
pi -e ./packages/skills
```

To enable it persistently for your Pi user instead:

```bash
pi install ./packages/skills
```

For a checkout-free development snapshot, follow the
[nightly tarball installation guide](../../docs/installation.md#install-a-nightly-snapshot).
Nightlies are rolling prereleases, not npm registry publications.

The local install refers to this checkout; keep it in place and reload Pi after
changes. Do not install both `-e` and `pi install` for the same package. The
repository root is not an installable Pi bundle.

## Skills

| Skill | Surface | Summary |
| --- | --- | --- |
| [review-loop](skills/review-loop/SKILL.md) | `/skill:review-loop` (`disable-model-invocation: true`) | Multi-round cross-model code review loop (`reviewer_a` + `reviewer_b`) with evidence-based triage, rebuttal, and re-verification until dual `CLEAR` |

### Prerequisites for `review-loop`

- [`@rchardx/pi-subagents`](../subagents/README.md) active in an interactive
  (`tui`) or `rpc` session.
- [`@rchardx/pi-ask`](../ask/README.md) (optional) for escalating genuine design
  or contract trade-offs; falls back to a concise plain-text prompt when
  unavailable.
- `reviewer_a` and `reviewer_b` configured on distinct models in
  `~/.pi/agent/subagents.json` (honors `PI_CODING_AGENT_DIR`):

```json
{
  "roles": {
    "reviewer_a": {
      "description": "Independent code reviewer A",
      "provider": "openai",
      "model": "gpt-6.2-astra",
      "thinking": "medium"
    },
    "reviewer_b": {
      "description": "Independent code reviewer B",
      "provider": "anthropic",
      "model": "claude-fable-5-2",
      "thinking": "medium"
    }
  }
}
```

Reviewer roles intentionally omit `tools` restrictions so each reviewer stays
flexible for deep codebase investigation and isolated `/tmp` reproductions;
checkout preservation relies on natural-language instructions backed by the
parent session's pre/post `git status` comparison rather than a hard tool
sandbox.

## Compatibility

Developed against Pi `1.6.0` with Node `>=22.19.0`. Package discovery and skill
loading have been verified on **Node 22.19.0 and Node 26.13.1 with Pi 1.6.0 on
Linux**.
