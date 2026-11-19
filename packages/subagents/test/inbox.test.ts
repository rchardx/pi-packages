import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import {
  AgentInbox,
  formatAgentList,
  formatDeliveryReceipt,
  formatWaitOutcome,
} from "../src/inbox.ts";
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
  assert.equal(inbox.acceptMessage("m1", "main"), true);
  assert.equal(inbox.acceptMessage("m2", "main"), true);
  assert.equal(inbox.acceptMessage("m3", "main"), false, "exceeding maxMessages must fail closed");
  inbox.markMessageCommitted("m1");
  assert.equal(inbox.acceptMessage("m3", "main"), true);
  inbox.markMessageCommitted("m2");
  inbox.markMessageCommitted("m3");
  assert.equal(inbox.hasQueued(), false);
});

test("AgentInbox ends a wait when a messaged peer finishes without replying", async (t) => {
  keepAlive(t);
  const inbox = new AgentInbox();
  inbox.expectReplies(["main", "peer-a", "peer-b", "peer-c"]);

  // A subagent this child never messaged does not end the wait.
  inbox.peerFinished({ id: "stranger", status: "completed" });
  assert.equal(inbox.hasQueued(), false);

  const waiting = inbox.waitForUpdate(5);
  inbox.peerFinished({ id: "peer-a", status: "failed" });
  const woken = await waiting;
  assert.equal(woken.outcome, "peer_finished");
  assert.deepEqual(woken.outcome === "peer_finished" && woken.peers, [
    { id: "peer-a", status: "failed" },
  ]);
  assert.equal(inbox.hasQueued(), false, "a finished peer is reported once");

  // A peer that already replied is no longer awaited.
  assert.equal(inbox.acceptMessage("reply", "peer-b"), true);
  inbox.peerFinished({ id: "peer-b", status: "completed" });
  // A queued message is reported first; the finished peer is kept for the next wait.
  inbox.peerFinished({ id: "peer-c", status: "timed_out" });
  assert.deepEqual(await inbox.waitForUpdate(5), { outcome: "woke", waitedMs: 0 });
  inbox.markMessageCommitted("reply");
  assert.deepEqual(await inbox.waitForUpdate(5), {
    outcome: "peer_finished",
    waitedMs: 0,
    peers: [{ id: "peer-c", status: "timed_out" }],
  });

  // The root session is never awaited, and clearing forgets everything.
  inbox.peerFinished({ id: "main", status: "completed" });
  inbox.expectReplies(["peer-d"]);
  inbox.clear();
  inbox.peerFinished({ id: "peer-d", status: "cancelled" });
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

test("AgentInbox.wait handles immediate queue hits, idle sessions, wakeups, timeouts, and aborts", async (t) => {
  keepAlive(t);
  const prequeued = new AgentInbox();
  prequeued.acceptMessage("m-ready", "main");
  assert.deepEqual(await prequeued.wait(10), { outcome: "woke", waitedMs: 0 });
  prequeued.markMessageCommitted("m-ready");

  assert.deepEqual(await prequeued.wait(10, undefined, () => false), {
    outcome: "idle",
    waitedMs: 0,
  });

  const waking = new AgentInbox();
  setTimeout(() => {
    waking.acceptMessage("m-live", "main");
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
      { id: "child-1", self: true, role: "explorer", elapsedMs: 12_000, task: "Inspect config" },
      { id: "child-2", self: false, elapsedMs: 4_000, task: "Run checks" },
    ]),
    "Live agents in this session (3):\n" +
      "- main\n" +
      "- child-1 (self) · explorer · 12s · Inspect config\n" +
      "- child-2 · 4s · Run checks",
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
  assert.equal(
    formatWaitOutcome({ outcome: "timeout", waitedMs: 600_000, running: 2 }),
    "2 subagent(s) still running after 10m0s.",
  );
  assert.equal(
    formatWaitOutcome({
      outcome: "peer_finished",
      waitedMs: 5_000,
      peers: [
        { id: "peer-a", status: "timed_out" },
        { id: "peer-b", status: "completed" },
      ],
    }),
    "Subagent peer-a finished (timed out) without replying and can no longer send or receive messages.\n" +
      "Subagent peer-b finished (completed) without replying and can no longer send or receive messages.",
  );
});
