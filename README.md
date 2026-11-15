# pi-packages

Personal [Pi coding agent](https://github.com/earendil-works/pi) packages maintained
in one npm-workspaces repository. Each capability belongs in its own
[`packages/<capability>/`](packages/README.md) directory.

The repository currently provides development infrastructure only. No functional
Pi package has been implemented or published.

## Setup

Use the Node.js version in [`.node-version`](.node-version), npm, and
[Git LFS](https://git-lfs.com/):

```bash
git clone https://github.com/rchardx/pi-packages.git
cd pi-packages
npm ci
```

## Packages: installation and usage

There are no installable packages yet. Each package will document its temporary
loading and persistent installation commands here, with detailed usage in its
own README. Do not install the repository root as a Pi package.

## Pi compatibility

| Status | Pi version |
| --- | --- |
| Development target | `@earendil-works/pi-coding-agent@1.5.2` |
| Latest verified compatible version | Not yet verified; no functional package exists |

The development target is not a compatibility guarantee. See the
[compatibility rules](AGENTS.md#pi-compatibility) for how actual package support
is verified and recorded.

## Development

After setup, run the repository checks:

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
Pi bundle. No npm publication or open-source license has been selected. Public
source visibility does not itself grant a license.
