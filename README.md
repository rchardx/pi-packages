# pi-packages

Personal [Pi coding agent](https://github.com/earendil-works/pi) packages
maintained in one npm-workspaces repository. Each capability lives in its own
[`packages/<capability>/`](packages/README.md) directory.

Install individual packages from a local checkout or the rolling
[Nightly GitHub prerelease](https://github.com/rchardx/pi-packages/releases/tag/nightly).
Packages are `private: true` and are not published to npm; the repository root
is not an installable Pi bundle.

## Packages

| Package | Surface | Summary | Try for one session | Install for your Pi user |
| --- | --- | --- | --- | --- |
| [ask](packages/ask/README.md) | `ask` | Structured 1–4 question multiple-choice user clarification in TUI and RPC sessions | `pi -e ./packages/ask` | `pi install ./packages/ask` |
| [lsp](packages/lsp/README.md) | `lsp`, `/lsp`, post-edit diagnostics | Post-edit and single-file `diagnostics` plus single-symbol `definition`, `references`, and `hover` queries | `pi -e ./packages/lsp` | `pi install ./packages/lsp` |
| [web-access](packages/web-access/README.md) | `web_fetch`, `web_search` | Opt-in hosted web search and page fetching across user-authorized providers | `pi -e ./packages/web-access` | `pi install ./packages/web-access` |
| [background](packages/background/README.md) | `bash` (override), `/background` | Background execution for long `bash` commands with bounded logs and completion notifications | `pi -e ./packages/background` | `pi install ./packages/background` |
| [subagents](packages/subagents/README.md) | `subagent`, `subagent_cancel`, `subagent_list`, `subagent_send`, `subagent_wait`, `/subagents` | Session-owned child Pi agents with fresh context, role presets, and live parent-child messaging | `pi -e ./packages/subagents` | `pi install ./packages/subagents` |
| [statusline](packages/statusline/README.md) | Interactive TUI footer | Fixed two-line TUI footer with inline `subagents` and `background` statuses above token, cost, and model stats | `pi -e ./packages/statusline` | `pi install ./packages/statusline` |

See [`packages/README.md`](packages/README.md) for package overviews and
configuration files, and each package's `README.md` for full behavior, limits,
and mode support.

## Quick start

Install [Pi](https://github.com/earendil-works/pi) (`pi --version` on your
`PATH`), Node.js (`>=22.19.0`; [`.node-version`](.node-version) selects the
development runtime), npm, and [Git LFS](https://git-lfs.com/), then clone the
repository and install dependencies once:

```bash
git clone https://github.com/rchardx/pi-packages.git
cd pi-packages
npm ci
```

Run `pi -e ./packages/<capability>` for one session or
`pi install ./packages/<capability>` for a persistent local registration. For
checkout-free nightly archives, upgrades, rollback, and isolated local tarball
testing, see [Installation and Nightly Snapshots](docs/installation.md) and
[Development, Packaging, and Nightly Operations](docs/development.md).

## Compatibility

| Target | Version |
| --- | --- |
| Pi development target | `@earendil-works/pi-coding-agent@1.5.2` |
| Verified Pi compatibility | Pi `1.5.2` — package discovery, extension loading, and representative tool execution |
| Node.js minimum (`engines.node`) | `>=22.19.0` |
| Default development runtime (`.node-version`) | Node `26.13.1` |
| Verified Node.js runtimes | Node `22.19.0` and Node `26.13.1` on Linux |

Each package's `README.md` records its platform scope and any external binary or
provider requirements. See [AGENTS.md](AGENTS.md#compatibility) for how
compatibility is verified and updated.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for feature proposal principles,
validation gates, and pull request conventions, and [AGENTS.md](AGENTS.md) for
repository execution rules.

Licensed under the [MIT License](LICENSE). Third-party dependencies retain their
own licenses.
