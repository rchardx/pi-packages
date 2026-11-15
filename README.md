# pi-packages

Personal [Pi coding agent](https://github.com/earendil-works/pi) packages maintained
in one npm-workspaces repository. Each capability lives in its own
[`packages/<capability>/`](packages/README.md) directory.

Packages are maintained locally and have not been published. Install individual
packages from a checkout, not the repository root.

## Setup

For development, install Pi, the default Node.js version in
[`.node-version`](.node-version), npm, and [Git LFS](https://git-lfs.com/).
Clone the repository and install its dependencies:

```bash
git clone https://github.com/rchardx/pi-packages.git
cd pi-packages
npm ci
```

All package commands below run from this repository root. Local Pi installs refer
to this checkout rather than copying it; keep the checkout in place. Choose either
a temporary session or a persistent install, not both for the same package.

## Packages: installation and usage

| Package | Tools | Try for one session | Install for your Pi user | Usage guide |
| --- | --- | --- | --- | --- |
| web-access | `web_fetch` | `pi -e ./packages/web-access` | `pi install ./packages/web-access` | [Usage, limits, and compatibility](packages/web-access/README.md) |

### web-access

Read a public web page or text URL without an API key. After loading the package,
ask Pi, for example:

> Use web_fetch to read <https://example.com> and summarize the page.

The model calls this tool; it is not a shell command or a slash command:

```typescript
web_fetch({ url: "https://example.com" })
```

HTML becomes readable text; Markdown, JSON, CSV, XML, and plain text are preserved
as text. JavaScript rendering, login, search, and PDF extraction are not supported.
For TUN/fake-IP networks, configure your trusted address pool through the optional
user-level [`allowRanges` setting](packages/web-access/README.md#network-configuration-allowranges).
Normal public networks require no configuration. Long responses return a local
file path for continuing with Pi's `read` tool.

After updating the checkout, run `npm ci` when dependencies changed and restart Pi
or use `/reload` to load the updated extension.

## Node.js compatibility

[`.node-version`](.node-version) selects the default development runtime.
[`package.json`](package.json) defines the supported runtime floor; each package
also declares its own `engines.node`. A newer development runtime does not raise
the minimum version required to use the packages.

Checks, tests, and Pi SDK package discovery, extension loading, and tool execution
have been verified on **Node 22.19.0 and Node 26.13.1** with Pi 1.5.2.
CI derives the exact minimum from the root `engines.node` and tests it alongside
the default development version. Both must pass the required `check` gate.
Node type declarations stay on the minimum supported major to help prevent use of
newer-only APIs; runtime tests are still required to establish compatibility.

## Pi compatibility

| Status | Pi version |
| --- | --- |
| Development target | `@earendil-works/pi-coding-agent@1.5.2` |
| Latest verified compatible version | Pi `1.5.2` — package discovery, extension loading, and tool execution |

Each package's README records the scope of its compatibility checks and network
limitations. npm's latest release is not automatically a supported version.
See [compatibility rules](AGENTS.md#compatibility) for how this is maintained.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for checkout setup, validation, signed
commits, and the pull request workflow. [AGENTS.md](AGENTS.md) defines execution
constraints, package boundaries, and compatibility requirements.

## Distribution

The repository root is private development infrastructure, not an installable
Pi bundle. `pi install git:github.com/rchardx/pi-packages` is not a substitute for
the individual package installations above.

Packages remain marked `private: true` and have not been published to npm.
Publication is a separate decision from source licensing.

## License

This repository and its packages are licensed under the [MIT License](LICENSE).
Third-party dependencies retain their own licenses.
