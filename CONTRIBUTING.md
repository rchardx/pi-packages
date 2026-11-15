# Contributing

Contributions should solve a concrete problem with a small, complete change.
[AGENTS.md](AGENTS.md) is the authority for development rules, package boundaries,
validation, and commit conventions. The same rules apply to human and agent changes.

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
committing: the main branch requires verified signatures.

Install Pi to try packages interactively. Follow the
[root README](README.md#packages-installation-and-usage) for package-specific
installation and usage. Automated tests do not require model credentials.

## Make and validate a change

Keep each change focused and include its tests and relevant documentation.
Follow the [package boundaries](AGENTS.md#package-boundaries); do not add empty
packages or speculative abstractions. Use npm to update dependencies and commit
the resulting lockfile rather than editing it by hand.

For behavior, dependency, CI, or tooling changes, run:

```bash
npm run check
npm test
git diff --check
```

Validate on the minimum and default Node runtimes described in
[Node.js compatibility](README.md#nodejs-compatibility). CI exercises both.
Documentation-only validation and other specialized requirements are defined in
[the quality gates](AGENTS.md#tooling-and-quality-gates).

When changing web-access packaging, inspect its tarball contents:

```bash
npm pack --workspace @rchardx/pi-web-access --dry-run
```

Ensure the package includes its entrypoint, README, and license, but no local
configuration, credentials, or generated artifacts. Do not weaken checks or
network safety rules to make a test pass.

## Submit a pull request

1. Review the complete diff and stage only the intended changes.
2. Create focused, signed commits with the
   [required message structure](AGENTS.md#commits). The local hooks run checks and
   validate commit messages; they check the working tree, not an isolated index.
3. Push your branch and open a PR against `main`, using the PR template.
   Its title and body must also satisfy the commit-message contract.
4. Explain the behavior change and rationale, link any relevant issue, and report
   the validation commands you actually ran. Include known limitations.
5. Keep the branch current with `main` and wait for both runtime checks,
   the aggregate `check`, and `pr-message` to pass before merging.

Keep unrelated cleanup out of the PR. Do not commit secrets, personal Pi settings,
or machine-specific paths. Binary assets use the existing Git LFS rules.

## License and publication

By submitting a contribution, you agree to license it under this repository's
[MIT License](LICENSE). Only contribute material you have the right to license,
and preserve required third-party copyright and license notices.

Packages remain `private: true` to prevent accidental publication. Publishing
this project's maintained npm packages requires a separate maintainer decision;
this does not restrict redistribution permitted by the MIT License.
