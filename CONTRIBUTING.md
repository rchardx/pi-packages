# Contributing

Contributions should solve a concrete problem with a small, complete change.
This guide owns feature proposal principles, contribution workflow, and commit
conventions. [AGENTS.md](AGENTS.md) defines execution constraints, package
boundaries, and completion requirements. Design and validation rules apply to
human and agent changes.

## Before you start

- Use the [issue templates](.github/ISSUE_TEMPLATE) for bugs, feature requests,
  and planned work. Describe scope, expected behavior, and observable acceptance
  criteria.
- For bugs, include reproduction steps and relevant Node, Pi, and operating
  system versions. Remove credentials, private URLs, and sensitive logs.
- Discuss new packages, major runtime dependencies, and runtime support changes
  before implementing them.
- Use English for code, comments, documentation, issues, commits, and PRs.

## Feature proposal principles

Apply these rules when proposing or scoping a feature:

1. **Start from a concrete user friction, not feature parity.** Describe the
   specific workflow gap in Pi rather than copying a feature name from another
   harness. See [Ecosystem Trends and Capability Radar](docs/ecosystem-trends.md)
   for tracked external signals and current scope stances.
2. **Verify host and existing package coverage first.** Check whether Pi's
   built-in commands, settings, keybindings, or an existing package in this
   repository already solve the problem.
3. **Target the 80% workflow with clear defaults.** Choose one sensible scope
   instead of adding configuration switches, fallback modes, or abstractions for
   speculative long-tail cases.
4. **Cut surface area, never correctness.** Keep the feature narrow, but preserve
   non-negotiable safety and quality guarantees: draft/data preservation,
   cancellation, concurrency safety, bounded resource use, and clean degradation
   on failure.
5. **Prefer extending an existing package or documentation over a new package.**
   Create a new package only when the capability is distinct, self-contained, and
   cannot be expressed as a small addition to an existing package.
6. **Measure cost by maintenance surface, not line count.** Persistent state,
   background processes, custom editor ownership, extra model calls, and host
   lifecycle hooks cost much more to maintain than pure read-only helpers.
7. **State explicit non-goals and observable acceptance criteria.** Define where
   the initial version stops and what concrete outcomes verify it. Expand later
   only when real usage demonstrates the need.

## Set up a checkout

Fork the repository unless you already have write access, then clone your fork.
Install Git, Git LFS, and the development Node version selected by
[`.node-version`](.node-version), including npm. From the repository root:

```bash
npm ci
npm run hooks:install
git lfs pull
git switch -c feat/describe-your-change
```

The hook installation sets `core.hooksPath` to `.githooks`; inspect any existing
custom hooks before running it. Configure Git commit signing before committing:
the `main` branch requires verified signatures. Preserve existing hooks,
including Git LFS hooks, when changing local automation.

For interactive package installation, nightly snapshots, isolated local tarball
debugging, package layout, Git LFS rules, and nightly release recovery, see:

- [Installation and Nightly Snapshots](docs/installation.md)
- [Development, Packaging, and Nightly Operations](docs/development.md)

## Make and validate a change

Keep each change focused and include its tests and relevant documentation.
Follow the [package boundaries](AGENTS.md#package-boundaries). Name tests
`*.test.ts` under `scripts/` or `packages/` so `npm test` discovers them.
During implementation, run the narrowest relevant checks; use `npm run format`
to apply formatting when needed.

For behavior, API, dependency, CI, or tooling changes, run separately:

```bash
npm run check
npm test
git diff --check
```

For documentation-only changes, run `npm run lint:docs` and `git diff --check`.
Validate on the minimum and default Node runtimes described in
[Compatibility](README.md#compatibility). CI exercises both. Detailed validation
and security rules are defined in [AGENTS.md](AGENTS.md#validation-and-safety).

[Dependabot configuration](.github/dependabot.yml) owns automated dependency
updates. Upgrade Pi and matching host development libraries together under the
[compatibility requirements](AGENTS.md#compatibility).

## Submit a pull request

1. Review the complete diff and stage only the intended changes.
2. Create focused, signed commits with the
   [required message structure](#commit-and-pr-messages). The local hooks run
   checks and validate commit messages against the working tree.
3. Push your branch and open a PR against `main`, using the PR template.
   Its title and body must also satisfy the commit-message contract.
4. Explain the behavior change and rationale, link any relevant issue, and report
   the validation commands you actually ran. Include known limitations.
5. Keep the branch current with `main`, preserving existing history with signed
   merge commits. Wait for both runtime checks, the aggregate `check`, and
   `pr-message` to pass before merging; agents must not merge without authorization.

### Commit and PR messages

Use this English-only structure for commits and for the PR title plus body:

```text
<type>[(scope)][!]: <imperative subject>

<one-paragraph purpose and context>

Key changes:
- <concrete change>
```

- Allowed types: `chore`, `docs`, `feat`, `fix`, `test`, `refactor`.
- The complete subject is under 72 characters. Scopes use lowercase letters,
  digits, dots, underscores, or hyphens.
- Separate subject, summary, and `Key changes:` with exactly one blank line.
  Follow `Key changes:` immediately with contiguous bullets.
- Breaking changes use `!` or a `BREAKING CHANGE:` footer and include a `Rebuild:`
  section explaining what callers must regenerate or reinstall.
- Describe the actual diff, not the whole task or future work. Keep related tests,
  docs, and lockfile changes together; avoid artificial splits and final WIP/fixups.
- Validate messages with `npm run check:commit -- <message-file>` and staged
  whitespace with `git diff --cached --check` before committing. The
  [message checker](scripts/check-commit-message.ts) enforces the format.
- Bot PRs use the same contract; normalize their metadata rather than bypassing
  checks. Use the PR template and report only validation you actually performed.

## License and publication

By submitting a contribution, you agree to license it under this repository's
[MIT License](LICENSE). Only contribute material you have the right to license,
and preserve required third-party copyright and license notices.

Packages remain `private: true` to prevent accidental publication. Publishing
this project's maintained npm packages requires a separate maintainer decision;
this does not restrict redistribution permitted by the MIT License.
