import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  AskParameters,
  formatAnswerChoice,
  formatAskOutput,
  normalizeQuestions,
  OTHER_OPTION_LABEL,
  sanitizeDisplayText,
  singleLine,
} from "../src/schema.ts";

const ESC = "\u001b";

test("AskParameters enforces question/option count bounds and rejects unknown properties", () => {
  const validQuestion = {
    id: "auth",
    header: "Auth",
    question: "Which auth flow?",
    options: [
      { label: "Device code", description: "SSH friendly" },
      { label: "Localhost callback" },
    ],
    multiSelect: false,
  };

  assert.equal(Value.Check(AskParameters, { questions: [validQuestion] }), true);
  assert.equal(
    Value.Check(AskParameters, {
      questions: [1, 2, 3, 4].map((index) => ({ ...validQuestion, id: `q${index}` })),
    }),
    true,
  );

  // Out-of-bounds question counts (0 or 5)
  assert.equal(Value.Check(AskParameters, { questions: [] }), false);
  assert.equal(
    Value.Check(AskParameters, {
      questions: [1, 2, 3, 4, 5].map((index) => ({ ...validQuestion, id: `q${index}` })),
    }),
    false,
  );

  // Out-of-bounds option counts (1 or 6)
  assert.equal(
    Value.Check(AskParameters, {
      questions: [{ ...validQuestion, options: [{ label: "Only one" }] }],
    }),
    false,
  );
  assert.equal(
    Value.Check(AskParameters, {
      questions: [
        {
          ...validQuestion,
          options: [1, 2, 3, 4, 5, 6].map((index) => ({ label: `Option ${index}` })),
        },
      ],
    }),
    false,
  );

  // Unknown properties rejected at all levels
  assert.equal(Value.Check(AskParameters, { questions: [validQuestion], extra: true }), false);
  assert.equal(
    Value.Check(AskParameters, { questions: [{ ...validQuestion, allowOther: true }] }),
    false,
  );
  assert.equal(
    Value.Check(AskParameters, {
      questions: [
        {
          ...validQuestion,
          options: [{ label: "A", value: "a" }, { label: "B" }],
        },
      ],
    }),
    false,
  );
});

test("normalizeQuestions sanitizes text, defaults headers, and rejects duplicates or manual Other", () => {
  const normalized = normalizeQuestions([
    {
      id: ` ${ESC}[31mauth${ESC}[0m `,
      question: ` Which ${ESC}[2Jflow?\r\nChoose carefully. `,
      options: [
        { label: "  Device code  ", description: "  Works\nover SSH  " },
        { label: "Localhost", description: "   " },
      ],
    },
  ]);

  assert.deepEqual(normalized, [
    {
      id: "auth",
      header: "auth",
      question: "Which flow?\nChoose carefully.",
      options: [{ label: "Device code", description: "Works over SSH" }, { label: "Localhost" }],
      multiSelect: false,
    },
  ]);

  assert.throws(
    () =>
      normalizeQuestions([
        { id: "dup", question: "Q1?", options: [{ label: "A" }, { label: "B" }] },
        { id: "dup", question: "Q2?", options: [{ label: "C" }, { label: "D" }] },
      ]),
    /Duplicate question id "dup"/u,
  );

  assert.throws(
    () =>
      normalizeQuestions([
        { id: "q1", question: "Q1?", options: [{ label: "Same" }, { label: "Same" }] },
      ]),
    /duplicate option label "Same"/u,
  );

  for (const badOther of ["Other", "other", OTHER_OPTION_LABEL]) {
    assert.throws(
      () =>
        normalizeQuestions([
          { id: "q1", question: "Q1?", options: [{ label: "A" }, { label: badOther }] },
        ]),
      /duplicates the built-in "Other…"/u,
    );
  }

  assert.throws(
    () =>
      normalizeQuestions([
        { id: "   ", question: "Q1?", options: [{ label: "A" }, { label: "B" }] },
      ]),
    /id must not be blank/u,
  );
  assert.throws(
    () =>
      normalizeQuestions([
        { id: "q1", header: "   ", question: "Q1?", options: [{ label: "A" }, { label: "B" }] },
      ]),
    /header must not be blank/u,
  );
  assert.throws(
    () =>
      normalizeQuestions([
        { id: "q1", question: "   ", options: [{ label: "A" }, { label: "B" }] },
      ]),
    /text must not be blank/u,
  );
});

test("formatAskOutput and display helpers produce concise model-facing text", () => {
  assert.equal(sanitizeDisplayText(`a${ESC}[2Jb\u0000\u0007c`), "abc");
  assert.equal(singleLine("hello\n  world\t!"), "hello world !");
  assert.equal(formatAnswerChoice({ selected: ["A", "B"], customText: "C" }), "A, B, Other: C");

  assert.equal(
    formatAskOutput({ cancelled: true, answers: [] }),
    "User cancelled the clarification prompt.",
  );
  assert.equal(
    formatAskOutput({
      cancelled: false,
      answers: [
        {
          id: "auth",
          header: "Auth",
          question: "Which auth?",
          selected: ["Device code"],
        },
      ],
    }),
    "Answer (auth): Device code",
  );
  assert.equal(
    formatAskOutput({
      cancelled: false,
      answers: [
        {
          id: "auth",
          header: "Auth",
          question: "Which auth?",
          selected: ["Device code"],
        },
        {
          id: "scopes",
          header: "Scopes",
          question: "Which scopes?",
          selected: ["read:org", "repo"],
          customText: "workflow",
        },
      ],
    }),
    "Answers:\n- auth: Device code\n- scopes: read:org, repo, Other: workflow",
  );
});
