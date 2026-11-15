import assert from "node:assert/strict";
import { test } from "node:test";
import { TailBuffer, type JobRecord } from "../src/jobs.ts";
import {
  buildNotification,
  formatDuration,
  oneLine,
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
  assert.match(success.content, /Output log: \/tmp\/jobs\/sess\/bg_a1b2c3d4\.log/u);
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
  const collapsed = renderNotification({ details }, { expanded: false }, theme);
  const expanded = renderNotification({ details }, { expanded: true }, theme);
  assert.ok(collapsed && expanded);
  const render = (component: typeof collapsed): string => component.render(120).join("\n");
  assert.match(render(collapsed), /bg_a1b2c3d4 npm test · exit 0 · 1m12s/u);
  assert.doesNotMatch(render(collapsed), /line of output/u);
  assert.match(render(expanded), /line of output/u);
  assert.match(render(expanded), /bg_a1b2c3d4\.log/u);
  assert.equal(renderNotification({}, { expanded: false }, theme), undefined);
});
