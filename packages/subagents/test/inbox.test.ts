import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { AgentInbox, formatAgentList, formatWaitOutcome } from "../src/inbox.ts";
import { Mailbox } from "../src/mailbox.ts";
import { MAX_ROOT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "../src/protocol.ts";

// Wait timers are unreferenced so they never keep a host process alive; hold the
// event loop open so a test awaiting only such a timer can finish.
function keepAlive(t: TestContext): void {
  const timer = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(timer));
}

test("AgentInbox bounds accepted messages until they are committed", () => {
  const inbox = new AgentInbox(2);
  assert.equal(inbox.hasQueued(), false);
  assert.equal(inbox.acceptMessage("m1"), true);
  assert.equal(inbox.acceptMessage("m2"), true);
  assert.equal(inbox.acceptMessage("m3"), false, "exceeding maxMessages must fail closed");
  inbox.markMessageCommitted("m1");
  assert.equal(inbox.acceptMessage("m3"), true);
  inbox.markMessageCommitted("m2");
  inbox.markMessageCommitted("m3");
  assert.equal(inbox.hasQueued(), false);
});

test("Mailbox owns updates in arrival order and bounds only subagent messages", async (t) => {
  keepAlive(t);
  const update = (content: string) => ({ customType: "test", content, details: { content } });
  const mailbox = new Mailbox(2);
  const waiting = mailbox.wait(5);
  assert.equal(mailbox.offerMessage(update("m1")), true);
  assert.equal((await waiting).outcome, "woke");
  mailbox.addResult(update("r1"));
  assert.equal(mailbox.offerMessage(update("m2")), true);
  assert.equal(mailbox.offerMessage(update("m3")), false, "a full mailbox rejects peer messages");
  mailbox.addResult(update("r2"));
  assert.deepEqual(await mailbox.wait(5), { outcome: "woke", waitedMs: 0 });

  assert.equal(mailbox.take()?.content, "m1");
  assert.equal(mailbox.offerMessage(update("m3")), true, "handing an update over frees capacity");
  assert.deepEqual(
    mailbox.drain().map((entry) => entry.content),
    ["r1", "m2", "r2", "m3"],
  );
  assert.equal(mailbox.hasQueued(), false);
  assert.equal(mailbox.take(), undefined);
  assert.deepEqual(await mailbox.wait(5, undefined, () => false), { outcome: "idle", waitedMs: 0 });
});

test("Mailbox.waitForUpdates reports queued completions and can hold them for all", async (t) => {
  keepAlive(t);
  const update = (content: string) => ({ customType: "test", content, details: { content } });
  const settled = async (promise: Promise<unknown>) => {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    // Longer than the wake coalescing window.
    await new Promise((resolve) => setTimeout(resolve, 60));
    return done;
  };

  // The last subagent ending wakes the wait just before its result is queued.
  let running = 1;
  const single = new Mailbox();
  const last = single.waitForUpdates(5, undefined, () => running, false);
  running = 0;
  single.wake();
  single.addResult(update("only result"));
  assert.equal((await last).outcome, "woke");
  single.drain();
  assert.deepEqual(
    await single.waitForUpdates(5, undefined, () => running, false),
    { outcome: "idle", waitedMs: 0 },
    "idle means nothing is running and nothing is queued",
  );

  running = 2;
  const mailbox = new Mailbox();
  const waiting = mailbox.waitForUpdates(5, undefined, () => running, true);
  running = 1;
  mailbox.addResult(update("first result"));
  assert.equal(await settled(waiting), false, "a completion does not end a wait for all");
  assert.deepEqual(await mailbox.waitForUpdates(5, undefined, () => running, false), {
    outcome: "woke",
    waitedMs: 0,
  });
  running = 0;
  mailbox.wake();
  mailbox.addResult(update("second result"));
  assert.equal((await waiting).outcome, "woke");
  assert.deepEqual(
    await mailbox.waitForUpdates(5, undefined, () => running, true),
    { outcome: "woke", waitedMs: 0 },
    "held completions are reported once nothing is running",
  );
  mailbox.drain();
  assert.deepEqual(await mailbox.waitForUpdates(5, undefined, () => running, true), {
    outcome: "idle",
    waitedMs: 0,
  });

  // A peer message ends a wait for all: its sender may need an answer.
  running = 1;
  const interrupted = mailbox.waitForUpdates(5, undefined, () => running, true);
  assert.equal(mailbox.offerMessage(update("question")), true);
  assert.equal((await interrupted).outcome, "woke");

  // Only a wait for all reports how many subagents are still running.
  const plainTimeout = await new Mailbox().waitForUpdates(0.04, undefined, () => 3, false);
  assert.deepEqual(Object.keys(plainTimeout).sort(), ["outcome", "waitedMs"]);
  const timedOut = await new Mailbox().waitForUpdates(0.04, undefined, () => 3, true);
  assert.equal(timedOut.outcome, "timeout");
  assert.equal("running" in timedOut && timedOut.running, 3);

  // The root session may wait longer than a child.
  const aborted = AbortSignal.abort();
  await assert.rejects(new Mailbox().wait(MAX_ROOT_WAIT_SECONDS, aborted), /Wait cancelled/u);
  await assert.rejects(new Mailbox().wait(MAX_ROOT_WAIT_SECONDS + 1), /at most 3600/u);
  await assert.rejects(new AgentInbox().wait(MAX_WAIT_SECONDS + 1), /at most 300/u);
});

test("Mailbox.waitForUpdates with ids filters completions, messages, idle checks, and timeouts", async (t) => {
  keepAlive(t);
  const update = (content: string) => ({ customType: "test", content, details: { content } });
  const settled = async (promise: Promise<unknown>) => {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    return done;
  };

  const mailbox = new Mailbox();
  const active = new Set(["a", "b", "c"]);
  const targets = new Set(["a", "b"]);
  const unsettledTargets = () => [...targets].filter((id) => active.has(id)).length;

  // Unrelated updates do not wake a scoped wait (neither any nor all).
  const waitAny = mailbox.waitForUpdates(5, undefined, unsettledTargets, false, targets);
  const waitAll = mailbox.waitForUpdates(5, undefined, unsettledTargets, true, targets);
  assert.equal(mailbox.offerMessage(update("msg from c"), "c"), true);
  active.delete("c");
  mailbox.wake();
  mailbox.addResult(update("result from c"), "c");
  assert.equal(await settled(waitAny), false, "unrelated updates must not wake scoped any-wait");
  assert.equal(await settled(waitAll), false, "unrelated updates must not wake scoped all-wait");

  // First targeted completion wakes any-wait, but all-wait keeps holding.
  active.delete("a");
  mailbox.wake();
  mailbox.addResult(update("result from a"), "a");
  assert.equal((await waitAny).outcome, "woke");
  assert.equal(await settled(waitAll), false, "first targeted completion must not end all-wait");

  // Second targeted completion ends all-wait; unrelated updates remain queued alongside.
  active.delete("b");
  mailbox.wake();
  mailbox.addResult(update("result from b"), "b");
  assert.equal((await waitAll).outcome, "woke");
  assert.deepEqual(
    mailbox.drain().map((entry) => entry.content),
    ["msg from c", "result from c", "result from a", "result from b"],
  );

  // When only unrelated updates are queued and targets are settled, scoped wait returns idle.
  mailbox.addResult(update("late result from c"), "c");
  assert.deepEqual(await mailbox.waitForUpdates(5, undefined, unsettledTargets, false, targets), {
    outcome: "idle",
    waitedMs: 0,
  });
  assert.deepEqual(await mailbox.waitForUpdates(5, undefined, unsettledTargets, true, targets), {
    outcome: "idle",
    waitedMs: 0,
  });
  mailbox.drain();

  // A message from a targeted subagent wakes a scoped all-wait early.
  active.add("a");
  const interrupted = mailbox.waitForUpdates(5, undefined, unsettledTargets, true, targets);
  assert.equal(mailbox.offerMessage(update("question from a"), "a"), true);
  assert.equal((await interrupted).outcome, "woke");
  mailbox.drain();

  // Scoped all-wait timeout counts only unsettled targeted subagents, not unrelated ones.
  active.add("c");
  const timedOut = await mailbox.waitForUpdates(0.04, undefined, unsettledTargets, true, targets);
  assert.equal(timedOut.outcome, "timeout");
  assert.equal("running" in timedOut && timedOut.running, 1);
});

test("AgentInbox.wait handles immediate queue hits, idle sessions, wakeups, timeouts, and aborts", async (t) => {
  keepAlive(t);
  const prequeued = new AgentInbox();
  prequeued.acceptMessage("m-ready");
  assert.deepEqual(await prequeued.wait(10), { outcome: "woke", waitedMs: 0 });
  prequeued.markMessageCommitted("m-ready");

  assert.deepEqual(await prequeued.wait(10, undefined, () => false), {
    outcome: "idle",
    waitedMs: 0,
  });

  const waking = new AgentInbox();
  setTimeout(() => {
    waking.acceptMessage("m-live");
  }, 15);
  const woke = await waking.wait(5);
  assert.equal(woke.outcome, "woke");

  let activeChildren = 1;
  const becomingIdle = new AgentInbox();
  setTimeout(() => {
    activeChildren = 0;
    becomingIdle.wake();
  }, 15);
  const idle = await becomingIdle.wait(5, undefined, () => activeChildren > 0);
  assert.equal(idle.outcome, "idle");

  const timedOut = await new AgentInbox().wait(0.04);
  assert.equal(timedOut.outcome, "timeout");

  const abortController = new AbortController();
  setTimeout(() => abortController.abort(), 15);
  await assert.rejects(new AgentInbox().wait(10, abortController.signal), /Wait cancelled/u);

  await assert.rejects(new AgentInbox().wait(0), /timeoutSeconds/u);
  await assert.rejects(new AgentInbox().wait(MAX_WAIT_SECONDS + 1), /timeoutSeconds/u);
});

test("formatting helpers produce concise subagent listings and wait outcomes", () => {
  assert.equal(formatAgentList([]), "No subagents running.");
  assert.equal(
    formatAgentList([
      { id: "child-1", role: "explorer", elapsedMs: 12_000, task: "Inspect config" },
      { id: "child-2", elapsedMs: 4_000, task: "Run checks" },
    ]),
    "Running subagents (2):\n" +
      "- child-1 · explorer · 12s · Inspect config\n" +
      "- child-2 · 4s · Run checks",
  );
  assert.match(formatWaitOutcome({ outcome: "woke", waitedMs: 10 }), /Incoming update queued/u);
  assert.match(formatWaitOutcome({ outcome: "idle", waitedMs: 0 }), /No running subagents/u);
  assert.equal(
    formatWaitOutcome({ outcome: "idle", waitedMs: 0 }, true),
    "No targeted subagents remain running or have queued updates.",
  );
  assert.match(formatWaitOutcome({ outcome: "timeout", waitedMs: 5_000 }), /within 5s/u);
  assert.equal(
    formatWaitOutcome({ outcome: "timeout", waitedMs: 5_000 }, true),
    "No matching updates arrived within 5s.",
  );
  assert.equal(
    formatWaitOutcome({ outcome: "timeout", waitedMs: 600_000, running: 2 }),
    "2 subagent(s) still running after 10m0s.",
  );
  assert.equal(
    formatWaitOutcome({ outcome: "timeout", waitedMs: 600_000, running: 2 }, true),
    "2 targeted subagent(s) still running after 10m0s.",
  );
});
