import type {
  AgentToolResult,
  KeybindingHints,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import { type LspInput, sanitizeDisplayText, singleLine } from "./schema.ts";

type RenderContext = KeybindingHints & {
  isError: boolean;
  durationMs: number | undefined;
};

export function renderLspCall(args: Partial<LspInput> | undefined, theme: Theme) {
  const action = typeof args?.action === "string" ? singleLine(args.action) : "";
  let target = typeof args?.path === "string" ? singleLine(args.path) : "";
  if (target && typeof args?.line === "number") target += `:${args.line}`;
  if (target && typeof args?.symbol === "string") target += ` · ${singleLine(args.symbol)}`;

  const title =
    theme.fg("toolTitle", theme.bold("lsp")) +
    (action ? ` ${theme.fg("accent", `(${action})`)}` : "");
  return new TruncatedText(title + (target ? `  ${theme.fg("muted", target)}` : ""), 0, 0);
}

/** The result is the text the model receives: its first line collapsed, all of it expanded. */
export function renderLspResult(
  result: AgentToolResult<unknown>,
  { expanded }: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
) {
  const text = sanitizeDisplayText(
    result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
  ).trim();
  if (context.isError) return new Text(theme.fg("error", text), 0, 0);

  const newline = text.indexOf("\n");
  const summary = newline === -1 ? text : text.slice(0, newline);
  const body = newline === -1 ? "" : text.slice(newline + 1).trim();
  const metadata = [
    summary,
    ...(context.durationMs !== undefined ? [`${(context.durationMs / 1000).toFixed(1)}s`] : []),
    ...(body ? [context.keyHint("app.tools.expand", expanded ? "to collapse" : "to expand")] : []),
  ].join(" · ");
  if (!expanded || !body) return new TruncatedText(theme.fg("dim", metadata), 0, 0);

  const view = new Container();
  view.addChild(new Text(theme.fg("dim", metadata), 0, 0));
  view.addChild(new Spacer(1));
  view.addChild(new Text(theme.fg("toolOutput", body), 0, 0));
  return view;
}
