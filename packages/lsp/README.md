# @rchardx/pi-lsp

Language server feedback for [Pi](https://github.com/earendil-works/pi): the
errors and warnings of a file right after it is edited, and a small read-only
`lsp` tool for one file or one symbol at a time.

The package is deliberately narrow. It gives less information rather than
uncertain information: a language server that has not answered in time is
reported as not having answered, never as a clean file. Whole-project checks
and searches stay with the project's compiler and `grep`.

It has no runtime npm dependencies and does not bundle language servers; it
talks to the ones installed on your machine or in the project's
`node_modules/.bin` (see [Installing language servers](#installing-language-servers)).

## Installation

From a `pi-packages` checkout:

```bash
# Try for one session
pi -e ./packages/lsp

# Or install persistently for your Pi user
pi install ./packages/lsp
```

## What it does

### Diagnostics after an edit

After a successful `edit` or `write` in a trusted project, the file's errors
and warnings are appended to that tool result:

```text
LSP diagnostics (1 error, 1 warning):
- src/a.ts:8:5 [error TS2322] Type 'string' is not assignable to type 'number'.
- src/a.ts:12:7 [warning TS6133] 'unused' is declared but its value is never read.
```

- Clean files add nothing. At most 20 entries are listed; the counts cover all.
- The edit waits at most 0.8s, server startup included. A result that is not
  there by then is dropped: it is not delivered later, and nothing is appended.
  The server keeps starting and the file stays synced, so the next edit finds
  it ready.
- Files with no configured or installed server, files outside the session
  directory, and untrusted projects are skipped silently.

### The `lsp` tool

```ts
lsp({ action: "diagnostics", path: "src/a.ts" })
lsp({ action: "definition", path: "src/a.ts", line: 42, symbol: "createClient" })
lsp({ action: "references", path: "src/a.ts", line: 42, symbol: "createClient#2" })
lsp({ action: "hover", path: "src/a.ts", line: 42, symbol: "client" })
```

Every action takes one file. `definition`, `references`, and `hover` also take
a 1-indexed `line` and usually a `symbol`: text on that line that selects the
column (`name#2` for the second match), so no columns need to be counted.
Without `symbol`, the first non-blank character of the line is used.

The result is plain text whose first line is a summary:

```text
2 references (typescript)
- src/a.ts:1:17  export function createClient() {
- src/b.ts:9:20  const client = createClient();
```

- `diagnostics` lists errors and warnings (at most 50; the counts cover all),
  or says `no errors or warnings reported`. When a server sends nothing for the
  file's current contents within 2s, the result says exactly that.
- Locations may lie outside the session directory (dependencies, standard
  libraries); at most 50 are listed.
- A file that cannot be served returns the reason as text: outside the session
  directory, no server configured, server not installed, or server failed to
  start.

`/lsp` lists the running servers and those that could not be used.

## How diagnostics are obtained

Three ways, in this order of preference. The first two are a request and an
answer about the file's contents at that moment, with nothing to wait for or
guess:

- **Pull** (`textDocument/diagnostic`, declared at startup or registered
  later; TypeScript 7 `tsc --lsp` and basedpyright work this way). The request
  is sent once more when the server asks for that (`ContentModified`,
  `ServerCancelled`). Typically a few milliseconds on a warm server.
- **tsserver's synchronous diagnostics**, for `typescript-language-server`,
  through its `typescript.tsserverRequest` command. Its push reports carry no
  version and are skipped when nothing changed, so they cannot be matched to
  file contents and are not used. Also a few milliseconds on a warm server.
- **Push** (`textDocument/publishDiagnostics`), for every other server:
  - a report that names the file's current version is used as soon as it
    arrives (clangd works this way, about 60ms per edit);
  - a report without a version is used once no further report followed for
    150ms, because servers may publish syntax and semantic results separately;
  - a report for another version of the file is ignored;
  - a file whose contents did not change since its last report is answered
    from that report;
  - when nothing arrives in time, the edit appends nothing and
    `lsp diagnostics` reports that no diagnostics were sent within 2s. Silence
    is never turned into a clean result.

## Built-in language servers

A server starts when a matching file is first edited or queried in a trusted
project, and runs until the session ends. Candidates are tried in order;
`node_modules/.bin` is searched from the workspace root up through every parent
directory to the file system root (so a session started in a monorepo package
finds tools installed at the repository root), then `PATH`:

| Server ID | Extensions | Candidate executables | Root markers |
| --- | --- | --- | --- |
| `typescript` | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | `tsc --lsp --stdio` (project-local TypeScript 7+ only), `typescript-language-server --stdio` | `tsconfig.json`, `jsconfig.json`, `package.json` |
| `python` | `.py`, `.pyi` | `basedpyright-langserver --stdio`, `pyright-langserver --stdio`, `pylsp` | `pyrightconfig.json`, `pyproject.toml`, `setup.py`, `.git` |
| `rust` | `.rs` | `rust-analyzer` | `Cargo.toml` |
| `go` | `.go` | `gopls` | `go.work`, `go.mod` |
| `clangd` | `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, `.hxx` | `clangd` | `compile_commands.json`, `.clangd`, `CMakeLists.txt`, `.git` |

Each server runs once per workspace root: the outermost directory, up to and
including the session's working directory, that contains a root marker, so the
packages of a monorepo share one server. Without a marker the working directory
is the root.

## Installing language servers

Install only the servers for languages you edit; files without an installed
server are skipped silently. After installing, run `/reload` (or start a new
session), because a missing executable is remembered for the rest of the
session.

| Language | Install | Notes |
| --- | --- | --- |
| TypeScript / JavaScript (TypeScript 7+) | `npm install --save-dev typescript@7` | Uses the project's own `node_modules/.bin/tsc --lsp --stdio`; no extra server needed. |
| TypeScript / JavaScript (TypeScript 6.x and earlier) | `npm install -g typescript-language-server typescript@6` | Uses the project's own `typescript` when present, otherwise the global one, so pin the global install below 7. `typescript-language-server` cannot load TypeScript 7 (it reports a missing `tsserver.js`). |
| Python | `uv tool install basedpyright` | Alternatives: `pipx install pyright` (`pyright-langserver`) or `pipx install python-lsp-server` (`pylsp`). |
| Rust | `rustup component add rust-analyzer` | |
| Go | `go install golang.org/x/tools/gopls@latest` | Ensure `$(go env GOPATH)/bin` is on `PATH`. |
| C / C++ | `uv tool install clangd` (no root needed), `sudo apt install clangd`, or `brew install llvm` | Needs `compile_commands.json` (for example `cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`) for accurate results. |

Verify an installation with `<command> --version` (for example
`rust-analyzer --version`), then run `lsp({ action: "diagnostics", path: "<file>" })`:
a missing server is reported with the commands that were tried.
To use a server not listed here, add it under `servers` in `lsp.json` (see
below).

## Configuration

Optional user configuration lives in `~/.pi/agent/lsp.json` (honoring
`PI_CODING_AGENT_DIR`):

```json
{
  "diagnosticsOnEdit": true,
  "requestTimeoutSeconds": 15,
  "servers": {
    "rust": false,
    "zig": {
      "command": "zls",
      "args": [],
      "extensions": [".zig"],
      "rootMarkers": ["build.zig", ".git"],
      "languageId": "zig"
    }
  }
}
```

- `diagnosticsOnEdit: false` turns off the diagnostics after edits; the `lsp`
  tool keeps working.
- `requestTimeoutSeconds` bounds each request to a server, including startup.
- `servers` disables a built-in server (`false`) or defines one. Server
  commands are read from this file only, never from the repository.
- An invalid file is reported once when the session starts, naming the first
  offending field (for example `/servers/zig/command: must match pattern "\S"`).
  Edits then stay silent, and `lsp` calls and `/lsp` report the error until the
  file is fixed and the session reloads.

## Boundaries

- **Trust:** language servers can load type checkers, plugins, procedural
  macros, and build scripts from the workspace, so they do not run in untrusted
  projects at all.
- **Session directory:** servers only run for files inside the session's
  working directory. Symbolic links are resolved first, for the directory and
  for every path, so a link inside it that points outside is outside, and the
  workspace root never lies above it. Paths are read like those of Pi's
  built-in file tools (`@` prefix, `~`, `file://` URLs).
- **Processes:** a server that is not installed or fails to start is not tried
  again in the session (`/reload` after installing or fixing it). Session
  shutdown aborts servers that are still starting, asks running ones to exit,
  and then ends whatever remains of each server's process group, including
  workers that outlive the server process.

## Known limitations

- **Diagnostics after an edit can be missing.** They are dropped when the
  server does not answer within 0.8s: sometimes on the first edit of a session
  while the server starts, and on servers that take longer to analyze (for
  example when diagnostics come from a build). Use `lsp diagnostics` or the
  project's compiler to check.
- **Only the file being edited or queried is synced.** A server learns about
  that file's new contents and nothing else. Files changed through `bash` (for
  example `git checkout`, formatters, or code generation) keep their old
  contents in the server until they are edited or queried themselves, which can
  make diagnostics for files that depend on them outdated.
- **Push reports without versions cannot be told apart.** When a file changes
  while a push server that omits versions is about to publish the report for
  its previous contents, that report is taken as current until the server's
  next report replaces it a moment later. None of the servers exercised below
  is affected: they use pull, tsserver's synchronous diagnostics, or versioned
  reports.
- **Servers run until the session ends;** there is no limit on their number and
  no idle shutdown.
- **Platforms:** verified on Linux only. Windows is not supported: `.cmd` /
  `.exe` launchers are not resolved, and server shutdown relies on POSIX
  process groups.

## Compatibility

Developed against Pi `1.5.2` with Node `>=22.19.0`. Checks, tests, package
discovery, extension loading, post-edit diagnostics, and `lsp` tool execution
have been verified on **Node 22.19.0, Node 24.21.0, and Node 26.13.1 with Pi
1.5.2 on Linux**. Diagnostics and navigation were exercised against
`typescript-language-server` 6.1.0 (TypeScript 6.0.3), TypeScript 7.0.2
`tsc --lsp`, basedpyright 1.40.2, and clangd 22.1.1; `rust-analyzer`, `gopls`,
and the other Python servers are configured but have not been exercised.
