import type { ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  Key,
  type KeybindingsManager,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  type AskDetails,
  type AskQuestion,
  formatAnswerChoice,
  OTHER_OPTION_LABEL,
  type QuestionAnswer,
  singleLine,
} from "./schema.ts";

interface QuestionState {
  question: AskQuestion;
  selectedIndices: Set<number>;
  customText: string;
  useCustom: boolean;
}

export type AskComponent = Component &
  Focusable & {
    handleInput(data: string): void;
    invalidate(): void;
    dispose(): void;
  };

function isAnswered(entry: QuestionState): boolean {
  return entry.selectedIndices.size > 0 || (entry.useCustom && entry.customText.length > 0);
}

function materializeAnswer(entry: QuestionState): QuestionAnswer {
  const { question, selectedIndices } = entry;
  const selected = question.options
    .filter((_, index) => selectedIndices.has(index))
    .map((option) => option.label);
  const customText = entry.useCustom && entry.customText ? entry.customText : undefined;
  return {
    id: question.id,
    header: question.header,
    question: question.question,
    selected,
    ...(customText ? { customText } : {}),
  };
}

function pushPrefixedWrapped(
  lines: string[],
  prefix: string,
  content: string,
  width: number,
): void {
  const safeWidth = Math.max(1, width);
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= safeWidth) {
    lines.push(truncateToWidth(`${prefix}${content}`, safeWidth));
    return;
  }
  const available = safeWidth - prefixWidth;
  const wrapped = wrapTextWithAnsi(content, available);
  const indent = " ".repeat(prefixWidth);
  for (const [index, part] of wrapped.entries()) {
    lines.push(truncateToWidth(`${index === 0 ? prefix : indent}${part}`, safeWidth));
  }
}

export function createAskComponent(
  questions: readonly AskQuestion[],
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: AskDetails) => void,
  signal?: AbortSignal,
): AskComponent {
  const isMultiQuestion = questions.length > 1;
  const totalTabs = isMultiQuestion ? questions.length + 1 : 1;
  const states: QuestionState[] = questions.map((question) => ({
    question,
    selectedIndices: new Set<number>(),
    customText: "",
    useCustom: false,
  }));

  let currentTab = 0;
  let cursorIndex = 0;
  let editingCustom = false;
  let componentFocused = false;
  let finished = false;
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;

  const input = new Input({
    prompt: "> ",
    placeholder: "Type your answer…",
    placeholderStyle: (text) => theme.fg("dim", text),
  });

  function syncInputFocus(): void {
    input.focused = componentFocused && editingCustom;
  }

  function invalidate(): void {
    cachedWidth = undefined;
    cachedLines = undefined;
    input.invalidate();
  }

  function refresh(): void {
    invalidate();
    tui.requestRender();
  }

  function onSignalAbort(): void {
    finish(true);
  }

  function finish(cancelled: boolean): void {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", onSignalAbort);
    if (cancelled) {
      done({ cancelled: true, answers: [] });
      return;
    }
    done({ cancelled: false, answers: states.map(materializeAnswer) });
  }

  signal?.addEventListener("abort", onSignalAbort, { once: true });

  function allQuestionsAnswered(): boolean {
    return states.every(isAnswered);
  }

  function firstUnansweredIndex(startAfter = -1): number | undefined {
    for (let offset = 1; offset <= states.length; offset++) {
      const index = (startAfter + offset + states.length) % states.length;
      const entry = states[index];
      if (entry && !isAnswered(entry)) return index;
    }
    return undefined;
  }

  function advanceAfterAnswer(): void {
    if (!isMultiQuestion) {
      finish(false);
      return;
    }
    const nextUnanswered = firstUnansweredIndex(currentTab);
    currentTab = nextUnanswered ?? states.length;
    cursorIndex = 0;
    refresh();
  }

  function rowCountForQuestion(question: AskQuestion): number {
    return question.options.length + (question.multiSelect ? 2 : 1);
  }

  function togglePresetOption(state: QuestionState, index: number): void {
    if (state.selectedIndices.has(index)) {
      state.selectedIndices.delete(index);
    } else {
      state.selectedIndices.add(index);
    }
    refresh();
  }

  input.onSubmit = (rawValue) => {
    const state = states[currentTab];
    if (!state) return;
    const { question } = state;
    const trimmed = singleLine(rawValue);
    editingCustom = false;
    syncInputFocus();
    if (!question.multiSelect) {
      if (!trimmed) {
        refresh();
        return;
      }
      state.selectedIndices.clear();
      state.customText = trimmed;
      state.useCustom = true;
      advanceAfterAnswer();
      return;
    }
    if (trimmed) {
      state.customText = trimmed;
      state.useCustom = true;
      cursorIndex = question.options.length + 1;
    } else {
      state.customText = "";
      state.useCustom = false;
    }
    refresh();
  };

  input.onEscape = () => {
    editingCustom = false;
    syncInputFocus();
    refresh();
  };

  function enterCustomEditor(state: QuestionState): void {
    editingCustom = true;
    input.setValue(state.customText);
    syncInputFocus();
    refresh();
  }

  function handleInput(data: string): void {
    if (finished) return;
    if (editingCustom) {
      if (keybindings.matches(data, "tui.select.cancel")) {
        input.onEscape?.();
        return;
      }
      input.handleInput(data);
      refresh();
      return;
    }

    if (isMultiQuestion) {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
        currentTab = (currentTab + 1) % totalTabs;
        cursorIndex = 0;
        refresh();
        return;
      }
      if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
        currentTab = (currentTab - 1 + totalTabs) % totalTabs;
        cursorIndex = 0;
        refresh();
        return;
      }
    }

    if (keybindings.matches(data, "tui.select.cancel")) {
      finish(true);
      return;
    }

    if (isMultiQuestion && currentTab === states.length) {
      if (keybindings.matches(data, "tui.select.confirm")) {
        if (allQuestionsAnswered()) {
          finish(false);
        } else {
          const missingIndex = firstUnansweredIndex(-1);
          if (missingIndex !== undefined) {
            currentTab = missingIndex;
            cursorIndex = 0;
            refresh();
          }
        }
      }
      return;
    }

    const state = states[currentTab];
    if (!state) return;
    const { question } = state;
    const itemCount = rowCountForQuestion(question);
    const otherIndex = question.options.length;
    const confirmIndex = question.options.length + 1;

    if (keybindings.matches(data, "tui.select.up")) {
      cursorIndex = (cursorIndex - 1 + itemCount) % itemCount;
      refresh();
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      cursorIndex = (cursorIndex + 1) % itemCount;
      refresh();
      return;
    }

    if (question.multiSelect && matchesKey(data, Key.space)) {
      if (cursorIndex < otherIndex) {
        togglePresetOption(state, cursorIndex);
      } else if (cursorIndex === otherIndex) {
        if (state.customText) {
          state.useCustom = !state.useCustom;
          refresh();
        } else {
          enterCustomEditor(state);
        }
      } else if (cursorIndex === confirmIndex && isAnswered(state)) {
        advanceAfterAnswer();
      }
      return;
    }

    if (keybindings.matches(data, "tui.select.confirm")) {
      if (!question.multiSelect) {
        if (cursorIndex === otherIndex) {
          enterCustomEditor(state);
          return;
        }
        state.selectedIndices.clear();
        state.selectedIndices.add(cursorIndex);
        state.useCustom = false;
        advanceAfterAnswer();
        return;
      }

      if (cursorIndex < otherIndex) {
        togglePresetOption(state, cursorIndex);
        return;
      }
      if (cursorIndex === otherIndex) {
        enterCustomEditor(state);
        return;
      }
      if (cursorIndex === confirmIndex && isAnswered(state)) {
        advanceAfterAnswer();
      }
    }
  }

  function render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (cachedLines && cachedWidth === safeWidth) return cachedLines;

    const lines: string[] = [];
    lines.push(theme.fg("border", "─".repeat(safeWidth)));

    if (isMultiQuestion) {
      const chips: string[] = [];
      for (const [index, entry] of states.entries()) {
        const active = index === currentTab;
        const answered = isAnswered(entry);
        const marker = answered ? "■" : "□";
        const label = ` ${marker} ${entry.question.header} `;
        chips.push(
          active
            ? theme.bg("selectedBg", theme.fg("text", label))
            : theme.fg(answered ? "success" : "muted", label),
        );
      }
      const ready = allQuestionsAnswered();
      const submitLabel = " ✓ Submit ";
      chips.push(
        currentTab === states.length
          ? theme.bg("selectedBg", theme.fg("text", submitLabel))
          : theme.fg(ready ? "success" : "dim", submitLabel),
      );
      pushPrefixedWrapped(lines, " ", chips.join(" "), safeWidth);
      lines.push("");
    }

    const activeState = states[currentTab];
    if (!activeState) {
      pushPrefixedWrapped(lines, " ", theme.fg("accent", theme.bold("Review answers")), safeWidth);
      lines.push("");
      for (const entry of states) {
        const value = isAnswered(entry)
          ? theme.fg("text", formatAnswerChoice(materializeAnswer(entry)))
          : theme.fg("warning", "(unanswered)");
        pushPrefixedWrapped(
          lines,
          " ",
          `${theme.fg("muted", `${entry.question.header}:`)} ${value}`,
          safeWidth,
        );
      }
      lines.push("");
      const hint = allQuestionsAnswered()
        ? theme.fg("success", "Enter submit") + theme.fg("dim", " · Tab/←→ review · Esc cancel")
        : theme.fg("warning", "Enter jump to unanswered") +
          theme.fg("dim", " · Tab/←→ navigate · Esc cancel");
      pushPrefixedWrapped(lines, " ", hint, safeWidth);
      lines.push(theme.fg("border", "─".repeat(safeWidth)));
      cachedWidth = safeWidth;
      cachedLines = lines;
      return lines;
    }

    const { question } = activeState;
    const otherIndex = question.options.length;
    const confirmIndex = question.options.length + 1;

    pushPrefixedWrapped(lines, " ", theme.fg("text", theme.bold(question.question)), safeWidth);
    lines.push("");

    for (const [index, option] of question.options.entries()) {
      const focusedRow = index === cursorIndex;
      const pointer = focusedRow ? ` ${theme.fg("accent", "❯")} ` : "   ";
      const checked = activeState.selectedIndices.has(index);
      const marker = question.multiSelect ? (checked ? "[✓] " : "[ ] ") : "";
      const rowColor = focusedRow ? "accent" : checked ? "success" : "text";
      pushPrefixedWrapped(
        lines,
        pointer,
        theme.fg(rowColor, `${marker}${option.label}`),
        safeWidth,
      );
      if (option.description) {
        const descIndent = question.multiSelect ? "       " : "     ";
        pushPrefixedWrapped(lines, descIndent, theme.fg("muted", option.description), safeWidth);
      }
    }

    const otherFocused = cursorIndex === otherIndex;
    const otherPointer = otherFocused ? ` ${theme.fg("accent", "❯")} ` : "   ";
    const otherChecked = activeState.useCustom && activeState.customText.length > 0;
    const otherMarker = question.multiSelect ? (otherChecked ? "[✓] " : "[ ] ") : "";
    const otherDisplay = activeState.customText
      ? `Other: ${activeState.customText}`
      : OTHER_OPTION_LABEL;
    const otherColor = otherFocused || editingCustom ? "accent" : otherChecked ? "success" : "text";
    pushPrefixedWrapped(
      lines,
      otherPointer,
      theme.fg(otherColor, `${otherMarker}${otherDisplay}`),
      safeWidth,
    );

    if (question.multiSelect) {
      const confirmFocused = cursorIndex === confirmIndex;
      const confirmPointer = confirmFocused ? ` ${theme.fg("accent", "❯")} ` : "   ";
      const ready = isAnswered(activeState);
      const confirmLabel = ready
        ? "✓ Confirm selection"
        : "Confirm selection (choose at least one)";
      const confirmColor = !ready ? "dim" : confirmFocused ? "accent" : "success";
      pushPrefixedWrapped(lines, confirmPointer, theme.fg(confirmColor, confirmLabel), safeWidth);
    }

    if (editingCustom) {
      lines.push("");
      if (safeWidth > 1) {
        for (const inputLine of input.render(safeWidth - 1)) {
          lines.push(` ${inputLine}`);
        }
      } else {
        lines.push(...input.render(safeWidth));
      }
      lines.push("");
      pushPrefixedWrapped(lines, " ", theme.fg("dim", "Enter save · Esc back"), safeWidth);
    } else {
      lines.push("");
      const navParts = [
        ...(isMultiQuestion ? ["Tab/←→ switch"] : []),
        "↑↓ move",
        ...(question.multiSelect ? ["Space/Enter toggle"] : ["Enter select"]),
        "Esc cancel",
      ];
      pushPrefixedWrapped(lines, " ", theme.fg("dim", navParts.join(" · ")), safeWidth);
    }

    lines.push(theme.fg("border", "─".repeat(safeWidth)));
    cachedWidth = safeWidth;
    cachedLines = lines;
    return lines;
  }

  return {
    get focused() {
      return componentFocused;
    },
    set focused(value: boolean) {
      componentFocused = value;
      syncInputFocus();
    },
    render,
    handleInput,
    invalidate,
    dispose: () => {
      signal?.removeEventListener("abort", onSignalAbort);
    },
  };
}

export async function runTuiAsk(
  questions: readonly AskQuestion[],
  ctx: ExtensionToolContext,
  signal?: AbortSignal,
): Promise<AskDetails> {
  const [onlyQuestion] = questions;
  const blockedMessage =
    questions.length === 1 && onlyQuestion
      ? onlyQuestion.question
      : `${questions.length} clarification questions`;
  const details = await ctx.ui.custom<AskDetails>(
    (tui, theme, keybindings, done) =>
      createAskComponent(questions, tui, theme, keybindings, done, signal),
    {
      blocked: {
        kind: "question",
        message: blockedMessage,
      },
    },
  );
  signal?.throwIfAborted();
  return details;
}
