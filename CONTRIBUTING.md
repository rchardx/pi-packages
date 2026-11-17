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

## Develop against an installed package

Use an installed tarball for the normal development loop when working on package
loading, dependency resolution, or child processes. Loading source with `pi -e`
is useful for quick edits, but a checkout's `node_modules` can hide missing
runtime dependencies or incorrect resolution of Pi's host-provided peers.

### Prepare an independent installation directory

The default workflow registers installed copies in your normal Pi user settings.
Starting `pi` then uses the development packages with your existing authentication
and plugin configuration; no `-e` flags or separate agent directory are required.
Use the default agent directory for these commands, without a
`PI_CODING_AGENT_DIR` override. This changes the packages used by your daily Pi
sessions; use the optional isolated workflow below when that is not desirable.

Run these Bash commands from the repository root. Keep installation copies outside
the checkout so they cannot resolve dependencies through workspace links:

```bash
repo="$PWD"
dev_root="$HOME/.local/share/pi-packages-dev"
mkdir -p "$dev_root/installs"
```

### Pack and install each iteration

After editing and running relevant checks, run this block from the same shell:

```bash
(
  set -e
  cd "$repo"
  install_dir=$(mktemp -d "$dev_root/installs/iteration.XXXXXX")
  mkdir "$install_dir/archives"
  npm pack --workspaces --pack-destination "$install_dir/archives"
  npm install --prefix "$install_dir" --legacy-peer-deps \
    --ignore-scripts --no-audit --no-fund "$install_dir"/archives/*.tgz
  printf '\nInstalled iteration: %s\n' "$install_dir"
)
```

Inspect the pack output: each package must contain its entrypoint, supporting
modules, README, and license, without tests, credentials, or local configuration.
Packages stay `private: true`; `npm pack` does not publish them. npm installs the
tarballs as real files, not workspace links. `--legacy-peer-deps` leaves Pi's
host-provided peers to Pi rather than installing duplicate host libraries.
`--ignore-scripts` is appropriate for the current packages, which need no install
scripts; reassess it if runtime dependencies later require build steps.

Each iteration uses a fresh prefix, even when package versions have not changed.
This avoids stale files and same-version reinstall ambiguity without deleting a
working installation. If packing or installation fails, do not launch that
iteration; the previous one remains available. Do not use `npm link` or install
workspace directories as a substitute for tarballs.

### Register the iteration in your normal Pi environment

After installation succeeds, stop Pi sessions and their background tasks before
switching registrations. Run `pi list` and record the old sources for rollback.
Remove each existing registration of these workspace packages with `pi remove <source>`;
use the source shown by `pi list` or its resolved absolute local path. Skip removal
for packages that are not installed. This removes registrations, not the local
installation directories. Leave unrelated packages alone.

Also check the target project's `.pi/settings.json` and any explicit extension
configuration for other copies. Project-scoped package registrations need removal
with `pi remove --local <source>` from that project. Different iteration directories
are different local sources: installing a new path does not replace the old one.
Do not combine these registered packages with source-directory `-e` arguments.

Set `install_dir` to the successful iteration path printed above, then register:

```bash
install_dir="$dev_root/installs/iteration.REPLACE_ME"
(
  set -e
  for name in ask background subagents statusline web-access; do
    pi install "$install_dir/node_modules/@rchardx/pi-$name"
  done
  pi list
)
```

Confirm that only the intended copy of each package is registered. Installation
updates the normal user settings in `~/.pi/agent/settings.json`; authentication
and plugin configuration are retained. No credentials need copying. The commands
are not an atomic switch: if registration fails partway through, inspect `pi list`
and either finish registering the new iteration or remove its registrations and
restore the recorded old sources before starting Pi.

### Launch, verify, and roll back

From your usual project directory, start Pi normally:

```bash
pi
```

Check startup diagnostics and exercise the behavior you changed through the real
Pi CLI. For subagents, include actual child delegation, not just extension loading.
For web-access, existing explicit provider opt-in still applies; missing or invalid
configuration is not repaired by reinstalling. Live provider calls can incur
charges. Automated tests must continue to use boundary substitutes, not credentials.

Restart Pi after switching iterations; `/reload` is not proof that existing child
processes use updated code. To roll back, stop the affected sessions and tasks,
remove the new iteration's registrations, reinstall the recorded old sources with
`pi install`, and restart. Keep the previous installation until the new one is
verified. Remove unused iteration directories only after their registrations,
sessions, and tasks are gone. The currently registered installation directory must
remain available, but the source checkout is not needed to run it. Source edits
do not affect an installed copy until you pack, install, and register it again.

### Optional: verify with isolated Pi configuration

To investigate configuration effects or test without changing your daily Pi
registrations, skip the registration step and launch installed copies temporarily:

```bash
mkdir -p "$dev_root/agent" "$dev_root/work"
(
  cd "$dev_root/work" || exit
  PI_CODING_AGENT_DIR="$dev_root/agent" pi \
    -e "$install_dir/node_modules/@rchardx/pi-ask" \
    -e "$install_dir/node_modules/@rchardx/pi-background" \
    -e "$install_dir/node_modules/@rchardx/pi-subagents" \
    -e "$install_dir/node_modules/@rchardx/pi-statusline" \
    -e "$install_dir/node_modules/@rchardx/pi-web-access"
)
```

Set `install_dir` to a successful iteration first. These `-e` paths load installed
copies for that invocation without persistent registration. Keep this agent
configuration and scratch directory free of other copies and project `.pi`
configuration. Inspect project package declarations before granting trust if you
switch to a real project.

`PI_CODING_AGENT_DIR` isolates Pi settings, authentication, sessions, and these
packages' configuration files. It is not a security sandbox: environment API keys
and normal filesystem permissions still apply. Configure development credentials
and provider opt-in explicitly if needed; do not copy personal credentials by
default. Restart with the new installed paths when testing another iteration.

### Know what this validates

This loop validates packaged files and dependency isolation without publishing to
npm. Pi still sees the installed directories as **local sources**, not managed
`npm:` sources. It does not prove managed npm discovery, startup labels, registry
authentication, or update behavior. For changes to those contracts, also test a
real `pi install npm:<package>@<version>` in an isolated Pi environment against an
authorized registry, or use the relevant managed-layout regression tests for the
specific behavior. Layout tests alone do not validate registry installation.
Do not claim npm installation coverage from source loading or this tarball loop.

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
tests. Add resource directories only when needed. Update the root package index
and package README when adding or changing an installation entrypoint.

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
