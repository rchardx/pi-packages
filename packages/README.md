# Packages

Each direct child directory is an independently owned Pi package and an npm workspace.

See the [root package index](../README.md#packages-installation-and-usage) for
available packages, installation commands, and usage examples.

- [ask](ask/README.md): structured multiple-choice user clarification in interactive and RPC sessions.
- [lsp](lsp/README.md): Language Server Protocol post-edit diagnostics and read-only code navigation.
- [web-access](web-access/README.md): fetch pages and optionally search the web.
- [background](background/README.md): background shell commands and completion notifications.
- [subagents](subagents/README.md): background development tasks in child Pi processes.
- [statusline](statusline/README.md): two-line interactive footer with inline extension statuses.

Create a directory only when it contains a working capability; do not add empty
extensions, skills, prompts, or themes in advance. See the
[package rules](../AGENTS.md#package-boundaries) before adding a package.
