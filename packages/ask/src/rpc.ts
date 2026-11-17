import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  type AskDetails,
  type AskQuestion,
  OTHER_OPTION_LABEL,
  type QuestionAnswer,
  singleLine,
} from "./schema.ts";

type RpcDialogUI = Pick<ExtensionUIContext, "select" | "input">;

const CONFIRM_MULTI_LABEL = "✓ Confirm selection";

function formatOptionRow(label: string, description: string | undefined): string {
  return description ? `${label} — ${description}` : label;
}

async function askSingleRpc(
  question: AskQuestion,
  title: string,
  ui: RpcDialogUI,
  signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
  const labelByDisplay = new Map(
    question.options.map((option) => [
      formatOptionRow(option.label, option.description),
      option.label,
    ]),
  );
  const choices = [...labelByDisplay.keys(), OTHER_OPTION_LABEL];
  const dialogOptions = signal ? { signal } : undefined;

  for (;;) {
    const choice = await ui.select(title, choices, dialogOptions);
    signal?.throwIfAborted();
    if (choice === undefined) return undefined;
    if (choice === OTHER_OPTION_LABEL) {
      const custom = await ui.input(title, "Type your answer…", dialogOptions);
      signal?.throwIfAborted();
      const trimmed = custom !== undefined ? singleLine(custom) : "";
      if (!trimmed) continue;
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        selected: [],
        customText: trimmed,
      };
    }
    const selectedLabel = labelByDisplay.get(choice);
    if (selectedLabel !== undefined) {
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        selected: [selectedLabel],
      };
    }
  }
}

async function askMultiRpc(
  question: AskQuestion,
  title: string,
  ui: RpcDialogUI,
  signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
  const selectedIndices = new Set<number>();
  const dialogOptions = signal ? { signal } : undefined;
  let customText = "";

  for (;;) {
    const optionRows = question.options.map((option, index) => {
      const marker = selectedIndices.has(index) ? "[✓]" : "[ ]";
      return `${marker} ${formatOptionRow(option.label, option.description)}`;
    });
    const otherRow = customText ? `[✓] Other: ${customText}` : `[ ] ${OTHER_OPTION_LABEL}`;
    const hasSelection = selectedIndices.size > 0 || customText.length > 0;
    const choices = [...optionRows, otherRow, ...(hasSelection ? [CONFIRM_MULTI_LABEL] : [])];

    const choice = await ui.select(`${title} (select one or more)`, choices, dialogOptions);
    signal?.throwIfAborted();
    if (choice === undefined) return undefined;

    if (choice === CONFIRM_MULTI_LABEL) {
      const selected = question.options
        .filter((_, index) => selectedIndices.has(index))
        .map((option) => option.label);
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        selected,
        ...(customText ? { customText } : {}),
      };
    }

    if (choice === otherRow) {
      const custom = await ui.input(
        title,
        "Type your answer (leave empty to clear)…",
        dialogOptions,
      );
      signal?.throwIfAborted();
      if (custom !== undefined) {
        customText = singleLine(custom);
      }
      continue;
    }

    const rowIndex = optionRows.indexOf(choice);
    if (rowIndex !== -1) {
      if (selectedIndices.has(rowIndex)) selectedIndices.delete(rowIndex);
      else selectedIndices.add(rowIndex);
    }
  }
}

export async function runRpcAsk(
  questions: readonly AskQuestion[],
  ui: RpcDialogUI,
  signal?: AbortSignal,
): Promise<AskDetails> {
  const answers: QuestionAnswer[] = [];
  const total = questions.length;
  for (const [index, question] of questions.entries()) {
    const prefix = total > 1 ? `[${index + 1}/${total} · ${question.header}] ` : "";
    const title = `${prefix}${question.question}`;
    const answer = question.multiSelect
      ? await askMultiRpc(question, title, ui, signal)
      : await askSingleRpc(question, title, ui, signal);
    if (!answer) {
      return { cancelled: true, answers: [] };
    }
    answers.push(answer);
  }
  return { cancelled: false, answers };
}
