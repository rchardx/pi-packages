import type {
  AgentToolResult,
  KeybindingHints,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, TruncatedText, truncateToWidth } from "@earendil-works/pi-tui";
import {
  type AskDetails,
  type AskInput,
  formatAnswerChoice,
  sanitizeDisplayText,
  singleLine,
} from "./schema.ts";

type RenderContext = KeybindingHints & {
  isError: boolean;
  durationMs: number | undefined;
};

type PartialQuestion = Partial<{
  id: string;
  header: string;
  question: string;
}>;

function errorText(result: AgentToolResult<unknown>, theme: Theme): Text {
  const text = result.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n");
  return new Text(theme.fg("error", sanitizeDisplayText(text)), 0, 0);
}

export function renderAskCall(
  args: Partial<{ questions: PartialQuestion[] }> | Partial<AskInput> | undefined,
  theme: Theme,
) {
  const rawQuestions = Array.isArray(args?.questions) ? args.questions : [];
  const title = theme.fg("toolTitle", theme.bold("ask"));
  if (rawQuestions.length === 0) {
    return new TruncatedText(title, 0, 0);
  }
  if (rawQuestions.length === 1) {
    const first = rawQuestions[0];
    const preview = typeof first?.question === "string" ? singleLine(first.question) : "";
    return new TruncatedText(title + (preview ? `  ${theme.fg("muted", preview)}` : ""), 0, 0);
  }
  const headers = rawQuestions
    .flatMap((question) => {
      const header =
        typeof question?.header === "string"
          ? singleLine(question.header)
          : typeof question?.id === "string"
            ? singleLine(question.id)
            : "";
      return header ? [header] : [];
    })
    .join(" · ");
  const badge = theme.fg("accent", `(${rawQuestions.length} questions)`);
  return new TruncatedText(
    `${title} ${badge}${headers ? `  ${theme.fg("muted", headers)}` : ""}`,
    0,
    0,
  );
}

export function renderAskResult(
  result: AgentToolResult<AskDetails>,
  { expanded }: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext,
) {
  if (context.isError) return errorText(result, theme);
  const { cancelled, answers } = result.details;
  const timing =
    context.durationMs !== undefined ? [`${(context.durationMs / 1000).toFixed(1)}s`] : [];
  if (cancelled) {
    return new TruncatedText(theme.fg("dim", ["Cancelled", ...timing].join(" · ")), 0, 0);
  }

  const [onlyAnswer] = answers;
  const singleChoice =
    answers.length === 1 && onlyAnswer
      ? truncateToWidth(singleLine(formatAnswerChoice(onlyAnswer)), 36)
      : "";
  const collapsedSummary =
    answers.length === 1 ? `Answered: ${singleChoice}` : `Answered ${answers.length} questions`;
  const expandedSummary =
    answers.length === 1 ? "Answered 1 question" : `Answered ${answers.length} questions`;

  const metadata = [
    expanded ? expandedSummary : collapsedSummary,
    ...timing,
    context.keyHint("app.tools.expand", expanded ? "to collapse" : "to expand"),
  ];
  if (!expanded) {
    return new TruncatedText(theme.fg("dim", metadata.join(" · ")), 0, 0);
  }

  const view = new Container();
  view.addChild(new Text(theme.fg("dim", metadata.join(" · ")), 0, 0));
  view.addChild(new Spacer(1));
  for (const answer of answers) {
    const header = singleLine(answer.header);
    const question = singleLine(answer.question);
    const choice = singleLine(formatAnswerChoice(answer));
    view.addChild(
      new Text(`${theme.fg("accent", header)}${theme.fg("muted", ` — ${question}`)}`, 0, 0),
    );
    view.addChild(new Text(theme.fg("toolOutput", `  → ${choice}`), 0, 0));
  }
  return view;
}
