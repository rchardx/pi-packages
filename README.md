# pi-packages

Personal [Pi coding agent](https://github.com/earendil-works/pi) packages maintained
in one npm-workspaces repository. Each capability lives in its own
[`packages/<capability>/`](packages/README.md) directory.

Packages are maintained locally and have not been published. Install individual
packages from a checkout, not the repository root.

## Setup

Install Pi, the Node.js version in [`.node-version`](.node-version), npm, and
[Git LFS](https://git-lfs.com/). Clone the repository and install its dependencies:

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

## Pi compatibility

| Status | Pi version |
| --- | --- |
| Development target | `@earendil-works/pi-coding-agent@1.5.2` |
| Latest verified compatible version | Pi `1.5.2` — package discovery, extension loading, and tool execution |

Each package's README records the scope of its compatibility checks and network
limitations. npm's latest release is not automatically a supported version.
See [compatibility rules](AGENTS.md#pi-compatibility) for how this is maintained.

## Development

After [setup](#setup), run the repository checks:

```bash
npm run check
npm test
```

Install this checkout's Git/LFS hooks with `npm run hooks:install`, then run
`git lfs pull` to materialize any LFS assets. Binary file patterns are maintained
in [`.gitattributes`](.gitattributes).
Development rules, package boundaries, and the English Conventional Commit
contract are defined in [AGENTS.md](AGENTS.md).

## Distribution

The repository root is private development infrastructure, not an installable
Pi bundle. `pi install git:github.com/rchardx/pi-packages` is not a substitute for
the individual package installations above.

No npm publication or open-source license has been selected. Public source
visibility does not itself grant a license.
