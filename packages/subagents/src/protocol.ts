export const CHILD_ENV = "PI_SUBAGENTS_CHILD";
export const MAIN_AGENT_ID = "main";
export const MESSAGE_TYPE = "subagent:message";

/** Registered in the root session only; a child can neither inherit nor be granted them. */
export const MANAGEMENT_TOOLS = new Set(["subagent", "subagent_cancel", "subagent_list"]);
/** Registered on both sides: the root session messages its children, a child its parent. */
export const COMMUNICATION_TOOLS = new Set(["subagent_send", "subagent_wait"]);
export const ROLE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const MAX_TASK_BYTES = 32 * 1024;
export const MAX_REPORT_BYTES = 32 * 1024;
export const MAX_PARTIAL_TEXT_BYTES = 8 * 1024;
/** Room for the last assistant message plus the recent tool activity lines. */
export const MAX_PROGRESS_BYTES = 16 * 1024;
export const MAX_HEADLINE_BYTES = 8 * 1024;
export const MAX_ACTIVITY_ENTRIES = 8;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_ROLE_DESCRIPTION_BYTES = 512;
export const MAX_ROLE_INSTRUCTIONS_BYTES = 16 * 1024;
export const MAX_ROLE_TOOLS = 128;
export const MAX_INBOX_MESSAGES = 32;
export const MAX_CONCURRENT = 8;
export const MAX_REQUESTS = 64;
export const STARTUP_MS = 90_000;
export const DEADLINE_MS = 30 * 60_000;
export const STOP_GRACE_MS = 2_000;
export const DEFAULT_WAIT_SECONDS = 120;
export const MAX_WAIT_SECONDS = 300;
/** The root session may wait as long as Pi keeps its prompt cache warm during a run. */
export const MAX_ROOT_WAIT_SECONDS = 3600;
export const WAIT_COALESCE_MS = 25;
export const MAX_TERMINAL_RECORDS = 256;

const STATUSES = ["completed", "failed", "cancelled", "timed_out", "limit_reached"] as const;
export type Status = (typeof STATUSES)[number];

export interface Result {
  status: Status;
  report: string;
  requests: number;
  tokens: number;
}

export interface Progress {
  requests: number;
  tokens: number;
  partial?: string;
}

export interface Launch {
  id?: string;
  role?: string;
  instructions?: string;
  cwd: string;
  provider: string;
  model: string;
  modelConfig?: { api: string; baseUrl: string };
  thinking?: string;
  trusted: boolean;
  extensions: string[];
  /** Direct model exposure, restored after the CLI registers the allowed tools. */
  activeTools: string[];
  /** Active and indirectly callable tools that must be registered before the first prompt. */
  requiredTools: string[];
  /** Built-in MCP tools: allowed, but registered whenever the child's own servers connect. */
  mcpTools: string[];
  cliFlags?: string[];
  maxRequests?: number;
  deadlineMs?: number;
  task: string;
}

export interface MessageEnvelope {
  id: string;
  from: string;
  to: string;
  message: string;
}

export interface RunningAgent {
  id: string;
  role?: string;
  elapsedMs: number;
  task: string;
}

export type DeliveryAck =
  | { accepted: true }
  | { accepted: false; reason: "finished" | "queue_full" };

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isResult(value: unknown): value is Result {
  return (
    record(value) &&
    STATUSES.some((status) => status === value.status) &&
    typeof value.report === "string" &&
    Buffer.byteLength(value.report) <= MAX_REPORT_BYTES &&
    typeof value.requests === "number" &&
    Number.isFinite(value.requests) &&
    value.requests >= 0 &&
    typeof value.tokens === "number" &&
    Number.isFinite(value.tokens) &&
    value.tokens >= 0
  );
}

export function isProgress(value: unknown): value is Progress {
  return (
    record(value) &&
    typeof value.requests === "number" &&
    Number.isFinite(value.requests) &&
    value.requests >= 0 &&
    typeof value.tokens === "number" &&
    Number.isFinite(value.tokens) &&
    value.tokens >= 0 &&
    (value.partial === undefined ||
      (typeof value.partial === "string" &&
        value.partial.trim().length > 0 &&
        Buffer.byteLength(value.partial) <= MAX_PROGRESS_BYTES))
  );
}

export function isMessageEnvelope(value: unknown): value is MessageEnvelope {
  return (
    record(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.from === "string" &&
    value.from.length > 0 &&
    typeof value.to === "string" &&
    value.to.length > 0 &&
    typeof value.message === "string" &&
    value.message.trim().length > 0 &&
    Buffer.byteLength(value.message) <= MAX_MESSAGE_BYTES
  );
}

export function isRoleName(value: unknown): value is string {
  return (
    typeof value === "string" && ROLE_NAME_PATTERN.test(value) && !RESERVED_OBJECT_KEYS.has(value)
  );
}

export function validateMessage(message: string): void {
  if (!message.trim() || Buffer.byteLength(message) > MAX_MESSAGE_BYTES) {
    throw new Error(`Message must be nonempty and at most ${MAX_MESSAGE_BYTES} bytes.`);
  }
}

export function validateWaitTimeout(
  timeoutSeconds: number | undefined,
  maxSeconds = MAX_WAIT_SECONDS,
): number {
  const seconds = timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxSeconds) {
    throw new Error(`timeoutSeconds must be greater than 0 and at most ${maxSeconds}.`);
  }
  return seconds;
}

export function bounded(text: string, bytes = MAX_REPORT_BYTES): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const suffix = "\n[truncated]";
  const buffer = Buffer.from(text);
  let end = bytes - Buffer.byteLength(suffix);
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8") + suffix;
}

/** With progress, each part has its own allowance, so a long error cannot crowd it out. */
export function formatIncompleteReport(headline: string, partial?: string): string {
  if (!partial) return bounded(headline);
  return `${bounded(headline, MAX_HEADLINE_BYTES)}\n\n${bounded(partial, MAX_PROGRESS_BYTES)}`;
}

export const CHILD_INSTRUCTIONS = `You are a child agent executing a delegated task with fresh conversation context.
Use the task and project files to understand the work. Follow applicable instructions and permission boundaries.
Complete the task with the available tools. Stay within scope and preserve unrelated changes.
The working directory is shared with the parent and other agents. Changes are not rolled back.
Do not delegate work or launch agent processes.
If a necessary decision or permission is missing and cannot be resolved, report the blocker instead of expanding your authority.
Finish with a concise report of work completed, files changed, validation actually performed, and remaining issues.`;

export function childInstructions(
  id: string,
  canCommunicate: boolean,
  role?: string,
  roleInstructions?: string,
): string {
  const lines = [CHILD_INSTRUCTIONS, `Your agent ID is ${id}.`];
  if (role) lines.push(`Your assigned role is ${role}.`);
  if (canCommunicate) {
    lines.push(
      `You can message the parent session ("main") with subagent_send. Messages from main supplement or correct your task.`,
      `Ending your turn without calling subagent_wait permanently completes your task and closes your agent; once completed, you never receive further messages. Call subagent_wait when you need a reply before finishing.`,
    );
  }
  const base = lines.join("\n");
  const extra = roleInstructions?.trim();
  if (!extra) return base;
  const heading = role ? `Role instructions (${role}):` : "Role instructions:";
  return `${base}\n\n${heading}\n${extra}`;
}
