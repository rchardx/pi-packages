export const CHILD_ENV = "PI_SUBAGENTS_CHILD";
export const MAX_TASK_BYTES = 32 * 1024;
export const MAX_REPORT_BYTES = 32 * 1024;
export const MAX_CONCURRENT = 8;
export const MAX_REQUESTS = 64;
export const STARTUP_MS = 90_000;
export const DEADLINE_MS = 30 * 60_000;
export const STOP_GRACE_MS = 2_000;
export const MAX_TERMINAL_RECORDS = 256;

export type Status = "completed" | "failed" | "cancelled" | "timed_out" | "limit_reached";
export interface Result {
  status: Status;
  report: string;
  requests: number;
  tokens: number;
}
export interface Launch {
  cwd: string;
  provider: string;
  model: string;
  modelConfig?: { api: string; baseUrl: string };
  thinking: string;
  trusted: boolean;
  extensions: string[];
  /** Direct model exposure, restored after the CLI registers the allowed tools. */
  activeTools: string[];
  /** Complete required capability set, including active and indirectly callable tools. */
  requiredTools: string[];
  cliFlags?: string[];
  maxRequests?: number;
  deadlineMs?: number;
  task: string;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isResult(value: unknown): value is Result {
  return (
    record(value) &&
    ["completed", "failed", "cancelled", "timed_out", "limit_reached"].includes(
      String(value.status),
    ) &&
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

export function bounded(text: string, bytes = MAX_REPORT_BYTES): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const suffix = "\n[truncated]";
  const buffer = Buffer.from(text);
  let end = bytes - Buffer.byteLength(suffix);
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8") + suffix;
}

export const CHILD_INSTRUCTIONS = `You are a child agent executing a delegated task with fresh conversation context.
Use the task and project files to understand the work. Follow applicable instructions and permission boundaries.
Complete the task with the available tools. Stay within scope and preserve unrelated changes.
The working directory is shared with the parent and other agents. Changes are not rolled back.
Do not delegate work or launch agent processes. You cannot ask the parent questions during execution.
If a necessary decision or permission is missing, report the blocker instead of expanding your authority.
Finish with a concise report of work completed, files changed, validation actually performed, and remaining issues.`;
