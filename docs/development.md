# Development, Packaging, and Nightly Operations

See [CONTRIBUTING.md](../CONTRIBUTING.md) for feature proposal principles,
checkout setup, validation commands, and pull request rules, and
[AGENTS.md](../AGENTS.md) for execution and package-boundary constraints.

## Local debugging before merging

Only pack or install locally when you need interactive debugging of uncommitted
changes:

- **Quick iteration:** `pi -e ./packages/<capability>` loads TypeScript source
  directly from the checkout (fast, but shares the checkout's `node_modules`).
- **Packaging, peer resolution, or child-process debugging:** pack the working
  tree into an isolated prefix outside the checkout using the same install layout
  as a [nightly snapshot](installation.md#install-a-nightly-snapshot):

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

To test without changing your normal Pi registrations, launch Pi with an
isolated agent directory (`PI_CODING_AGENT_DIR` isolates settings and sessions,
not environment variables or filesystem permissions):

```bash
install_dir="$dev_root/installs/local.REPLACE_ME"
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

## Package layout and tarball checks

Each package under `packages/<capability>/` declares its own `pi` manifest.
Extension packages use `index.ts` for the extension entrypoint, `src/` for
supporting modules, and `test/*.test.ts` for tests; skill packages ship
`skills/<name>/SKILL.md` with validation tests under `test/*.test.ts`. Add
resource directories only when needed.

When adding or changing a package or installation entrypoint, update:

- [README.md](../README.md) and [packages/README.md](../packages/README.md)
- the package's own `README.md`
- package options in [`.github/ISSUE_TEMPLATE/*.yml`](../.github/ISSUE_TEMPLATE)

The root [LICENSE](../LICENSE) owns the MIT terms. Include a copy in each
package, keep license metadata aligned, and preserve third-party notices
separately. When changing packaging, inspect the affected tarball:

```bash
npm pack --workspace @rchardx/pi-web-access --dry-run
```

Ensure extension archives include `index.ts`, `src/`, `README.md`, `LICENSE`,
and `package.json`, and skill-only archives include `skills/<name>/SKILL.md`,
`README.md`, `LICENSE`, and `package.json` (`scripts/nightly-pack.ts` enforces
this exact allowlist from `package.json#pi`; extend it alongside `files` if a
skill later adds companion directories), while excluding local configuration,
credentials, tests, and generated artifacts.

## Binary assets

[`.gitattributes`](../.gitattributes) owns Git LFS patterns. Use lowercase file
extensions and `git lfs track '<pattern>'` for additional binary types. Commit
`.gitattributes` together with the asset, and verify tracking with
`git check-attr filter -- <path>` and `git lfs ls-files`. Do not force-add
ignored build output or caches.

## Nightly publishing and recovery

[`.github/workflows/nightly.yml`](../.github/workflows/nightly.yml) runs daily
at 08:08 UTC and supports `main`-only manual dispatch with an optional `force`
boolean (default `false`). One `main` SHA is fixed across all jobs. If that SHA
already has a published `nightly` prerelease and an annotated `nightly` tag
pointing to it, validation and publishing are skipped unless `force` is `true`.

CI and nightly validation install the Pi development dependencies pinned in the
root `package.json` with `npm ci`. Installed-tarball smoke logs report the Pi
SDK and Node versions used; nightly release notes report the pinned Pi version.

Before publishing, both the minimum and development Node runtimes run checks,
tests, tarball packing (`<base>-nightly.<run_number>.g<full SHA>`, leaving
source versions unchanged and `private: true`), and isolated installed-tarball
smoke tests. Only the `publish` job requests `contents: write` (using the
built-in `GITHUB_TOKEN`). Before staging and again immediately before cutover,
it reads the current `main` SHA. If the read fails, publication stops; if `main`
has moved, or if a newer `run_number` has already published `nightly` for the
same `main` SHA, the job skips without changing the live release or tag, even
when forced. To publish the new head, start a fresh run instead of rerunning the
old failed jobs. This guard runs from the verified commit: do not rerun failed
publish jobs from commits predating it.

For a matching SHA, it creates an annotated `nightly` tag object stamped with
the publication time and uploads each package's `pi-<capability>-nightly.tgz`
archive to a temporary `nightly-draft-<run_id>-<run_attempt>` draft prerelease
while keeping the existing `nightly` release online. Once all archives are
uploaded, it deletes any existing `nightly` release, advances
`refs/tags/nightly` to the annotated tag, promotes the draft to `nightly`, and
sweeps any leftover `nightly-draft-*` drafts (a pre-promotion failure also
deletes its own temporary draft before exiting). Recreating the release
refreshes `published_at` and the package archives, while the annotated tag
points source archives at the verified `main` commit and updates the tag and
`Source code` entry dates shown on the GitHub release page (file timestamps
inside GitHub's generated source archives still reflect the commit time). If
publication fails partway through and `main` is still at that SHA, rerun the
workflow (or dispatch with `force: true`) to repair the release.
