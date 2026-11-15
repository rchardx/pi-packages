import {
  type AgentToolResult,
  getMarkdownTheme,
  type KeybindingHints,
  type Theme,
  type ToolRenderResultOptions,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  stripTerminalSequences,
  Text,
  TruncatedText,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { Display, singleLine } from "./output.ts";

const Details = Type.Object({
  display: Display,
  truncated: Type.Boolean(),
  fullOutputPath: Type.Optional(Type.String()),
  resultCount: Type.Optional(Type.Integer()),
  omittedInvalidUrls: Type.Optional(Type.Integer()),
});
type Kind = "fetch" | "search";
type Context = KeybindingHints & { isError: boolean; durationMs: number | undefined };

// Provider text must not introduce terminal control sequences. Model-facing content is untouched.
function displayText(value: string): string {
  return stripTerminalSequences(value).replace(/[\p{Cc}]/gu, (character) =>
    character === "\n" || character === "\t" ? character : "",
  );
}

export function renderWebCall(kind: Kind, value: unknown, theme: Theme) {
  const argument = typeof value === "string" ? singleLine(displayText(value)) : "";
  return new TruncatedText(
    theme.fg("toolTitle", theme.bold(`Web ${kind}`)) +
      (argument ? `  ${theme.fg("muted", argument)}` : ""),
    0,
    0,
  );
}

export function renderWebResult(
  kind: Kind,
  result: AgentToolResult<unknown>,
  { expanded, isPartial }: ToolRenderResultOptions,
  theme: Theme,
  context: Context,
) {
  const text = result.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n");
  if (context.isError) return new Text(theme.fg("error", displayText(text)), 0, 0);
  if (isPartial) {
    return new Text(theme.fg("muted", kind === "fetch" ? "Fetching…" : "Searching…"), 0, 0);
  }
  const details = result.details;
  // Older session entries do not have presentation metadata; keep their text readable.
  if (!Check(Details, details)) {
    const preview = truncateHead(displayText(text), { maxLines: 5 });
    return new Text(
      expanded || !preview.truncated
        ? displayText(text)
        : `${preview.content}\n${context.keyHint("app.tools.expand", "to expand")}`,
      0,
      0,
    );
  }
  const { display } = details;
  const read = (range: { start: number; end: number }) =>
    displayText(text.slice(range.start, Math.min(range.end, display.previewLength)));
  const sections = display.sections.filter(
    (section) => section.heading.start < display.previewLength,
  );
  const view = new Container();
  const heading = (section: Static<typeof Display>["sections"][number]) =>
    new TruncatedText(theme.fg("toolTitle", theme.bold(singleLine(read(section.heading)))), 0, 0);
  if (kind === "fetch" && sections[0]) view.addChild(heading(sections[0]));
  const metadata = ["DeepSeek"];
  if (kind === "search" && details.resultCount !== undefined) {
    metadata.push(`${details.resultCount} results`);
  }
  if (context.durationMs !== undefined) metadata.push(`${(context.durationMs / 1000).toFixed(1)}s`);
  metadata.push(context.keyHint("app.tools.expand", expanded ? "to collapse" : "to expand"));
  view.addChild(new Text(theme.fg("dim", metadata.filter(Boolean).join(" · ")), 0, 0));
  if (details.omittedInvalidUrls) {
    view.addChild(
      new Text(
        theme.fg("warning", `Omitted ${details.omittedInvalidUrls} unusable source URL(s).`),
        0,
        0,
      ),
    );
  }
  if (details.truncated) {
    view.addChild(new Text(theme.fg("warning", "Output truncated; use read to continue."), 0, 0));
  }
  if (details.fullOutputPath) {
    view.addChild(
      new Text(theme.fg("muted", `Full output: ${displayText(details.fullOutputPath)}`), 0, 0),
    );
  }
  if (kind === "search" && details.resultCount === 0) {
    view.addChild(
      new Text(
        theme.fg(
          "muted",
          details.omittedInvalidUrls ? "No usable results remain." : "No results found.",
        ),
        0,
        0,
      ),
    );
  }
  if (expanded) {
    view.addChild(
      new Text(theme.fg("dim", "Untrusted provider content · completeness not guaranteed"), 0, 0),
    );
  }
  const visible = expanded ? sections : kind === "search" ? sections.slice(0, 3) : [];
  for (const section of visible) {
    if (expanded) view.addChild(new Spacer(1));
    if (kind === "search") view.addChild(heading(section));
    if (!expanded) continue;
    if (section.url) view.addChild(new Text(theme.fg("muted", read(section.url)), 0, 0));
    const metadata = section.metadata.map(read).filter(Boolean).join(" · ");
    if (metadata) view.addChild(new Text(theme.fg("dim", metadata), 0, 0));
    for (const [index, range] of section.body.entries()) {
      const body = read(range);
      if (body) {
        if (kind === "search") {
          view.addChild(new Spacer(1));
          view.addChild(new Text(theme.fg("dim", index === 0 ? "Summary" : "Page content"), 0, 0));
        }
        view.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
      }
    }
  }
  if (!expanded && kind === "search" && sections.length > visible.length) {
    view.addChild(
      new Text(theme.fg("dim", `${sections.length - visible.length} more in preview`), 0, 0),
    );
  }
  return view;
}
