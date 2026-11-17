import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 5;
export const MAX_ID_CHARS = 64;
export const MAX_HEADER_CHARS = 24;
export const MAX_QUESTION_CHARS = 500;
export const MAX_LABEL_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 240;
export const OTHER_OPTION_LABEL = "Other…";

export const AskOptionSchema = Type.Object(
  {
    label: Type.String({
      minLength: 1,
      maxLength: MAX_LABEL_CHARS,
      description: "Concise option label shown to the user.",
    }),
    description: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_DESCRIPTION_CHARS,
        description: "Brief trade-off or implication of choosing this option.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const AskQuestionSchema = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      maxLength: MAX_ID_CHARS,
      description: 'Unique question identifier within this call (for example "auth" or "storage").',
    }),
    header: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_HEADER_CHARS,
        description: "Short tab label for multi-question navigation (defaults to id).",
      }),
    ),
    question: Type.String({
      minLength: 1,
      maxLength: MAX_QUESTION_CHARS,
      description: "Question text shown to the user.",
    }),
    options: Type.Array(AskOptionSchema, {
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      description: "Distinct choices for this question.",
    }),
    multiSelect: Type.Optional(
      Type.Boolean({
        description: "Allow selecting multiple options (default: false).",
      }),
    ),
  },
  { additionalProperties: false },
);

export const AskParameters = Type.Object(
  {
    questions: Type.Array(AskQuestionSchema, {
      minItems: MIN_QUESTIONS,
      maxItems: MAX_QUESTIONS,
      description: "Clarification questions to ask together in one prompt.",
    }),
  },
  { additionalProperties: false },
);

export type AskInput = Static<typeof AskParameters>;
export type RawAskQuestion = Static<typeof AskQuestionSchema>;

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  header: string;
  question: string;
  options: AskOption[];
  multiSelect: boolean;
}

export interface QuestionAnswer {
  id: string;
  header: string;
  question: string;
  selected: string[];
  customText?: string;
}

export interface AskDetails {
  cancelled: boolean;
  answers: QuestionAnswer[];
}

/** Strip terminal escape sequences and control characters before UI display. */
export function sanitizeDisplayText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\p{Cc}]/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    );
}

/** Collapse whitespace into a single trimmed display line. */
export function singleLine(value: string): string {
  return sanitizeDisplayText(value).replace(/\s+/gu, " ").trim();
}

export function normalizeQuestions(rawQuestions: readonly RawAskQuestion[]): AskQuestion[] {
  const seenIds = new Set<string>();
  return rawQuestions.map((raw, questionIndex) => {
    const id = singleLine(raw.id);
    if (!id) {
      throw new Error(`Question ${questionIndex + 1} id must not be blank.`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate question id "${id}".`);
    }
    seenIds.add(id);

    const headerSource =
      raw.header !== undefined ? singleLine(raw.header) : id.slice(0, MAX_HEADER_CHARS);
    if (!headerSource) {
      throw new Error(`Question "${id}" header must not be blank.`);
    }
    const question = sanitizeDisplayText(raw.question).trim();
    if (!question) {
      throw new Error(`Question "${id}" text must not be blank.`);
    }

    const seenLabels = new Set<string>();
    const options: AskOption[] = raw.options.map((rawOption, optionIndex) => {
      const label = singleLine(rawOption.label);
      if (!label) {
        throw new Error(`Question "${id}" option ${optionIndex + 1} label must not be blank.`);
      }
      if (label.toLowerCase() === "other" || label === OTHER_OPTION_LABEL) {
        throw new Error(
          `Question "${id}" option "${label}" duplicates the built-in "${OTHER_OPTION_LABEL}" free-text input.`,
        );
      }
      if (seenLabels.has(label)) {
        throw new Error(`Question "${id}" has duplicate option label "${label}".`);
      }
      seenLabels.add(label);

      const description =
        rawOption.description !== undefined ? singleLine(rawOption.description) : undefined;
      return description ? { label, description } : { label };
    });

    return {
      id,
      header: headerSource,
      question,
      options,
      multiSelect: raw.multiSelect === true,
    };
  });
}

export function formatAnswerChoice(
  answer: Pick<QuestionAnswer, "selected" | "customText">,
): string {
  const parts = [...answer.selected];
  if (answer.customText) parts.push(`Other: ${answer.customText}`);
  return parts.join(", ");
}

export function formatAskOutput(details: AskDetails): string {
  if (details.cancelled) {
    return "User cancelled the clarification prompt.";
  }
  const [only] = details.answers;
  if (details.answers.length === 1 && only) {
    return `Answer (${only.id}): ${formatAnswerChoice(only)}`;
  }
  const lines = details.answers.map((answer) => `- ${answer.id}: ${formatAnswerChoice(answer)}`);
  return `Answers:\n${lines.join("\n")}`;
}
