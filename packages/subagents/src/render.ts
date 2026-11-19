import {
  type AgentToolResult,
  getMarkdownTheme,
  type KeybindingHints,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import type { WaitOutcome } from "./inbox.ts";
import { formatDuration, oneLine, sanitizeDisplayText, statusPhrase } from "./notify.ts";
import {
  BROADCAST_TARGET,
  type DeliveryReceipt,
  type LiveAgent,
  MAIN_AGENT_ID,
  type Result,
} from "./protocol.ts";

type RenderContext<TArgs = unknown> = KeybindingHints & {
  args: TArgs;
  isError: boolean;
  durationMs: number | undefined;
};

function errorText(result: AgentToolResult<unknown>, theme: Theme): Text {
  const text = result.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n");
  return new Text(theme.fg("error", sanitizeDisplayText(text)), 0, 0);
}

function durationPart(durationMs: number | undefined): string[] {
  return durationMs !== undefined ? [`${(durationMs / 1000).toFixed(1)}s`] : [];
}

function singleLine(text: string): string {
  return sanitizeDisplayText(text).replace(/\s+/gu, " ").trim();
}

export function renderSubagentCall(
  args: Partial<{ task: string; role: string }> | undefined,
  theme: Theme,
) {
  const role = typeof args?.role === "string" ? oneLine(args.role, 64) : "";
  const task = typeof args?.task === "string" ? singleLine(args.task) : "";
  const title =
    theme.fg("toolTitle", theme.bold("subagent")) +
    (role ? ` ${theme.fg("accent", `(${role})`)}` : "");
  return new TruncatedText(title + (task ? `  ${theme.fg("muted", task)}` : ""), 0, 0);
}

export function renderSubagentResult(
  result: AgentToolResult<{ id: string; role?: string }>,
  { expanded }: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext<{ task: string; role?: string }>,
) {
  if (context.isError) return errorText(result, theme);
  const { id } = result.details;
  const taskText = sanitizeDisplayText(context.args.task).trim();
  const metadata = [
    expanded ? `Started ${id}` : `Started ${id.slice(0, 8)}`,
    ...durationPart(context.durationMs),
    context.keyHint("app.tools.expand", expanded ? "to collapse" : "to expand"),
  ];
  const view = new Container();
  view.addChild(new Text(theme.fg("dim", metadata.join(" · ")), 0, 0));
  if (expanded && taskText) {
    view.addChild(new Spacer(1));
    view.addChild(new Markdown(taskText, 0, 0, getMarkdownTheme()));
  }
  return view;
}

export function renderCancelCall(args: Partial<{ id: string }> | undefined, theme: Theme) {
  const id = typeof args?.id === "string" ? oneLine(args.id, 64).slice(0, 8) : "";
  return new TruncatedText(
    theme.fg("toolTitle", theme.bold("subagent_cancel")) + (id ? `  ${theme.fg("muted", id)}` : ""),
    0,
    0,
  );
}

export function renderCancelResult(
  result: AgentToolResult<{ id: string } & Result>,
  { expanded }: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
) {
  if (context.isError) return errorText(result, theme);
  const { details } = result;
  const report = sanitizeDisplayText(details.report).trim();
  const requestLabel = details.requests === 1 ? "1 request" : `${details.requests} requests`;
  const metadata = [
    ...(expanded ? [details.id] : []),
    statusPhrase(details.status),
    requestLabel,
    `${details.tokens} tokens`,
    ...durationPart(context.durationMs),
    context.keyHint("app.tools.expand", expanded ? "to collapse" : "to expand"),
  ];
  const view = new Container();
  view.addChild(new Text(theme.fg("dim", metadata.join(" · ")), 0, 0));
  if (expanded && report) {
    view.addChild(new Spacer(1));
    view.addChild(new Markdown(report, 0, 0, getMarkdownTheme()));
  }
  return view;
}

export function renderListCall(_args: unknown, theme: Theme) {
  return new TruncatedText(theme.fg("toolTitle", theme.bold("subagent_list")), 0, 0);
}

export function renderListResult(
  result: AgentToolResult<{ agents: LiveAgent[] }>,
  { expanded }: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
) {
  if (context.isError) return errorText(result, theme);
  const { agents } = result.details;
  if (agents.length === 0) return new Text(theme.fg("dim", "No live agents"), 0, 0);
  const countLabel = agents.length === 1 ? "1 live agent" : `${agents.length} live agents`;
  const metadata = [
    countLabel,
    ...durationPart(context.durationMs),
    context.keyHint("app.tools.expand", expanded ? "to collapse" : "to expand"),
  ];
  const view = new Container();
  view.addChild(new Text(theme.fg("dim", metadata.join(" · ")), 0, 0));
  if (expanded) {
    view.addChild(new Spacer(1));
    for (const agent of agents) {
      const parts = [`- ${agent.id}${agent.self ? " (self)" : ""}`];
      if (agent.role) parts.push(agent.role);
      if (agent.elapsedMs !== undefined) parts.push(formatDuration(agent.elapsedMs));
      if (agent.task) parts.push(oneLine(agent.task, 120));
      view.addChild(new TruncatedText(theme.fg("muted", parts.join(" · ")), 0, 0));
    }
  }
  return view;
}

export function renderSendCall(
  args: Partial<{ to: string; message: string }> | undefined,
  theme: Theme,
) {
  const rawTo = typeof args?.to === "string" ? oneLine(args.to, 64) : "";
  const target = rawTo === MAIN_AGENT_ID || rawTo === BROADCAST_TARGET ? rawTo : rawTo.slice(0, 8);
  const preview = typeof args?.message === "string" ? singleLine(args.message) : "";
  const title =
    theme.fg("toolTitle", theme.bold("subagent_send")) +
    (target ? ` ${theme.fg("accent", `→ ${target}`)}` : "");
  return new TruncatedText(title + (preview ? `  ${theme.fg("muted", preview)}` : ""), 0, 0);
}

export function renderSendResult(
  result: AgentToolResult<DeliveryReceipt>,
  { expanded }: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext<{ to: string; message: string }>,
) {
  if (context.isError) return errorText(result, theme);
  const { details } = result;
  const messageText = sanitizeDisplayText(context.args.message).trim();
  const total = details.delivered.length + details.skipped.length;
  const summary = !details.broadcast
    ? expanded
      ? `${details.from} → ${details.to} · queued`
      : `Queued for ${details.to === MAIN_AGENT_ID ? MAIN_AGENT_ID : details.to.slice(0, 8)}`
    : total === 0
      ? "No live peers"
      : `Broadcast ${details.delivered.length}/${total} peers`;
  const metadata = [
    summary,
    ...durationPart(context.durationMs),
    context.keyHint("app.tools.expand", expanded ? "to collapse" : "to expand"),
  ];
  const view = new Container();
  view.addChild(new Text(theme.fg("dim", metadata.join(" · ")), 0, 0));
  if (details.skipped.length > 0) {
    if (!expanded) {
      view.addChild(
        new Text(theme.fg("warning", `Skipped ${details.skipped.length} peer(s).`), 0, 0),
      );
    } else {
      for (const skipped of details.skipped) {
        view.addChild(
          new Text(theme.fg("warning", `- ${skipped.id}: skipped (${skipped.reason})`), 0, 0),
        );
      }
    }
  }
  if (expanded && messageText) {
    view.addChild(new Spacer(1));
    view.addChild(new Markdown(messageText, 0, 0, getMarkdownTheme()));
  }
  return view;
}

export function renderWaitCall(
  args: Partial<{ timeoutSeconds: number; all: boolean }> | undefined,
  theme: Theme,
) {
  const summary = [
    ...(args?.all === true ? ["all"] : []),
    ...(typeof args?.timeoutSeconds === "number" ? [`${args.timeoutSeconds}s`] : []),
  ].join(" · ");
  return new TruncatedText(
    theme.fg("toolTitle", theme.bold("subagent_wait")) +
      (summary ? `  ${theme.fg("muted", summary)}` : ""),
    0,
    0,
  );
}

export function renderWaitResult(
  result: AgentToolResult<WaitOutcome>,
  _options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
) {
  if (context.isError) return errorText(result, theme);
  const { details } = result;
  const phrase =
    details.outcome === "woke"
      ? `Update queued · ${formatDuration(details.waitedMs)}`
      : details.outcome === "idle"
        ? "No running subagents"
        : details.outcome === "peer_finished"
          ? `${details.peers
              .map((peer) => `${oneLine(peer.id, 64).slice(0, 8)} ${statusPhrase(peer.status)}`)
              .join(", ")} without replying · ${formatDuration(details.waitedMs)}`
          : "running" in details
            ? `${details.running} still running after ${formatDuration(details.waitedMs)}`
            : `No updates within ${formatDuration(details.waitedMs)}`;
  return new Text(theme.fg("dim", phrase), 0, 0);
}
