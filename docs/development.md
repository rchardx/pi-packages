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

Each package under `packages/<capability>/` declares its own `pi` manifest and
uses `index.ts` for its extension entrypoint, `src/` for supporting modules, and
`test/*.test.ts` for tests. Add resource directories only when needed.

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

Ensure the archive includes `index.ts`, `src/`, `README.md`, `LICENSE`, and
`package.json`, and excludes local configuration, credentials, tests, and
generated artifacts.

## Binary assets

[`.gitattributes`](../.gitattributes) owns Git LFS patterns. Use lowercase file
extensions and `git lfs track '<pattern>'` for additional binary types. Commit
`.gitattributes` together with the asset, and verify tracking with
`git check-attr filter -- <path>` and `git lfs ls-files`. Do not force-add
ignored build output or caches.

## Nightly publishing and recovery

[`.github/workflows/nightly.yml`](../.github/workflows/nightly.yml) runs daily
at 08:29 UTC and supports `main`-only manual dispatch with an optional `force`
boolean (default `false`). One `main` SHA is fixed across all jobs. If that SHA
already has a published `nightly` prerelease, validation and publishing are
skipped unless `force` is `true`.

CI and nightly validation install the Pi development dependencies pinned in the
root `package.json` with `npm ci`. Installed-tarball smoke logs report the Pi
SDK and Node versions used; nightly release notes report the pinned Pi version.

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
through and `main` is still at that SHA, rerun the workflow (or dispatch with
`force: true` for a same-SHA failure) to repair the release.
