import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Markdown,
  Spacer,
  stripTerminalSequences,
  Text,
  TruncatedText,
} from "@earendil-works/pi-tui";
import {
  bounded,
  isMessageEnvelope,
  isResult,
  isRoleName,
  MAIN_AGENT_ID,
  type MessageEnvelope,
  record,
  type Result,
  type Status,
} from "./protocol.ts";

export { MESSAGE_TYPE } from "./protocol.ts";
export const NOTIFICATION_TYPE = "subagent:result";

const TASK_DISPLAY_CHARS = 80;

export interface ResultDetails extends Result {
  id: string;
  role?: string;
  task: string;
  durationMs: number;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** Strip terminal escape sequences and control characters before TUI display. */
export function sanitizeDisplayText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\p{Cc}]/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    );
}

/** Single-line, length-capped summary for collapsed cards and subagent listings. */
export function oneLine(text: string, max = TASK_DISPLAY_CHARS): string {
  const flat = sanitizeDisplayText(text).trim().split("\n").join(" ⏎ ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export type ToolActivityState = "running" | "ok" | "error";

const PATH_TOOLS = new Set(["read", "write", "edit", "ls"]);
const SEARCH_TOOLS = new Set(["grep", "find"]);

/**
 * Single-line summary of a tool call, kept short for the parent: the path or search
 * pattern of a file tool and the first line of a shell command. Other tools are named only.
 */
export function summarizeToolCall(toolName: string, args: unknown): string {
  const name = oneLine(toolName, 64);
  if (!record(args)) return name;
  const path = typeof args.path === "string" && args.path.trim() ? oneLine(args.path, 120) : "";
  if (PATH_TOOLS.has(toolName)) return path ? `${name} ${path}` : name;
  if (SEARCH_TOOLS.has(toolName) && typeof args.pattern === "string" && args.pattern.trim()) {
    return `${name} ${oneLine(args.pattern, 60)}${path ? ` in ${path}` : ""}`;
  }
  if (toolName === "bash" && typeof args.command === "string" && args.command.trim()) {
    return `${name} ${oneLine(args.command.trim().split("\n", 1)[0] ?? "", 80)}`;
  }
  return name;
}

export function formatPartialProgress(
  lastAssistantText: string | undefined,
  activity: readonly { summary: string; state: ToolActivityState }[],
  totalToolCalls: number,
): string | undefined {
  const sections: string[] = [];
  if (lastAssistantText) {
    sections.push(`Last assistant message:\n${lastAssistantText}`);
  }
  if (activity.length > 0) {
    const heading =
      totalToolCalls > activity.length
        ? `Recent tool activity (last ${activity.length} of ${totalToolCalls}):`
        : "Recent tool activity:";
    const lines = activity.map((entry) => {
      const suffix =
        entry.state === "error" ? " (error)" : entry.state === "running" ? " (interrupted)" : "";
      return `- ${entry.summary}${suffix}`;
    });
    sections.push(`${heading}\n${lines.join("\n")}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

export function statusPhrase(status: Status): string {
  switch (status) {
    case "timed_out":
      return "timed out";
    case "limit_reached":
      return "limit reached";
    default:
      return status;
  }
}

function isResultDetails(value: unknown): value is ResultDetails {
  return (
    isResult(value) &&
    record(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.role === undefined || isRoleName(value.role)) &&
    typeof value.task === "string" &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0
  );
}

export function buildNotification(
  child: { id: string; role?: string; task: string; startedAt: number },
  result: Result,
  now = Date.now(),
): { content: string; details: ResultDetails } {
  const durationMs = Math.max(0, now - child.startedAt);
  const roleTag = child.role ? ` (${child.role})` : "";
  const content =
    `Subagent ${child.id}${roleTag}: ${result.status}\n` +
    `Task: ${bounded(child.task, 512)}\n` +
    `Duration: ${Math.round(durationMs / 1000)}s; requests: ${result.requests}; tokens: ${result.tokens}\n\n` +
    result.report;
  return {
    content,
    details: {
      id: child.id,
      ...(child.role ? { role: child.role } : {}),
      task: oneLine(child.task),
      durationMs,
      ...result,
    },
  };
}

export function formatMessage(envelope: MessageEnvelope): string {
  const sender = envelope.from === MAIN_AGENT_ID ? MAIN_AGENT_ID : `subagent ${envelope.from}`;
  return `Message from ${sender}:\n\n${envelope.message}`;
}

/** Collapsed one-line card; expanded view adds full ID, usage counts, and report. */
export function renderNotification(
  message: { details?: unknown },
  options: { expanded: boolean; outputPad: number },
  theme: Pick<Theme, "bg" | "fg" | "bold">,
) {
  const details = message.details;
  if (!isResultDetails(details)) return undefined;
  const succeeded = details.status === "completed";
  const icon = succeeded ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const label = details.role
    ? `subagent ${details.id.slice(0, 8)} (${sanitizeDisplayText(details.role)})`
    : `subagent ${details.id.slice(0, 8)}`;
  const summary = `${statusPhrase(details.status)} · ${formatDuration(details.durationMs)}`;
  const task = sanitizeDisplayText(details.task).replaceAll("\n", " ");
  const headline = `${icon} ${theme.bold(label)} · ${summary} · ${task}`;
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(options.expanded ? new Text(headline, 0, 0) : new TruncatedText(headline, 0, 0));
  if (options.expanded) {
    const requestLabel = details.requests === 1 ? "1 request" : `${details.requests} requests`;
    box.addChild(
      new Text(theme.fg("dim", `${details.id} · ${requestLabel} · ${details.tokens} tokens`), 0, 0),
    );
    const report = sanitizeDisplayText(details.report).trim();
    if (report) {
      box.addChild(new Spacer(1));
      box.addChild(new Markdown(report, 0, 0, getMarkdownTheme()));
    }
  }
  return box;
}

/** Collapsed one-line message card; expanded view reveals full endpoints and Markdown body. */
export function renderMessageNotification(
  message: { details?: unknown },
  options: { expanded: boolean; outputPad: number },
  theme: Pick<Theme, "bg" | "fg" | "bold">,
) {
  const details = message.details;
  if (!isMessageEnvelope(details)) return undefined;
  const senderLabel =
    details.from === MAIN_AGENT_ID ? MAIN_AGENT_ID : `subagent ${details.from.slice(0, 8)}`;
  const sender = `${theme.fg("accent", "✉")} ${theme.bold(senderLabel)}`;
  const headline = options.expanded ? sender : `${sender} · ${oneLine(details.message)}`;
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(options.expanded ? new Text(headline, 0, 0) : new TruncatedText(headline, 0, 0));
  if (options.expanded) {
    box.addChild(new Text(theme.fg("dim", `${details.from} → ${details.to}`), 0, 0));
    const body = sanitizeDisplayText(details.message).trim();
    if (body) {
      box.addChild(new Spacer(1));
      box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
    }
  }
  return box;
}
