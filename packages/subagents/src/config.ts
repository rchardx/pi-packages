import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DEADLINE_MS,
  isRoleName,
  MANAGEMENT_TOOLS,
  MAX_CONCURRENT,
  MAX_REQUESTS,
  MAX_ROLE_DESCRIPTION_BYTES,
  MAX_ROLE_INSTRUCTIONS_BYTES,
  MAX_ROLE_TOOLS,
  record,
} from "./protocol.ts";

export const DEFAULT_MAX_CONCURRENT = MAX_CONCURRENT;
export const DEFAULT_MAX_REQUESTS = MAX_REQUESTS;
export const DEFAULT_DEADLINE_SECONDS = DEADLINE_MS / 1000;
/** setTimeout's maximum delay in seconds; larger deadlines cannot be represented. */
export const MAX_DEADLINE_SECONDS = 2_147_483;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type RoleThinkingLevel = (typeof THINKING_LEVELS)[number];
const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);

function isRoleThinkingLevel(value: unknown): value is RoleThinkingLevel {
  return typeof value === "string" && THINKING_LEVEL_SET.has(value);
}

const ALLOWED_KEYS = new Set(["maxConcurrent", "maxRequests", "deadlineSeconds", "roles"]);
const ALLOWED_ROLE_KEYS = new Set([
  "description",
  "provider",
  "model",
  "thinking",
  "tools",
  "instructions",
  "maxRequests",
  "deadlineSeconds",
]);

export interface RoleConfig {
  /** One-line summary advertised to the parent model when selecting roles. */
  description?: string;
  /** Provider ID override, configured together with `model`. */
  provider?: string;
  /** Model ID override, configured together with `provider`. */
  model?: string;
  /** Thinking level override for this role. */
  thinking?: RoleThinkingLevel;
  /**
   * Tool selection following Pi's `--tools` / `defaultTools` rules:
   * plain names replace the inherited selection (`[]` disables all tools);
   * `+name` / `-name` entries modify the inherited selection in order.
   */
  tools?: string[];
  /** Role-specific instructions appended to the child's system prompt. */
  instructions?: string;
  /** Per-child admitted model turn limit override. */
  maxRequests?: number;
  /** Per-child total execution deadline override in seconds, including startup. */
  deadlineSeconds?: number;
}

export interface SubagentsConfig {
  /** Maximum number of subagents running concurrently in a root session. */
  maxConcurrent: number;
  /** Maximum admitted model turns per child execution. */
  maxRequests: number;
  /** Total execution deadline per child in seconds, including startup. */
  deadlineSeconds: number;
  /** Active subagent role presets (built-in defaults merged with user configuration). */
  roles: Record<string, RoleConfig>;
}

export const BUILTIN_ROLES: Readonly<Record<string, RoleConfig>> = {
  explorer: {
    description: "Read-only local codebase search and navigation.",
    tools: ["read", "grep", "find", "ls"],
    instructions:
      "Explore the local codebase without modifying files. Prefer targeted grep, find, ls, and read calls over broad scans, and cite exact file paths and line numbers.",
  },
  librarian: {
    description: "Find documentation and reference material. No local edits or shell commands.",
    tools: ["+grep", "+find", "+ls", "-edit", "-write", "-bash", "-powershell"],
    instructions:
      "Find documentation, web sources, and reference code relevant to the task. Cite source URLs or exact file paths. Do not modify local files or run shell commands.",
  },
};

export function defaultRoles(): Record<string, RoleConfig> {
  return Object.fromEntries(
    Object.entries(BUILTIN_ROLES).map(([name, role]) => [
      name,
      { ...role, ...(role.tools ? { tools: [...role.tools] } : {}) },
    ]),
  );
}

export function isToolModifier(entry: string): boolean {
  return entry.startsWith("+") || entry.startsWith("-");
}

function parseMaxRequests(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function parseDeadlineSeconds(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_DEADLINE_SECONDS
  ) {
    throw new Error(
      `${label} must be a positive number of seconds at most ${MAX_DEADLINE_SECONDS}.`,
    );
  }
  return value;
}

function parseRoleTools(roleName: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ROLE_TOOLS) {
    throw new Error(
      `Role "${roleName}" tools must be an array of at most ${MAX_ROLE_TOOLS} entries.`,
    );
  }
  const entries: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || /[\s,\p{Cc}]/u.test(item)) {
      throw new Error(
        `Role "${roleName}" tools entries must be nonempty strings without whitespace, commas, or control characters.`,
      );
    }
    if (item.includes("*")) {
      throw new Error(`Role "${roleName}" tools entries take exact tool names, not * patterns.`);
    }
    const modifier = isToolModifier(item);
    const target = modifier ? item.slice(1) : item;
    if (!target) {
      throw new Error(`Role "${roleName}" has an empty tool modifier "${item}".`);
    }
    if (!item.startsWith("-") && MANAGEMENT_TOOLS.has(target)) {
      throw new Error(
        `Role "${roleName}" cannot enable root-session tools (subagent, subagent_cancel, subagent_list).`,
      );
    }
    entries.push(item);
  }
  const modifierCount = entries.filter(isToolModifier).length;
  if (modifierCount > 0 && modifierCount < entries.length) {
    throw new Error(
      `Role "${roleName}" tools cannot mix plain tool names with +name or -name modifiers.`,
    );
  }
  return modifierCount > 0 ? entries : [...new Set(entries)];
}

function parseRoleConfig(roleName: string, value: unknown): RoleConfig {
  if (!record(value)) {
    throw new Error(`Role "${roleName}" must be a JSON object or false.`);
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_ROLE_KEYS.has(key)) {
      throw new Error(
        `Unknown field "${key}" in role "${roleName}"; supported fields are description, provider, model, thinking, tools, instructions, maxRequests, and deadlineSeconds.`,
      );
    }
  }
  const role: RoleConfig = {};

  if ("description" in value && value.description !== undefined) {
    if (typeof value.description !== "string") {
      throw new Error(`Role "${roleName}" description must be a string.`);
    }
    const description = value.description.trim();
    if (
      !description ||
      /[\p{Cc}]/u.test(description) ||
      Buffer.byteLength(description) > MAX_ROLE_DESCRIPTION_BYTES
    ) {
      throw new Error(
        `Role "${roleName}" description must be a single-line nonempty string of at most ${MAX_ROLE_DESCRIPTION_BYTES} bytes without control characters.`,
      );
    }
    role.description = description;
  }

  const hasProvider = "provider" in value && value.provider !== undefined;
  const hasModel = "model" in value && value.model !== undefined;
  if (hasProvider !== hasModel) {
    throw new Error(`Role "${roleName}" must specify provider and model together.`);
  }
  if (hasProvider && hasModel) {
    if (typeof value.provider !== "string" || typeof value.model !== "string") {
      throw new Error(`Role "${roleName}" provider and model must be strings.`);
    }
    const provider = value.provider.trim();
    const model = value.model.trim();
    if (!provider || !model || /[\s\p{Cc}]/u.test(provider) || /[\p{Cc}]/u.test(model)) {
      throw new Error(
        `Role "${roleName}" provider and model must be nonempty without control characters.`,
      );
    }
    role.provider = provider;
    role.model = model;
  }

  if ("thinking" in value && value.thinking !== undefined) {
    if (!isRoleThinkingLevel(value.thinking)) {
      throw new Error(`Role "${roleName}" thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
    }
    role.thinking = value.thinking;
  }

  if ("tools" in value && value.tools !== undefined) {
    role.tools = parseRoleTools(roleName, value.tools);
  }

  if ("instructions" in value && value.instructions !== undefined) {
    if (typeof value.instructions !== "string") {
      throw new Error(`Role "${roleName}" instructions must be a string.`);
    }
    const instructions = value.instructions.trim();
    if (!instructions || Buffer.byteLength(instructions) > MAX_ROLE_INSTRUCTIONS_BYTES) {
      throw new Error(
        `Role "${roleName}" instructions must be nonempty and at most ${MAX_ROLE_INSTRUCTIONS_BYTES} bytes.`,
      );
    }
    role.instructions = instructions;
  }

  if ("maxRequests" in value && value.maxRequests !== undefined) {
    role.maxRequests = parseMaxRequests(value.maxRequests, `Role "${roleName}" maxRequests`);
  }

  if ("deadlineSeconds" in value && value.deadlineSeconds !== undefined) {
    role.deadlineSeconds = parseDeadlineSeconds(
      value.deadlineSeconds,
      `Role "${roleName}" deadlineSeconds`,
    );
  }

  return role;
}

function parseRoles(value: unknown): Record<string, RoleConfig> {
  if (!record(value)) {
    throw new Error(
      "roles must be a JSON object mapping role names to role configurations or false.",
    );
  }
  // Inspect raw own property names as well so JSON {"__proto__": ...} is never ignored.
  for (const name of Object.getOwnPropertyNames(value)) {
    if (!isRoleName(name)) {
      throw new Error(
        `Invalid role name "${name}"; expected 1-64 ASCII letters, digits, hyphens, or underscores starting with a letter or digit.`,
      );
    }
  }
  const roles = defaultRoles();
  for (const [name, entry] of Object.entries(value)) {
    if (entry === false) {
      delete roles[name];
      continue;
    }
    const parsed = parseRoleConfig(name, entry);
    const existing = Object.hasOwn(roles, name) ? roles[name] : undefined;
    roles[name] = existing ? { ...existing, ...parsed } : parsed;
  }
  return roles;
}

export function parseConfig(value: unknown): SubagentsConfig {
  if (!record(value)) {
    throw new Error("Expected a JSON object.");
  }
  if (Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new Error(
      "Unknown configuration field; only maxConcurrent, maxRequests, deadlineSeconds, and roles are supported.",
    );
  }
  const maxConcurrent = "maxConcurrent" in value ? value.maxConcurrent : DEFAULT_MAX_CONCURRENT;
  if (typeof maxConcurrent !== "number" || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive integer.");
  }
  const maxRequests =
    "maxRequests" in value
      ? parseMaxRequests(value.maxRequests, "maxRequests")
      : DEFAULT_MAX_REQUESTS;
  const deadlineSeconds =
    "deadlineSeconds" in value
      ? parseDeadlineSeconds(value.deadlineSeconds, "deadlineSeconds")
      : DEFAULT_DEADLINE_SECONDS;
  const roles =
    "roles" in value && value.roles !== undefined ? parseRoles(value.roles) : defaultRoles();
  return { maxConcurrent, maxRequests, deadlineSeconds, roles };
}

export function resolveRole(
  config: SubagentsConfig,
  rawRole: string | undefined,
): { name: string; config: RoleConfig } | undefined {
  if (rawRole === undefined) return undefined;
  const name = rawRole.trim();
  if (!name) throw new Error("Role name must be nonempty when provided.");
  if (!Object.hasOwn(config.roles, name)) {
    const available = Object.keys(config.roles);
    throw new Error(
      available.length > 0
        ? `Unknown subagent role "${name}". Configured roles: ${available.join(", ")}.`
        : `Unknown subagent role "${name}". No roles are configured.`,
    );
  }
  const roleConfig = config.roles[name];
  if (!roleConfig) throw new Error(`Unknown subagent role "${name}".`);
  return { name, config: roleConfig };
}

export function formatRolesPrompt(roles: Record<string, RoleConfig>): string | undefined {
  const entries = Object.entries(roles);
  if (entries.length === 0) return undefined;
  const lines = entries.map(([name, role]) => {
    const meta: string[] = [];
    if (role.provider && role.model) meta.push(`${role.provider}/${role.model}`);
    if (role.thinking) meta.push(`thinking: ${role.thinking}`);
    if (role.tools !== undefined) {
      meta.push(role.tools.length === 0 ? "tools: none" : `tools: ${role.tools.join(", ")}`);
    }
    const metaPart = meta.length > 0 ? ` (${meta.join("; ")})` : "";
    const descPart = role.description ? `: ${role.description}` : "";
    return `- ${name}${metaPart}${descPart}`;
  });
  return (
    "Configured subagent roles (pass `role` to `subagent`, or omit `role` for a general-purpose child):\n" +
    lines.join("\n")
  );
}

// User configuration only, re-read per launch so edits apply without a reload.
export async function loadConfig(
  path = join(getAgentDir(), "subagents.json"),
): Promise<SubagentsConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        maxConcurrent: DEFAULT_MAX_CONCURRENT,
        maxRequests: DEFAULT_MAX_REQUESTS,
        deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
        roles: defaultRoles(),
      };
    }
    throw new Error(`Cannot read subagents configuration: ${path}`, { cause: error });
  }
  try {
    const value: unknown = JSON.parse(source);
    return parseConfig(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid subagents configuration (${path}): ${message}`, { cause: error });
  }
}
