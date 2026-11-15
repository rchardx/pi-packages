import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { bounded, MAX_CONCURRENT, type Launch, type Result } from "../src/protocol.ts";
import type { Execution } from "../src/runner.ts";
import { Tasks } from "../src/tasks.ts";

export const launch: Launch = {
  cwd: process.cwd(),
  provider: "test",
  model: "test",
  thinking: "off",
  trusted: false,
  extensions: [],
  activeTools: ["read", "write", "bash"],
  requiredTools: ["read", "write", "bash"],
  task: "Task",
};
const completed: Result = { status: "completed", report: "done", requests: 1, tokens: 10 };
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fake() {
  const ready = deferred<void>();
  const done = deferred<Result>();
  let runs = 0;
  const execution: Execution = {
    ready: ready.promise,
    done: done.promise,
    run() {
      runs++;
    },
    cancel() {
      ready.reject(new Error("cancelled"));
      done.resolve({ ...completed, status: "cancelled" });
      return done.promise;
    },
  };
  void ready.promise.catch(() => {});
  return { execution, ready, done, runs: () => runs };
}

test("background handoff returns a UUID, survives turn abort, and reports once", async () => {
  const f = fake();
  const results: Result[] = [];
  const tasks = new Tasks(
    (_task, result) => results.push(result),
    () => f.execution,
  );
  const turn = new AbortController();
  const starting = tasks.launch(launch, turn.signal);
  f.ready.resolve();
  const id = await starting;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  turn.abort();
  await setImmediate();
  assert.equal(f.runs(), 1);
  assert.equal(results.length, 0);
  f.done.resolve(completed);
  await setImmediate();
  assert.deepEqual(results, [completed]);
  assert.deepEqual(await tasks.cancel(id), completed);
  await tasks.shutdown();
});

test("concurrent startups reserve capacity before any await", async () => {
  const children = Array.from({ length: MAX_CONCURRENT }, fake);
  let i = 0;
  const tasks = new Tasks(
    () => {},
    () => {
      const child = children[i++];
      assert.ok(child);
      return child.execution;
    },
  );
  const pending = children.map(() => tasks.launch(launch));
  const observed = Promise.allSettled(pending);
  await assert.rejects(tasks.launch(launch), /At most 4/u);
  await tasks.shutdown();
  assert.ok((await observed).every((result) => result.status === "rejected"));
  assert.equal(tasks.records.size, 0);
});

test("startup cancellation, startup failure, and shutdown leave no orphan", async () => {
  for (const kind of ["abort", "failure", "shutdown"]) {
    const f = fake();
    const tasks = new Tasks(
      () => assert.fail("must not notify"),
      () => f.execution,
    );
    const controller = new AbortController();
    const pending = tasks.launch(launch, controller.signal);
    const rejected = assert.rejects(pending);
    if (kind === "abort") controller.abort();
    else if (kind === "failure") f.ready.reject(new Error("load failure"));
    else await tasks.shutdown();
    await rejected;
    assert.equal(tasks.records.size, 0);
  }
});

test("explicit cancellation is quiet and IDs cannot cross owners", async () => {
  const f = fake();
  const tasks = new Tasks(
    () => assert.fail("cancel must not notify"),
    () => f.execution,
  );
  f.ready.resolve();
  const id = await tasks.launch(launch);
  const other = new Tasks(() => {});
  await assert.rejects(other.cancel(id), /Unknown/u);
  assert.equal((await tasks.cancel(id)).status, "cancelled");
  assert.equal((await tasks.cancel(id)).status, "cancelled");
  await tasks.shutdown();
  await assert.rejects(tasks.launch(launch), /ended/u);
});

test("a child-side abort still reports unless cancellation was explicitly requested", async () => {
  const f = fake();
  const results: Result[] = [];
  const tasks = new Tasks(
    (_task, result) => results.push(result),
    () => f.execution,
  );
  f.ready.resolve();
  await tasks.launch(launch);
  await setImmediate();
  f.done.resolve({ ...completed, status: "cancelled" });
  await setImmediate();
  assert.equal(results[0]?.status, "cancelled");
  await tasks.shutdown();
});

test("UTF-8 reports are bounded with an explicit truncation marker", () => {
  const report = bounded("中文😀".repeat(200), 100);
  assert.ok(Buffer.byteLength(report) <= 100);
  assert.ok(report.endsWith("[truncated]"));
  assert.ok(!report.includes("�"));
});
