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
import { WEB_PROVIDERS, type WebProviderId } from "./config.ts";
import { Display, singleLine } from "./output.ts";

const Details = Type.Object({
  provider: Type.Enum([...WEB_PROVIDERS]),
  mode: Type.Optional(Type.String()),
  display: Display,
  truncated: Type.Boolean(),
  fullOutputPath: Type.Optional(Type.String()),
  resultCount: Type.Optional(Type.Integer()),
  omittedInvalidUrls: Type.Optional(Type.Integer()),
});
type Kind = "fetch" | "search";
type Context = KeybindingHints & { isError: boolean; durationMs: number | undefined };

const PROVIDER_LABELS: Readonly<Record<WebProviderId, string>> = {
  deepseek: "DeepSeek",
  exa: "Exa",
};

// Provider text must not introduce terminal control sequences. Model-facing content is untouched.
function displayText(value: string): string {
  return stripTerminalSequences(value).replace(/[\p{Cc}]/gu, (character) =>
    character === "\n" || character === "\t" ? character : "",
  );
}

function compactMetadataItem(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(
    value,
  );
  return match?.[1] ?? value;
}

export function renderWebCall(kind: Kind, value: unknown, theme: Theme) {
  const argument = typeof value === "string" ? singleLine(displayText(value)) : "";
  return new TruncatedText(
    theme.fg("toolTitle", theme.bold(`web_${kind}`)) +
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
  // Older session entries or results from removed providers do not match current presentation metadata; keep their text readable.
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
  const metadata = [PROVIDER_LABELS[details.provider]];
  if (kind === "search" && details.mode) metadata.push(singleLine(displayText(details.mode)));
  if (kind === "search" && details.resultCount !== undefined) {
    metadata.push(`${details.resultCount} ${details.resultCount === 1 ? "result" : "results"}`);
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
    for (const section of sections) {
      view.addChild(new Spacer(1));
      if (kind === "search") view.addChild(heading(section));
      if (section.url) view.addChild(new Text(theme.fg("muted", read(section.url)), 0, 0));
      const sectionMetadata = section.metadata
        .map((range) => compactMetadataItem(read(range)))
        .filter(Boolean)
        .join(" · ");
      if (sectionMetadata) view.addChild(new Text(theme.fg("dim", sectionMetadata), 0, 0));
      for (const [index, range] of section.body.entries()) {
        const body = read(range);
        if (body) {
          if (kind === "search") {
            const label = section.bodyLabels?.[index] ?? (index > 0 ? "Page content" : "Summary");
            view.addChild(new Spacer(1));
            view.addChild(new Text(theme.fg("dim", label), 0, 0));
          }
          view.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
        }
      }
    }
  }
  return view;
}
