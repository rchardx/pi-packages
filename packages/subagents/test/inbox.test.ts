import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import {
  AgentInbox,
  formatAgentList,
  formatDeliveryReceipt,
  formatWaitOutcome,
} from "../src/inbox.ts";
import { Mailbox } from "../src/mailbox.ts";
import { MAX_WAIT_SECONDS } from "../src/protocol.ts";

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

test("Mailbox owns updates in arrival order and bounds only peer messages", async (t) => {
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
