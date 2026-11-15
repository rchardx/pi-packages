import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, TruncatedText } from "@earendil-works/pi-tui";
import { stripAnsi } from "./ansi.ts";
import { type JobRecord, LOG_OUTPUT_BYTES } from "./jobs.ts";
import type { JobOutcome } from "./operations.ts";

export type { JobOutcome } from "./operations.ts";

export const NOTIFICATION_TYPE = "bash-job:notification";

const TAIL_LINES = 20;
const TAIL_CHARS = 4000;
const COMMAND_DISPLAY_CHARS = 80;

export interface NotificationDetails {
  jobId: string;
  command: string;
  outcome: "completed" | "failed" | "aborted" | "timeout" | "error";
  exitCode?: number;
  durationMs: number;
  logPath?: string;
  tail: string;
  error?: string;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** Single-line, length-capped command form for notifications and the TUI. */
export function oneLine(command: string, max = COMMAND_DISPLAY_CHARS): string {
  const flat = command.trim().split(/\r?\n/u).join(" ⏎ ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Model/user-facing tail: ANSI stripped, bounded by lines and characters. */
export function tailText(rawText: string, maxLines = TAIL_LINES, maxChars = TAIL_CHARS): string {
  const lines = stripAnsi(rawText).replace(/\r\n?/gu, "\n").split("\n");
  let text = lines.slice(-maxLines).join("\n").trim();
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return text;
}

export function outcomeOf(outcome: JobOutcome): NotificationDetails["outcome"] {
  switch (outcome.kind) {
    case "exit":
      return outcome.exitCode === 0 ? "completed" : "failed";
    case "aborted":
      return "aborted";
    case "timeout":
      return "timeout";
    case "error":
      return "error";
  }
}

function outcomeSentence(outcome: JobOutcome, duration: string): string {
  switch (outcome.kind) {
    case "exit":
      return `exited with code ${outcome.exitCode} after ${duration}`;
    case "aborted":
      return `was aborted after ${duration}`;
    case "timeout":
      return `hit its ${outcome.seconds}s timeout and was killed`;
    case "error":
      return `ended with an error after ${duration}: ${outcome.message}`;
  }
}

function summaryPhrase(details: NotificationDetails): string {
  switch (details.outcome) {
    case "completed":
      return `exit 0 · ${formatDuration(details.durationMs)}`;
    case "failed":
      return `exit ${details.exitCode ?? "?"} · ${formatDuration(details.durationMs)}`;
    case "aborted":
      return `aborted · ${formatDuration(details.durationMs)}`;
    case "timeout":
      return `timed out · ${formatDuration(details.durationMs)}`;
    case "error":
      return "error";
  }
}

export function buildNotification(
  job: JobRecord,
  outcome: JobOutcome,
  durationMs: number,
): { content: string; details: NotificationDetails } {
  const tail = tailText(job.tail.text());
  const details: NotificationDetails = {
    jobId: job.id,
    command: oneLine(job.command),
    outcome: outcomeOf(outcome),
    durationMs,
    tail,
    ...(job.logPath ? { logPath: job.logPath } : {}),
    ...(outcome.kind === "exit" ? { exitCode: outcome.exitCode } : {}),
    ...(outcome.kind === "error" ? { error: outcome.message } : {}),
  };
  const succeeded = details.outcome === "completed";
  const icon = succeeded ? "✓" : "✗";
  const content =
    `${icon} Background job ${job.id} ${outcomeSentence(outcome, formatDuration(durationMs))}: ` +
    `\`${details.command}\`` +
    (tail ? `\n\nLast output:\n\`\`\`\n${tail}\n\`\`\`` : "") +
    (job.logPath
      ? `\n\nLog: ${job.logPath}` +
        (job.logBytes >= LOG_OUTPUT_BYTES
          ? `\nLog output limit reached (${LOG_OUTPUT_BYTES / (1024 * 1024)} MiB).`
          : "")
      : "");
  return { content, details };
}

/** Collapsed one-line card; expanded view adds the log path and output tail. */
export function renderNotification(
  message: { details?: NotificationDetails },
  options: { expanded: boolean; outputPad: number },
  theme: Pick<Theme, "bg" | "fg" | "bold">,
) {
  const details = message.details;
  if (!details) return undefined;
  const succeeded = details.outcome === "completed";
  const icon = succeeded ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  const headline = `${icon} ${theme.bold(details.jobId)} ${details.command} · ${summaryPhrase(details)}`;
  box.addChild(options.expanded ? new Text(headline, 0, 0) : new TruncatedText(headline, 0, 0));
  if (options.expanded) {
    if (details.logPath) box.addChild(new Text(theme.fg("dim", details.logPath), 0, 0));
    if (details.tail) box.addChild(new Text(theme.fg("muted", details.tail), 0, 0));
  }
  return box;
}
