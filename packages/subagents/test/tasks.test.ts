import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  bounded,
  type DeliveryAck,
  type Launch,
  MAX_CONCURRENT,
  MAX_MESSAGE_BYTES,
  type MessageEnvelope,
  type Result,
} from "../src/protocol.ts";
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
  mcpTools: [],
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
function fake(onDeliver?: (envelope: MessageEnvelope) => DeliveryAck | Promise<DeliveryAck>) {
  const ready = deferred<void>();
  const done = deferred<Result>();
  const received: MessageEnvelope[] = [];
  let runs = 0;
  const execution: Execution = {
    ready: ready.promise,
    done: done.promise,
    run() {
      runs++;
    },
    async deliver(envelope) {
      if (onDeliver) return onDeliver(envelope);
      received.push(envelope);
      return { accepted: true };
    },
    cancel() {
      ready.reject(new Error("cancelled"));
      done.resolve({ ...completed, status: "cancelled" });
      return done.promise;
    },
  };
  void ready.promise.catch(() => {});
  return { execution, ready, done, received, runs: () => runs };
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
  assert.deepEqual(await tasks.cancel(id), { id, ...completed });
  await tasks.shutdown();
});

test("concurrent startups reserve capacity before any await and honor custom limits", async () => {
  const children = Array.from({ length: MAX_CONCURRENT }, fake);
  assert.equal(MAX_CONCURRENT, 8);
  let i = 0;
  let changes = 0;
  const tasks = new Tasks(
    () => {},
    () => {
      const child = children[i++];
      assert.ok(child);
      return child.execution;
    },
    () => {
      changes++;
    },
  );
  const pending = children.map(() => tasks.launch(launch));
  assert.equal(tasks.runningCount(), 0, "unhanded startups are not yet running");
  assert.equal(changes, 0);
  const observed = Promise.allSettled(pending);
  await assert.rejects(tasks.launch(launch), /At most 8/u);
  await tasks.shutdown();
  assert.ok((await observed).every((result) => result.status === "rejected"));
  assert.equal(tasks.records.size, 0);
  assert.equal(changes, 0, "aborted startups emit no running-count transitions");

  const limited = new Tasks(
    () => {},
    () => {
      const child = fake();
      child.ready.resolve();
      return child.execution;
    },
  );
  await limited.launch(launch, undefined, 1);
  assert.equal(limited.runningCount(), 1);
  await assert.rejects(limited.launch(launch, undefined, 1), /At most 1/u);
  await limited.shutdown();
  assert.equal(limited.runningCount(), 0);
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
  await assert.rejects(other.cancel(id), {
    message: `No subagent "${id}" in this session. Pass the full UUID returned by subagent; subagent_list shows those still running, and old terminal records expire.`,
  });
  // Padding around a known ID is ignored, as it is for a message recipient.
  assert.deepEqual(await tasks.cancel(` ${id}\n`), { id, ...completed, status: "cancelled" });
  assert.deepEqual(await tasks.cancel(id), { id, ...completed, status: "cancelled" });
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
  assert.ok(!report.includes("\uFFFD"));
});

test("messages route between the root session and its children only", async () => {
  const mainReceived: MessageEnvelope[] = [];
  let mainAccepts = true;
  const childA = fake();
  const childB = fake();
  const closingChild = fake(() => ({ accepted: false, reason: "finished" }));
  const fullChild = fake(() => ({ accepted: false, reason: "queue_full" }));
  const queue = [childA, childB, closingChild, fullChild];
  const sendToMain: ((message: string) => void)[] = [];

  const tasks = new Tasks(
    () => {},
    (_launch, options) => {
      const next = queue[sendToMain.length];
      assert.ok(next && options?.onSend);
      sendToMain.push(options.onSend);
      next.ready.resolve();
      return next.execution;
    },
    () => {},
    (envelope) => {
      if (!mainAccepts) return { accepted: false, reason: "queue_full" };
      mainReceived.push(envelope);
      return { accepted: true };
    },
  );

  const idA = await tasks.launch({ ...launch, role: "explorer", task: "Task A" });
  const idB = await tasks.launch({ ...launch, task: "Task B" });
  const idClosing = await tasks.launch({ ...launch, task: "Closing task" });
  const idFull = await tasks.launch({ ...launch, task: "Full queue task" });
  const [fromA, fromB] = sendToMain;
  assert.ok(fromA && fromB);

  assert.deepEqual(
    tasks.list().map(({ elapsedMs: _elapsedMs, ...entry }) => entry),
    [
      { id: idA, role: "explorer", task: "Task A" },
      { id: idB, task: "Task B" },
      { id: idClosing, task: "Closing task" },
      { id: idFull, task: "Full queue task" },
    ],
  );

  await assert.rejects(tasks.sendToChild(idA, "   "), /nonempty/u);
  await assert.rejects(tasks.sendToChild(idA, "x".repeat(MAX_MESSAGE_BYTES + 1)), /at most/u);
  await assert.rejects(tasks.sendToChild(idA.slice(0, 8), "hi"), {
    message: `No subagent "${idA.slice(0, 8)}" in this session. Pass the full UUID returned by subagent; subagent_list shows those still running, and old terminal records expire.`,
  });
  // The echoed ID is model input: bounded and stripped of terminal sequences.
  await assert.rejects(
    tasks.sendToChild(`\x1b[2J${"x".repeat(200)}`, "hi"),
    /^Error: No subagent "x{63}…" in this session\./u,
  );
  // The root session and broadcast are not recipients of a root message.
  await assert.rejects(
    tasks.sendToChild("main", "hi"),
    /Error: No subagent "main" in this session\./u,
  );
  await assert.rejects(tasks.sendToChild("*", "hi"), /Error: No subagent "\*" in this session\./u);

  assert.equal(await tasks.sendToChild(` ${idA} `, "correction"), idA);
  assert.equal(childA.received.length, 1);
  const toA = childA.received[0];
  assert.deepEqual(toA, { id: toA?.id, from: "main", to: idA, message: "correction" });

  // A child's message carries the sender the runtime knows, and reaches only the root.
  fromB("status update");
  assert.equal(mainReceived.length, 1);
  const toMain = mainReceived[0];
  assert.deepEqual(toMain, { id: toMain?.id, from: idB, to: "main", message: "status update" });
  assert.equal(childA.received.length, 1);
  assert.equal(childB.received.length, 0);
  assert.throws(() => fromA("   "), /nonempty/u);
  mainAccepts = false;
  assert.throws(() => fromA("overflow"), /Main session message queue is full/u);

  await assert.rejects(tasks.sendToChild(idClosing, "too late"), /already finished/u);
  await assert.rejects(tasks.sendToChild(idFull, "overflow"), /queue is full/u);

  childB.done.resolve(completed);
  await setImmediate();
  assert.ok(!tasks.list().some((entry) => entry.id === idB));
  await assert.rejects(
    tasks.sendToChild(idB, "post-completion message"),
    /already finished \(completed\) and cannot receive messages/u,
  );

  await tasks.shutdown();
  assert.deepEqual(tasks.list(), []);
  await assert.rejects(tasks.sendToChild(idA, "late"), /owning session has ended/u);
  assert.throws(() => fromA("late"), /owning session has ended/u);
});
