import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, stripTerminalSequences, Text, TruncatedText } from "@earendil-works/pi-tui";
import { bounded, isResult, record, type Result, type Status } from "./protocol.ts";

export const NOTIFICATION_TYPE = "subagent:result";

const TASK_DISPLAY_CHARS = 80;

export interface ResultDetails extends Result {
  id: string;
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

/** Single-line, length-capped task summary for collapsed cards. */
export function oneLine(task: string, max = TASK_DISPLAY_CHARS): string {
  const flat = sanitizeDisplayText(task).trim().split("\n").join(" ⏎ ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function statusPhrase(status: Status): string {
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
    typeof value.task === "string" &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0
  );
}

export function buildNotification(
  child: { id: string; task: string; startedAt: number },
  result: Result,
  now = Date.now(),
): { content: string; details: ResultDetails } {
  const durationMs = Math.max(0, now - child.startedAt);
  const content =
    `Subagent ${child.id}: ${result.status}\n` +
    `Task: ${bounded(child.task, 512)}\n` +
    `Duration: ${Math.round(durationMs / 1000)}s; requests: ${result.requests}; tokens: ${result.tokens}\n\n` +
    result.report;
  return {
    content,
    details: {
      id: child.id,
      task: oneLine(child.task),
      durationMs,
      ...result,
    },
  };
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
  const label = `subagent ${details.id.slice(0, 8)}`;
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
    if (report) box.addChild(new Text(theme.fg("muted", report), 0, 0));
  }
  return box;
}
