import assert from "node:assert/strict";
import { test } from "node:test";
import { runRpcAsk } from "../src/rpc.ts";
import { type AskQuestion, OTHER_OPTION_LABEL } from "../src/schema.ts";

const sampleQuestions: AskQuestion[] = [
  {
    id: "auth",
    header: "Auth",
    question: "Which auth flow?",
    options: [{ label: "Device code", description: "SSH friendly" }, { label: "Localhost" }],
    multiSelect: false,
  },
  {
    id: "scopes",
    header: "Scopes",
    question: "Which scopes?",
    options: [{ label: "read" }, { label: "write" }],
    multiSelect: true,
  },
];

test("runRpcAsk supports single-select, Other retry on blank input, and multi-select toggle", async () => {
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const selectQueue: Array<string | undefined> = [
    OTHER_OPTION_LABEL,
    OTHER_OPTION_LABEL,
    "[ ] read",
    `[ ] ${OTHER_OPTION_LABEL}`,
    "✓ Confirm selection",
  ];
  const inputQueue: Array<string | undefined> = [
    "   ", // Blank custom input returns to select for Q1
    "Custom token", // Accepted custom answer for Q1
    "admin:org", // Custom addition for Q2
  ];

  const result = await runRpcAsk(sampleQuestions, {
    async select(title, options) {
      selectCalls.push({ title, options });
      return selectQueue.shift();
    },
    async input() {
      return inputQueue.shift();
    },
  });

  assert.deepEqual(result, {
    cancelled: false,
    answers: [
      {
        id: "auth",
        header: "Auth",
        question: "Which auth flow?",
        selected: [],
        customText: "Custom token",
      },
      {
        id: "scopes",
        header: "Scopes",
        question: "Which scopes?",
        selected: ["read"],
        customText: "admin:org",
      },
    ],
  });
  assert.match(selectCalls[0]?.title ?? "", /^\[1\/2 · Auth\] Which auth flow\?$/u);
  assert.ok(
    !selectCalls[2]?.options.includes("✓ Confirm selection"),
    "hide Confirm until >=1 selected",
  );
  assert.ok(selectCalls[4]?.options.includes("✓ Confirm selection"));
});

test("runRpcAsk discards partial answers on dialog cancel and propagates AbortSignal", async () => {
  const selectQueue: Array<string | undefined> = [
    "Device code — SSH friendly",
    undefined, // User cancels Q2
  ];

  const cancelled = await runRpcAsk(sampleQuestions, {
    async select() {
      return selectQueue.shift();
    },
    async input() {
      return undefined;
    },
  });
  assert.deepEqual(cancelled, { cancelled: true, answers: [] });

  const controller = new AbortController();
  await assert.rejects(
    runRpcAsk(
      sampleQuestions,
      {
        async select(_title, _options, opts) {
          assert.equal(opts?.signal, controller.signal);
          controller.abort(new Error("turn aborted"));
          return "Localhost";
        },
        async input() {
          return undefined;
        },
      },
      controller.signal,
    ),
    /turn aborted/u,
  );
});
