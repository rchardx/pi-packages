import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TailBuffer, type JobRecord } from "../src/jobs.ts";
import {
  buildNotification,
  formatDuration,
  oneLine,
  renderCancelCall,
  renderCancelResult,
  renderNotification,
  tailText,
} from "../src/notify.ts";

const ESC = "\u001B";

function fakeJob(tail: string): JobRecord {
  const buffer = new TailBuffer();
  buffer.append(Buffer.from(tail, "utf8"));
  return {
    id: "bg_a1b2c3d4",
    command: "npm test",
    controller: new AbortController(),
    startedAtMs: 0,
    logPath: "/tmp/jobs/sess/bg_a1b2c3d4.log",
    log: null,
    logBytes: 0,
    tail: buffer,
    seed: new TailBuffer(),
    state: "running",
  };
}

test("formatDuration renders compact durations", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(72_000), "1m12s");
  assert.equal(formatDuration(3_780_000), "1h3m");
  assert.equal(formatDuration(259_200_000), "72h0m");
  assert.equal(formatDuration(271_500_000), "75h25m");
});

test("oneLine flattens and caps commands", () => {
  assert.equal(oneLine("npm test"), "npm test");
  assert.equal(oneLine("echo a\necho b"), "echo a ⏎ echo b");
  assert.equal(oneLine(`x${"y".repeat(200)}`).length, 80);
});

test("tailText bounds lines and characters and strips ANSI", () => {
  const manyLines = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
  const tail = tailText(manyLines, 5);
  assert.equal(tail, ["line35", "line36", "line37", "line38", "line39"].join("\n"));
  assert.equal(tailText(`${ESC}[31mred${ESC}[0m`), "red");
  assert.ok(tailText("x".repeat(9000), 20, 4000).length <= 4000);
});

test("tailText normalizes CRLF and carriage-return progress before limiting lines", () => {
  assert.equal(tailText("one\r\ntwo\r\nthree"), "one\ntwo\nthree");
  assert.equal(tailText("10%\r20%\r30%\rdone", 2), "30%\ndone");
  assert.equal(tailText("first\r\nsecond\rthird\nlast", 3), "second\nthird\nlast");
});

test("buildNotification reports success and failure with tail and log path", () => {
  const success = buildNotification(
    fakeJob("all 42 tests passed\n"),
    { kind: "exit", exitCode: 0 },
    72_000,
  );
  assert.match(
    success.content,
    /✓ Background job bg_a1b2c3d4 exited with code 0 after 1m12s: `npm test`/u,
  );
  assert.match(success.content, /all 42 tests passed/u);
  assert.ok(success.content.endsWith("\n\nLog: /tmp/jobs/sess/bg_a1b2c3d4.log"));
  assert.doesNotMatch(success.content, /MiB|use read|use grep/u);
  assert.equal(success.details.outcome, "completed");
  assert.equal(success.details.exitCode, 0);

  const failure = buildNotification(fakeJob("2 failed\n"), { kind: "exit", exitCode: 1 }, 5_000);
  assert.match(failure.content, /✗ Background job bg_a1b2c3d4 exited with code 1/u);
  assert.equal(failure.details.outcome, "failed");

  const aborted = buildNotification(fakeJob(""), { kind: "aborted" }, 40_000);
  assert.match(aborted.content, /was aborted after 40s/u);
  assert.doesNotMatch(aborted.content, /Last output/u);

  const timeout = buildNotification(fakeJob(""), { kind: "timeout", seconds: 30 }, 30_000);
  assert.match(timeout.content, /hit its 30s timeout and was killed/u);
});

test("completion notifications mention the log limit only when reached", () => {
  const job = fakeJob("latest output");
  job.logBytes = 8 * 1024 * 1024 - 1;
  assert.doesNotMatch(
    buildNotification(job, { kind: "exit", exitCode: 0 }, 1000).content,
    /limit|MiB/u,
  );
  job.logBytes++;
  const { content } = buildNotification(job, { kind: "exit", exitCode: 0 }, 1000);
  assert.ok(content.endsWith("\nLog output limit reached (8 MiB)."));
  assert.match(content, /latest output/u);
});

test("collapsed cards keep exit status and duration before long commands", () => {
  const theme = {
    bg: (_token: string, text: string) => text,
    fg: (_token: string, text: string) => text,
    bold: (text: string) => text,
  };
  const job = {
    ...fakeJob("output tail"),
    command: `printf '${"中文 output ".repeat(20)}'\nprintf done`,
  };
  for (const exitCode of [0, 2]) {
    const { details } = buildNotification(job, { kind: "exit", exitCode }, 72_000);
    const collapsed = renderNotification({ details }, { expanded: false, outputPad: 1 }, theme);
    assert.ok(collapsed);
    for (const width of [40, 80]) {
      const lines = collapsed.render(width);
      assert.equal(lines.length, 3);
      const headline = lines[1] ?? "";
      assert.ok(headline.includes(`bg_a1b2c3d4 · exit ${exitCode} · 1m12s`));
      assert.ok(visibleWidth(headline) <= width);
      assert.ok(!headline.includes(details.command), "truncate the command, not the summary");
    }
    const narrow = collapsed.render(30);
    assert.equal(narrow.length, 3);
    assert.ok(narrow.every((line) => visibleWidth(line) <= 30));
    const expanded = renderNotification({ details }, { expanded: true, outputPad: 1 }, theme);
    assert.ok(expanded);
    const expandedText = expanded.render(200).join("\n");
    assert.ok(expandedText.includes(details.command));
    assert.match(expandedText, /output tail/u);
  }
});

test("renderNotification draws a one-line card, expandable to the tail", () => {
  const { details } = buildNotification(
    fakeJob("line of output"),
    { kind: "exit", exitCode: 0 },
    72_000,
  );
  const theme = {
    bg: (_token: string, text: string) => text,
    fg: (_token: string, text: string) => text,
    bold: (text: string) => text,
  };
  const collapsed = renderNotification({ details }, { expanded: false, outputPad: 1 }, theme);
  const expanded = renderNotification({ details }, { expanded: true, outputPad: 1 }, theme);
  assert.ok(collapsed && expanded);
  const lines = collapsed.render(120);
  assert.equal(lines.length, 3, "one content row with one blank row above and below");
  assert.equal(lines[0]?.trim(), "");
  assert.equal(lines[2]?.trim(), "");
  assert.equal(expanded.render(120).length, 5, "only the outer box adds vertical padding");
  assert.ok(lines[1]?.startsWith(" ✓"), "honor Pi's horizontal output padding");
  const narrow = collapsed.render(30);
  assert.equal(narrow.length, 3, "collapsed content truncates rather than wrapping");
  assert.ok(visibleWidth(narrow[1] ?? "") <= 30);
  const render = (component: typeof collapsed): string => component.render(120).join("\n");
  assert.match(render(collapsed), /bg_a1b2c3d4 · exit 0 · 1m12s · npm test/u);
  assert.doesNotMatch(render(collapsed), /line of output/u);
  assert.match(render(expanded), /line of output/u);
  assert.match(render(expanded), /bg_a1b2c3d4\.log/u);
  assert.equal(renderNotification({}, { expanded: false, outputPad: 1 }, theme), undefined);
  const unpadded = renderNotification({ details }, { expanded: false, outputPad: 0 }, theme);
  assert.ok(unpadded?.render(120)[1]?.startsWith("✓"));
});

test("renderCancelCall and renderCancelResult format compact and expanded views while stripping escapes", () => {
  const theme = {
    fg: (_token: string, text: string) => text,
    bold: (text: string) => text,
  };
  const keyHint = (_action: string, label: string) => `ctrl+o ${label}`;

  const renderTrimmed = (component: { render(width: number): readonly string[] }, width = 120) =>
    component
      .render(width)
      .map((line) => line.trimEnd())
      .join("\n");

  assert.equal(
    renderTrimmed(
      renderCancelCall({ job_id: `  ${ESC}[31mbg_a1b2c3d4${ESC}[0m\u0007  ` }, theme),
      80,
    ),
    "bash_cancel  bg_a1b2c3d4",
  );
  assert.equal(renderTrimmed(renderCancelCall(undefined, theme), 80), "bash_cancel");

  const result = {
    content: [{ type: "text" as const, text: "Cancelled" }],
    details: {
      jobId: "bg_a1b2c3d4",
      command: `npm run ${ESC}[32mdev${ESC}[0m`,
      logPath: "/tmp/jobs/bg_a1b2c3d4.log",
      tail: `Server listening on :3000${ESC}[2J\u0007`,
    },
  };
  const collapsed = renderCancelResult(result, { expanded: false, isPartial: false }, theme, {
    isError: false,
    durationMs: 120,
    keyHint,
  });
  assert.equal(collapsed.render(120).length, 1);
  assert.equal(
    renderTrimmed(collapsed),
    "Cancelled bg_a1b2c3d4 · 0.1s · npm run dev · ctrl+o to expand",
  );
  assert.ok(visibleWidth(collapsed.render(28)[0] ?? "") <= 28);

  const expanded = renderCancelResult(result, { expanded: true, isPartial: false }, theme, {
    isError: false,
    durationMs: 120,
    keyHint,
  });
  assert.equal(
    renderTrimmed(expanded),
    "Cancelled bg_a1b2c3d4 · 0.1s · npm run dev · ctrl+o to collapse\n" +
      "/tmp/jobs/bg_a1b2c3d4.log\n\n" +
      "Server listening on :3000",
  );

  const noDetails = renderCancelResult(
    {
      content: [{ type: "text" as const, text: "Cancelled" }],
      details: { jobId: "bg_a1b2c3d4", command: "npm run dev", tail: "" },
    },
    { expanded: false, isPartial: false },
    theme,
    { isError: false, durationMs: undefined, keyHint },
  );
  assert.equal(renderTrimmed(noDetails), "Cancelled bg_a1b2c3d4 · npm run dev");

  const errored = renderCancelResult(
    {
      content: [{ type: "text" as const, text: `No running job ${ESC}[31mbg_bad${ESC}[0m` }],
      details: undefined,
    },
    { expanded: false, isPartial: false },
    theme,
    { isError: true, durationMs: 10, keyHint },
  );
  assert.equal(renderTrimmed(errored), "No running job bg_bad");
});
