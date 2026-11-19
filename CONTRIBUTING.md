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

## Install a nightly snapshot

For normal day-to-day testing of `main` without a checkout, install from the
rolling [Nightly prerelease](https://github.com/rchardx/pi-packages/releases/tag/nightly).
Each successful run publishes one `pi-<capability>-nightly.tgz` per package
under `packages/`. These snapshots are not stable releases or npm registry
publications, and asset replacement is not atomic—avoid downloading while a run
is publishing and keep your previous local installation for rollback.

Download the desired tarballs into a fresh directory, install them into a new
prefix outside any checkout, and register the resulting package directories:

```bash
archives="/absolute/path/to/nightly-downloads"
dev_root="$HOME/.local/share/pi-packages-dev"
mkdir -p "$dev_root/installs"
(
  set -e
  install_dir=$(mktemp -d "$dev_root/installs/nightly.XXXXXX")
  npm install --prefix "$install_dir" --legacy-peer-deps \
    --ignore-scripts --no-audit --no-fund \
    "$archives"/pi-*-nightly.tgz
  printf '\nInstalled nightly: %s\n' "$install_dir"
)
```

Before switching registrations, stop running Pi sessions and background tasks,
run `pi list` to record your previous sources for rollback, and remove old
registrations of these packages with `pi remove <source>` (use
`pi remove --local <source>` for project-scoped entries). Then register the new
prefix (never pass `.tgz` files directly to `pi install`):

```bash
install_dir="$dev_root/installs/nightly.REPLACE_ME"
for pkg in "$install_dir"/node_modules/@rchardx/pi-*; do
  pi install "$pkg"
done
pi list
```

Restart `pi` after switching; `/reload` does not update already-running child
processes. Always use a fresh prefix on updates. To roll back, stop Pi, remove
the new registrations, re-register the recorded old sources, and restart.

## Local debugging before merging

Only pack or load locally when you need on-the-spot debugging of uncommitted
changes:

- **Quick iteration:** `pi -e ./packages/<capability>` loads source directly
  (fast, but shares the checkout's `node_modules`).
- **Packaging, peer resolution, or child-process debugging:** pack your working
  tree into an isolated prefix outside the checkout using the same install and
  registration flow as a nightly snapshot:

```bash
dev_root="$HOME/.local/share/pi-packages-dev"
mkdir -p "$dev_root/installs"
(
  set -e
  install_dir=$(mktemp -d "$dev_root/installs/local.XXXXXX")
  mkdir "$install_dir/archives"
  npm pack --workspaces --pack-destination "$install_dir/archives"
  npm install --prefix "$install_dir" --legacy-peer-deps \
    --ignore-scripts --no-audit --no-fund "$install_dir"/archives/*.tgz
  printf '\nInstalled local build: %s\n' "$install_dir"
)
```

To test without changing your normal Pi registrations, launch with an isolated
agent directory (note: `PI_CODING_AGENT_DIR` isolates settings and sessions, not
environment variables or filesystem permissions):

```bash
mkdir -p "$dev_root/agent" "$dev_root/work"
(
  cd "$dev_root/work" || exit
  args=()
  for pkg in "$install_dir"/node_modules/@rchardx/pi-*; do
    args+=(-e "$pkg")
  done
  PI_CODING_AGENT_DIR="$dev_root/agent" pi "${args[@]}"
)
```

Both nightly and local tarball installs remain **local Pi sources**, not managed
`npm:` registry installs; do not claim npm registry coverage from them.

## Nightly publishing and recovery

[`.github/workflows/nightly.yml`](.github/workflows/nightly.yml) runs daily at
00:00 UTC and supports main-only manual dispatch with an optional `force`
boolean (default `false`). One `main` SHA is fixed across all jobs. If that SHA
already has a published `nightly` prerelease, validation and publishing are
skipped unless `force` is `true`.

Before publishing, both the minimum and development Node runtimes run checks,
tests, tarball packing (`<base>-nightly.<run_number>.g<full SHA>`, leaving
source versions unchanged and `private: true`), and isolated installed-tarball
smoke tests. Only the `publish` job requests `contents: write` (using the
built-in `GITHUB_TOKEN`). Before writing, it reads the current `main` SHA again.
If the read fails, publication stops; if `main` has moved, the job skips without
changing the release or tag, even when forced. To publish the new head, start a
fresh run instead of rerunning the old failed jobs. This guard runs from the
verified commit: do not rerun failed publish jobs from commits predating it.

For a matching SHA, it replaces each package's `pi-<capability>-nightly.tgz`
asset in place, updates the release notes, publishes the draft on first run, and
advances the lightweight `nightly` tag last. If publication fails partway
through, rerun the workflow (or dispatch with `force: true` for a same-SHA
failure) to repair the release.

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

Each package declares its own `pi` manifest and uses `index.ts` for its
extension entrypoint, `src/` for supporting modules, and `test/*.test.ts` for
tests. Add resource directories only when needed. Update the root package index,
package README, and package options in `.github/ISSUE_TEMPLATE/*.yml` when
adding or changing a package or installation entrypoint.

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
