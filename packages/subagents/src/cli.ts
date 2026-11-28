import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "@earendil-works/pi-coding-agent";

function stripAgentDirArgs(argv: readonly string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === "--agent-dir") {
      i++;
      continue;
    }
    rest.push(arg);
  }
  return rest;
}

/** Project only supported launch inputs, using Pi's parser (including its `--` boundary). */
export function parentOptions(argv: string[], cwd: string) {
  const args = parseArgs(stripAgentDirArgs(argv));
  if (args.apiKey !== undefined) {
    throw new Error(
      "A command-line API-key override cannot be transferred safely. Configure model access in Pi before delegation.",
    );
  }
  const flags: string[] = [];
  if (args.noExtensions) flags.push("--no-extensions");
  if (args.noMcp) flags.push("--no-mcp");
  if (args.offline) flags.push("--offline");
  if (args.noSkills) flags.push("--no-skills");
  if (args.noContextFiles) flags.push("--no-context-files");
  if (args.excludeTools?.length) flags.push("--exclude-tools", args.excludeTools.join(","));
  // These are explicit CLI inputs, not the parent's rendered/hook-modified prompt.
  // Pi interprets existing files as prompt files; fix their base before changing cwd.
  const promptInput = (value: string) => {
    if (!value) return value;
    const path = resolve(cwd, value);
    return existsSync(path) ? path : value;
  };
  if (args.systemPrompt !== undefined)
    flags.push("--system-prompt", promptInput(args.systemPrompt));
  for (const value of args.appendSystemPrompt ?? [])
    flags.push("--append-system-prompt", promptInput(value));
  // Let Pi interpret ALL extension source formats. Resolving arbitrary tokens as
  // filesystem paths corrupts npm:, Git URLs, and shorthand package sources.
  return {
    extensions: args.extensions ?? [],
    noExtensions: args.noExtensions === true,
    noMcp: args.noMcp === true,
    flags,
  };
}
