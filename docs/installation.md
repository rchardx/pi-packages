# Installation and Nightly Snapshots

Packages in this repository are installed individually. The repository root is
private development infrastructure, not an installable Pi bundle, and packages
are not published to npm.

## Prerequisites

Install the [Pi CLI](https://github.com/earendil-works/pi) so `pi --version`
works on your `PATH`, along with Node.js (`>=22.19.0`;
[`.node-version`](../.node-version) selects the default development runtime),
npm, and [Git LFS](https://git-lfs.com/).

## Install from a local checkout

Clone the repository and install its workspace dependencies once (`npm ci`
installs workspace development dependencies locally; it does not install a
global `pi` binary):

```bash
git clone https://github.com/rchardx/pi-packages.git
cd pi-packages
npm ci
```

From the repository root, load a package for a single session or register it
persistently for your Pi user (replace `ask` with the package you want):

```bash
# One session
pi -e ./packages/ask

# Persistent registration
pi install ./packages/ask
```

Local Pi registrations point to this checkout rather than copying it; keep the
checkout in place. Choose either a temporary `-e` session or a persistent
`pi install` registration, not both for the same package.

After pulling repository updates, run `npm ci` when dependencies changed and
restart `pi` (or run `/reload` when no child processes need updating).

## Install a nightly snapshot

For day-to-day use of `main` without keeping a repository checkout, install from
the rolling [Nightly prerelease](https://github.com/rchardx/pi-packages/releases/tag/nightly).
Each successful nightly run publishes one `pi-<capability>-nightly.tgz` archive
per package under `packages/`.

These snapshots are rolling development builds, not stable releases or npm
registry publications, and release replacement is not atomic—avoid downloading
while a workflow run is publishing and keep your previous local installation
directory for rollback.

1. Download the desired `pi-*-nightly.tgz` archives into a fresh empty
   directory, then install them into a fresh prefix outside any checkout:

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

2. Before switching registrations, stop running Pi sessions and background
   tasks, run `pi list` to record your previous sources for rollback, and remove
   old registrations of these packages with `pi remove <source>` (or
   `pi remove --local <source>` for project-scoped entries).

3. Register the installed package directories from the new prefix (never pass
   `.tgz` archives directly to `pi install`; use `pi install --local "$pkg"`
   when replacing a project-scoped registration):

   ```bash
   install_dir="$dev_root/installs/nightly.REPLACE_ME"
   for pkg in "$install_dir"/node_modules/@rchardx/pi-*; do
     pi install "$pkg"
   done
   pi list
   ```

4. Restart `pi` after switching; `/reload` does not update already-running child
   processes.

Always create a fresh prefix when updating. To roll back, stop Pi, remove the
new registrations, re-register the recorded previous sources in their original
scope (`--local` for project-scoped entries), and restart.
