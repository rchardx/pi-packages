import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import {
  AgentInbox,
  formatAgentList,
  formatDeliveryReceipt,
  formatWaitOutcome,
} from "../src/inbox.ts";
import { MAX_WAIT_SECONDS } from "../src/protocol.ts";

// Wait timers are unreferenced so they never keep a host process alive; hold the
// event loop open so a test awaiting only such a timer can finish.
function keepAlive(t: TestContext): void {
  const timer = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(timer));
}

test("AgentInbox enforces peer queue bounds while keeping completion events unblocked", () => {
  const inbox = new AgentInbox(2);
  assert.equal(inbox.hasQueued(), false);
  assert.equal(inbox.acceptMessage("m1"), true);
  assert.equal(inbox.acceptMessage("m2"), true);
  assert.equal(inbox.acceptMessage("m3"), false, "exceeding maxMessages must fail closed");
  assert.equal(inbox.queuedMessageCount(), 2);

  inbox.acceptEvent("e1");
  inbox.markMessageCommitted("m1");
  inbox.markMessageCommitted("m2");
  assert.equal(inbox.hasQueued(), true, "uncommitted completion event keeps inbox active");
  inbox.markEventCommitted("e1");
  assert.equal(inbox.hasQueued(), false);
});

test("AgentInbox.discardQueued releases uncommitted records without waking waiters", async (t) => {
  keepAlive(t);
  const inbox = new AgentInbox(1);
  const waiting = inbox.wait(0.08);
  assert.equal(inbox.acceptMessage("m1"), true);
  inbox.acceptEvent("e1");
  assert.equal(inbox.acceptMessage("m2"), false);
  assert.equal((await waiting).outcome, "woke");

  const idleWaiter = new AgentInbox(1);
  const pending = idleWaiter.wait(0.08);
  idleWaiter.discardQueued();
  assert.equal((await pending).outcome, "timeout");

  inbox.discardQueued();
  assert.equal(inbox.hasQueued(), false);
  assert.equal(inbox.acceptMessage("m2"), true, "discarded records free queue capacity");
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

test("formatting helpers produce concise agent listings, receipts, and wait outcomes", () => {
  assert.equal(
    formatAgentList([
      { id: "main", self: false },
      { id: "child-1", self: true, elapsedMs: 12_000, task: "Inspect config" },
    ]),
    "Live agents in this session (2):\n- main\n- child-1 (self) · 12s · Inspect config",
  );
  assert.match(
    formatDeliveryReceipt({
      id: "msg-1",
      from: "main",
      to: "child-1",
      broadcast: false,
      delivered: ["child-1"],
      skipped: [],
    }),
    /Queued message for child-1/u,
  );
  assert.equal(
    formatDeliveryReceipt({
      id: "msg-2",
      from: "main",
      to: "*",
      broadcast: true,
      delivered: [],
      skipped: [],
    }),
    "No live peers to broadcast to.",
  );
  assert.match(
    formatDeliveryReceipt({
      id: "msg-3",
      from: "main",
      to: "*",
      broadcast: true,
      delivered: ["child-1"],
      skipped: [{ id: "child-2", reason: "completed" }],
    }),
    /Broadcast queued for 1 of 2 peer\(s\)\.\n- child-2: skipped \(completed\)/u,
  );
  assert.match(formatWaitOutcome({ outcome: "woke", waitedMs: 10 }), /Incoming update queued/u);
  assert.match(formatWaitOutcome({ outcome: "idle", waitedMs: 0 }), /No running subagents/u);
  assert.match(formatWaitOutcome({ outcome: "timeout", waitedMs: 5_000 }), /within 5s/u);
});
