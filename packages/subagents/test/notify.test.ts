import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildNotification,
  formatDuration,
  formatPeerMessage,
  oneLine,
  renderMessageNotification,
  renderNotification,
  sanitizeDisplayText,
} from "../src/notify.ts";
import type { MessageEnvelope, Result } from "../src/protocol.ts";

const ESC = "\u001B";
const CHILD_ID = "550e8400-e29b-41d4-a716-446655440000";

const plainTheme = {
  bg: (_token: string, text: string) => text,
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
};

test("formatDuration renders compact durations", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(72_000), "1m12s");
  assert.equal(formatDuration(3_780_000), "1h3m");
  assert.equal(formatDuration(259_200_000), "72h0m");
});

test("oneLine and sanitizeDisplayText strip terminal sequences and cap length", () => {
  assert.equal(sanitizeDisplayText(`${ESC}[31mred${ESC}[0m\r\nnext\u0007`), "red\nnext");
  assert.equal(oneLine("Implement validation\nRun tests"), "Implement validation ⏎ Run tests");
  assert.equal(oneLine(`x${"y".repeat(200)}`).length, 80);
});

test("buildNotification preserves model-facing content and populates card details", () => {
  const result: Result = {
    status: "completed",
    report: "Updated config validation and ran tests.",
    requests: 3,
    tokens: 420,
  };
  const { content, details } = buildNotification(
    { id: CHILD_ID, task: "Validate config\nand add tests", startedAt: 1_000 },
    result,
    73_000,
  );
  assert.equal(
    content,
    `Subagent ${CHILD_ID}: completed\n` +
      "Task: Validate config\nand add tests\n" +
      "Duration: 72s; requests: 3; tokens: 420\n\n" +
      "Updated config validation and ran tests.",
  );
  assert.deepEqual(details, {
    id: CHILD_ID,
    task: "Validate config ⏎ and add tests",
    durationMs: 72_000,
    ...result,
  });

  const roled = buildNotification(
    { id: CHILD_ID, role: "reviewer", task: "Review changes", startedAt: 1_000 },
    result,
    11_000,
  );
  assert.match(roled.content, new RegExp(`^Subagent ${CHILD_ID} \\(reviewer\\): completed\n`, "u"));
  assert.equal(roled.details.role, "reviewer");
  const roledCard = renderNotification(
    { details: roled.details },
    { expanded: false, outputPad: 1 },
    plainTheme,
  );
  assert.ok(roledCard);
  assert.match(
    roledCard.render(100)[1] ?? "",
    /subagent 550e8400 \(reviewer\) · completed · 10s · Review changes/u,
  );
  assert.equal(
    renderNotification(
      { details: { ...roled.details, role: "bad role" } },
      { expanded: false, outputPad: 1 },
      plainTheme,
    ),
    undefined,
  );
});

test("renderNotification draws a one-line collapsed card and keeps status before long tasks", () => {
  for (const status of ["completed", "failed", "timed_out", "limit_reached"] as const) {
    const { details } = buildNotification(
      {
        id: CHILD_ID,
        task: `Investigate ${"中文 edge case ".repeat(20)}\nand report`,
        startedAt: 0,
      },
      {
        status,
        report: `${ESC}[32mFinished check${ESC}[0m\nAll assertions passed.`,
        requests: 1,
        tokens: 95,
      },
      72_000,
    );
    const collapsed = renderNotification(
      { details },
      { expanded: false, outputPad: 1 },
      plainTheme,
    );
    const expanded = renderNotification({ details }, { expanded: true, outputPad: 1 }, plainTheme);
    assert.ok(collapsed && expanded);

    const lines = collapsed.render(80);
    assert.equal(lines.length, 3, "one content row with one blank row above and below");
    assert.equal(lines[0]?.trim(), "");
    assert.equal(lines[2]?.trim(), "");
    const expectedPhrase =
      status === "timed_out" ? "timed out" : status === "limit_reached" ? "limit reached" : status;
    const headline = lines[1] ?? "";
    assert.ok(headline.startsWith(status === "completed" ? " ✓" : " ✗"));
    assert.ok(headline.includes(`subagent 550e8400 · ${expectedPhrase} · 1m12s`));
    assert.ok(visibleWidth(headline) <= 80);
    assert.ok(!headline.includes(details.task), "truncate the task before the status summary");

    const narrow = collapsed.render(30);
    assert.equal(narrow.length, 3);
    assert.ok(narrow.every((line) => visibleWidth(line) <= 30));

    const expandedLines = expanded.render(120);
    const expandedText = expandedLines.map((line) => line.trimEnd()).join("\n");
    assert.match(expandedText, new RegExp(`${CHILD_ID} · 1 request · 95 tokens`, "u"));
    assert.match(expandedText, /Finished check\n All assertions passed\./u);
    assert.ok(!expandedText.includes(ESC), "strip ANSI sequences from child report display");
  }

  assert.equal(renderNotification({}, { expanded: false, outputPad: 1 }, plainTheme), undefined);
  assert.equal(
    renderNotification(
      { details: { id: CHILD_ID, status: "completed", report: "legacy", requests: 1, tokens: 5 } },
      { expanded: false, outputPad: 1 },
      plainTheme,
    ),
    undefined,
  );
});

test("formatPeerMessage and renderMessageNotification format collapsible peer message cards", () => {
  const envelope: MessageEnvelope = {
    id: "msg-1",
    from: CHILD_ID,
    to: "main",
    broadcast: false,
    message: `${ESC}[31mNeed port confirmation${ESC}[0m\nDefaulting to 8080 unless overridden.`,
    sentAt: 1_000,
  };
  assert.match(
    formatPeerMessage(envelope),
    new RegExp(`^Peer message from subagent ${CHILD_ID} \\(direct\\):`, "u"),
  );

  const collapsed = renderMessageNotification(
    { details: envelope },
    { expanded: false, outputPad: 1 },
    plainTheme,
  );
  const expanded = renderMessageNotification(
    { details: envelope },
    { expanded: true, outputPad: 1 },
    plainTheme,
  );
  assert.ok(collapsed && expanded);
  const collapsedLines = collapsed.render(80);
  assert.equal(collapsedLines.length, 3);
  assert.ok((collapsedLines[1] ?? "").includes("✉ subagent 550e8400 · direct · Need port"));
  assert.ok(visibleWidth(collapsedLines[1] ?? "") <= 80);

  const expandedText = expanded
    .render(120)
    .map((line) => line.trimEnd())
    .join("\n");
  assert.match(expandedText, new RegExp(`${CHILD_ID} → main · direct`, "u"));
  assert.match(expandedText, /Need port confirmation\n Defaulting to 8080/u);
  assert.ok(!expandedText.includes(ESC));
  assert.equal(
    renderMessageNotification({}, { expanded: false, outputPad: 1 }, plainTheme),
    undefined,
  );
});
