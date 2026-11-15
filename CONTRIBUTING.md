# Contributing

Contributions should solve a concrete problem with a small, complete change.
This guide owns the contribution workflow and commit conventions.
[AGENTS.md](AGENTS.md) defines execution constraints, package boundaries, and
completion requirements. Design and validation rules apply to human and agent changes.

## Before you start

- Use the issue templates for bugs, substantial features, and investigations.
  Describe scope, expected behavior, and observable acceptance criteria.
- For bugs, include reproduction steps and relevant Node, Pi, and operating
  system versions. Remove credentials, private URLs, and sensitive logs.
- Discuss new packages, major runtime dependencies, and runtime support changes
  before implementing them.
- Use English for code, comments, documentation, issues, commits, and PRs.

## Set up a checkout

Fork the repository unless you already have write access, then clone your fork.
Install Git, Git LFS, and the development Node version selected by
[.node-version](.node-version), including npm. From the repository root:

```bash
npm ci
npm run hooks:install
git lfs pull
git switch -c feat/describe-your-change
```

The hook installation changes this checkout's `core.hooksPath`; inspect any
existing custom hooks before running it. Configure Git commit signing before
committing: the main branch requires verified signatures. Preserve existing hooks,
including Git LFS hooks, when changing local automation.

Install Pi to try packages interactively. Follow the
[root README](README.md#packages-installation-and-usage) for package-specific
installation and usage. Automated tests do not require model credentials.

## Make and validate a change

Keep each change focused and include its tests and relevant documentation.
Follow the [package boundaries](AGENTS.md#package-boundaries). Name tests
`*.test.ts` under `scripts/` or `packages/` so `npm test` discovers them.
During implementation, run the narrowest relevant checks; use `npm run format`
to apply formatting when needed.

For behavior, API, dependency, CI, or tooling changes, run:

```bash
npm run check
npm test
git diff --check
```

Validate on the minimum and default Node runtimes described in
[Node.js compatibility](README.md#nodejs-compatibility). CI exercises both.
Documentation-only validation and other specialized requirements are defined in
[validation and safety](AGENTS.md#validation-and-safety).

[Dependabot configuration](.github/dependabot.yml) owns the automated update
policy. Upgrade Pi and matching host development libraries together under the
[compatibility requirements](AGENTS.md#compatibility). Keep security updates
eligible; do not suppress alerts or force runtime upgrades to resolve an update.

## Package changes

Each package declares its own `pi` manifest and uses `src/index.ts` for its
extension entrypoint and `test/*.test.ts` for tests. Add resource directories
only when needed. Update the root package index and package README when adding
or changing an installation entrypoint.

The root [LICENSE](LICENSE) owns the MIT terms. Include a copy in each package,
keep license metadata aligned, and preserve third-party notices separately.
When changing packaging, inspect the affected package's tarball; for web-access:

```bash
npm pack --workspace @rchardx/pi-web-access --dry-run
```

Ensure the package includes its entrypoint, README, and license, but no local
configuration, credentials, or generated artifacts.

## Binary assets

[`.gitattributes`](.gitattributes) owns Git LFS patterns. Use lowercase extensions
and `git lfs track '<pattern>'` for additional binary types. Commit the attributes
with the asset, and verify tracking with `git check-attr filter -- <path>` and
`git lfs ls-files`. Do not force-add ignored build output or caches.

## Submit a pull request

1. Review the complete diff and stage only the intended changes.
2. Create focused, signed commits with the
   [required message structure](#commit-and-pr-messages). The local hooks run checks and
   validate commit messages; they check the working tree, not an isolated index.
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
