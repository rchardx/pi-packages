# pi-packages

[![CI](https://img.shields.io/github/actions/workflow/status/rchardx/pi-packages/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=white)](https://github.com/rchardx/pi-packages/actions/workflows/ci.yml?query=branch%3Amain)
[![Nightly](https://img.shields.io/github/actions/workflow/status/rchardx/pi-packages/nightly.yml?branch=main&style=flat-square&label=Nightly&logo=githubactions&logoColor=white)](https://github.com/rchardx/pi-packages/actions/workflows/nightly.yml)
[![Nightly Release](https://img.shields.io/github/release-date-pre/rchardx/pi-packages?style=flat-square&label=Nightly%20Release&logo=github&logoColor=white&color=0969da)](https://github.com/rchardx/pi-packages/releases/tag/nightly)
[![Pi](https://img.shields.io/github/package-json/dependency-version/rchardx/pi-packages/dev/@earendil-works%2Fpi-coding-agent?style=flat-square&label=Pi&color=6e56cf)](#compatibility)
[![Node.js](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Frchardx%2Fpi-packages%2Fmain%2Fpackage.json&query=%24.engines.node&style=flat-square&label=Node.js&logo=nodedotjs&logoColor=white&color=5fa04e)](#compatibility)
[![License](https://img.shields.io/github/license/rchardx/pi-packages?style=flat-square&label=License&color=0969da)](LICENSE)

Personal [Pi coding agent](https://github.com/earendil-works/pi) packages
maintained in one npm-workspaces repository. Each capability lives in its own
[`packages/<capability>/`](packages/README.md) directory.

Install individual packages from a local checkout or the rolling
[Nightly GitHub prerelease](https://github.com/rchardx/pi-packages/releases/tag/nightly).
Packages are `private: true` and are not published to npm; the repository root
is not an installable Pi bundle.

## Packages

| Package | Surface | Summary |
| --- | --- | --- |
| [ask](packages/ask/README.md) | `ask` | Structured 1–4 question multiple-choice user clarification in TUI and RPC sessions |
| [web-access](packages/web-access/README.md) | `web_fetch`, `web_search` | Opt-in hosted web search (with domain/date filters) and page or objective-excerpt fetching across Exa, Parallel, and DeepSeek |
| [background](packages/background/README.md) | `bash` (override), `/background` | Background execution for long `bash` commands with bounded logs and completion notifications |
| [subagents](packages/subagents/README.md) | `subagent`, `subagent_cancel`, `subagent_list`, `subagent_send`, `subagent_wait`, `/subagents` | Session-owned child Pi agents with fresh context, role presets, and live parent-child messaging |
| [statusline](packages/statusline/README.md) | Interactive TUI footer | Fixed two-line TUI footer with inline `subagents` and `background` statuses above model, context, cost, and token stats |
| [skills](packages/skills/README.md) | `deep-research`, `/skill:review-loop` | Zero-runtime-dependency workflow skills (`deep-research` for evidence-backed technical research and `review-loop` for multi-round cross-model code review) |

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
| Pi development target | `@earendil-works/pi-coding-agent@1.6.0` |
| Verified Pi compatibility | Pi `1.6.0` — package discovery, extension loading, and representative tool execution |
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
