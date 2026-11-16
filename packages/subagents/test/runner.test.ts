import assert from "node:assert/strict";
import { test } from "node:test";
import type { Launch } from "../src/protocol.ts";
import { startChild } from "../src/runner.ts";

const launch: Launch = {
  cwd: process.cwd(),
  provider: "test",
  model: "test",
  thinking: "off",
  trusted: false,
  extensions: [],
  activeTools: [],
  requiredTools: [],
  mcpTools: [],
  task: "Task",
};
const success = { status: "completed", report: "done", requests: 1, tokens: 10 };
function script(body: string) {
  return [
    "-e",
    `process.stdin.resume(); process.send({type:'hello'}); process.on('message',m=>{if(m.type==='configure'){${body}}});`,
  ];
}

test("IPC handshake starts only after handoff and drains large stdout", async () => {
  const execution = startChild(launch, {
    args: script(
      `process.stdout.write('x'.repeat(100000));process.send({type:'ready'});process.on('message',m=>{if(m.type==='run'){process.send({type:'result',result:${JSON.stringify(success)}},()=>process.exit(0));}});`,
    ),
  });
  await execution.ready;
  execution.run();
  assert.deepEqual(await execution.done, success);
});

test("exit zero without a terminal result is a failure", async () => {
  const execution = startChild(launch, { args: script("process.exit(0)") });
  await assert.rejects(execution.ready, /before startup/u);
  assert.equal((await execution.done).status, "failed");
});

test("startup timeout and execution deadline are bounded", async () => {
  const startup = startChild(launch, {
    args: script("setInterval(()=>{},1000)"),
    startupMs: 50,
    graceMs: 20,
  });
  await assert.rejects(startup.ready, /timed out/u);
  assert.equal((await startup.done).status, "timed_out");
  const running = startChild(launch, {
    args: script("process.send({type:'ready'});setInterval(()=>{},1000)"),
    deadlineMs: 250,
    graceMs: 20,
  });
  await running.ready;
  running.run();
  assert.equal((await running.done).status, "timed_out");
});

test("cancel escalates when a child ignores SIGTERM", async () => {
  const execution = startChild(launch, {
    args: script(
      "process.on('SIGTERM',()=>{});process.send({type:'ready'});setInterval(()=>{},1000)",
    ),
    graceMs: 30,
  });
  await execution.ready;
  assert.equal((await execution.cancel()).status, "cancelled");
  assert.equal((await execution.cancel()).status, "cancelled");
});

test("startup errors, invalid results, and spawn failures are explicit", async () => {
  const bad = startChild(launch, {
    args: script("process.send({type:'startup_error',error:'missing tool'});"),
  });
  await assert.rejects(bad.ready, /missing tool/u);
  assert.equal((await bad.done).status, "failed");
  const invalid = startChild(launch, {
    args: script(
      "process.send({type:'ready'});process.send({type:'result',result:{status:'completed'}});",
    ),
  });
  await invalid.ready.catch(() => {});
  assert.match((await invalid.done).report, /Invalid child result/u);
  const missing = startChild(launch, { command: "/nonexistent/pi-subagents-node", args: [] });
  await assert.rejects(missing.ready);
  assert.equal((await missing.done).status, "failed");
});

test("IPC messaging handles delivery acks, list/send requests, and exit during delivery", async () => {
  const execution = startChild(
    { ...launch, id: "child-uuid" },
    {
      args: script(
        `process.send({type:'ready'});
         process.on('message', m => {
           if (m.type === 'deliver') {
             if (m.envelope.message === 'accept') process.send({type:'delivery_ack', deliveryId: m.deliveryId, accepted: true});
             else if (m.envelope.message === 'full') process.send({type:'delivery_ack', deliveryId: m.deliveryId, accepted: false, reason: 'queue_full'});
             else process.exit(0);
           }
           if (m.type === 'run') {
             process.send({type:'list', requestId:'r1'});
           }
           if (m.type === 'list_result' && m.requestId === 'r1') {
             process.send({type:'send', requestId:'r2', to:'main', message: String(m.agents.length)});
           }
           if (m.type === 'send_result' && m.requestId === 'r2') {
             process.send({type:'result', result:${JSON.stringify(success)}}, () => process.exit(0));
           }
         });`,
      ),
      handlers: {
        onList: () => [
          { id: "main", self: false },
          { id: "child-uuid", self: true },
        ],
        onSend: async (to, message) => ({
          id: "m1",
          from: "child-uuid",
          to,
          broadcast: false,
          delivered: [to],
          skipped: message === "2" ? [] : [{ id: "bad", reason: "unexpected" }],
        }),
      },
    },
  );
  await execution.ready;
  assert.deepEqual(
    await execution.deliver({
      id: "e1",
      from: "main",
      to: "child-uuid",
      broadcast: false,
      message: "accept",
      sentAt: 1,
    }),
    { accepted: true },
  );
  assert.deepEqual(
    await execution.deliver({
      id: "e2",
      from: "main",
      to: "child-uuid",
      broadcast: false,
      message: "full",
      sentAt: 2,
    }),
    { accepted: false, reason: "queue_full" },
  );
  execution.run();
  assert.deepEqual(await execution.done, success);

  // Delivery to an exiting child resolves cleanly as finished without hanging.
  const exiting = startChild(launch, {
    args: script(
      "process.send({type:'ready'}); process.on('message', m => { if (m.type === 'deliver') process.exit(0); });",
    ),
  });
  await exiting.ready;
  assert.deepEqual(
    await exiting.deliver({
      id: "e3",
      from: "main",
      to: "child",
      broadcast: false,
      message: "exit",
      sentAt: 3,
    }),
    { accepted: false, reason: "finished" },
  );
  assert.equal((await exiting.done).status, "failed");
});
