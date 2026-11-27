import type {
  AgentToolResult,
  KeybindingHints,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Spacer,
  stripTerminalSequences,
  Text,
  TruncatedText,
} from "@earendil-works/pi-tui";
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

export interface CancelDetails {
  jobId: string;
  command: string;
  logPath?: string;
  tail: string;
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
  const headline = `${icon} ${theme.bold(details.jobId)} · ${summaryPhrase(details)} · ${details.command}`;
  box.addChild(options.expanded ? new Text(headline, 0, 0) : new TruncatedText(headline, 0, 0));
  if (options.expanded) {
    if (details.logPath) box.addChild(new Text(theme.fg("dim", details.logPath), 0, 0));
    if (details.tail) box.addChild(new Text(theme.fg("muted", details.tail), 0, 0));
  }
  return box;
}

function sanitizeDisplay(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\p{Cc}]/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    );
}

export function renderCancelCall(
  args: Partial<{ job_id: string }> | undefined,
  theme: Pick<Theme, "fg" | "bold">,
) {
  const id = typeof args?.job_id === "string" ? oneLine(sanitizeDisplay(args.job_id), 64) : "";
  return new TruncatedText(
    theme.fg("toolTitle", theme.bold("bash_cancel")) + (id ? `  ${theme.fg("muted", id)}` : ""),
    0,
    0,
  );
}

export function renderCancelResult(
  result: AgentToolResult<CancelDetails | undefined>,
  { expanded }: ToolRenderResultOptions,
  theme: Pick<Theme, "fg">,
  context: Pick<KeybindingHints, "keyHint"> & {
    isError: boolean;
    durationMs: number | undefined;
  },
) {
  if (context.isError || !result.details) {
    const text = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    return new Text(theme.fg("error", sanitizeDisplay(text)), 0, 0);
  }
  const { jobId, command, logPath, tail } = result.details;
  const cleanCommand = sanitizeDisplay(command);
  const cleanLogPath = logPath ? sanitizeDisplay(logPath) : "";
  const cleanTail = sanitizeDisplay(tail);
  const hasDetails = Boolean(cleanLogPath || cleanTail);
  const parts = [
    `Cancelled ${jobId}`,
    ...(context.durationMs !== undefined ? [`${(context.durationMs / 1000).toFixed(1)}s`] : []),
    cleanCommand,
    ...(hasDetails
      ? [context.keyHint("app.tools.expand", expanded ? "to collapse" : "to expand")]
      : []),
  ];
  const headline = theme.fg("dim", parts.join(" · "));
  if (!expanded) {
    return new TruncatedText(headline, 0, 0);
  }
  const view = new Container();
  view.addChild(new Text(headline, 0, 0));
  if (cleanLogPath) view.addChild(new Text(theme.fg("dim", cleanLogPath), 0, 0));
  if (cleanTail) {
    view.addChild(new Spacer(1));
    view.addChild(new Text(theme.fg("muted", cleanTail), 0, 0));
  }
  return view;
}
