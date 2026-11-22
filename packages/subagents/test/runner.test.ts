import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
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

test("cancel escalates when a child ignores SIGTERM and retains prior progress", async () => {
  let progressReceived: () => void = () => {};
  const afterProgress = new Promise<void>((resolve) => {
    progressReceived = resolve;
  });
  const execution = startChild(launch, {
    args: script(
      `process.on('SIGTERM',()=>{});
       process.send({type:'ready'});
       process.on('message', m => {
         if (m.type === 'run') {
           process.send({type:'progress', progress:{requests:2, tokens:45, partial:'Recent tool activity:\\n- bash (interrupted)'}});
           process.send({type:'progress', progress:{requests:-1, tokens:0}});
           process.send({type:'send', requestId:'after-progress', message:'sync'});
         }
       });
       setInterval(()=>{},1000)`,
    ),
    graceMs: 30,
    // IPC messages arrive in order, so this request follows both progress updates.
    onSend: () => progressReceived(),
  });
  await execution.ready;
  execution.run();
  await afterProgress;
  const pendingCancel = execution.tryCancel();
  assert.ok(pendingCancel);
  assert.equal(execution.tryCancel(), undefined);
  const cancelled = await pendingCancel;
  assert.deepEqual(cancelled, {
    status: "cancelled",
    report:
      "Cancelled; existing filesystem changes were not reverted.\n\nRecent tool activity:\n- bash (interrupted)",
    requests: 2,
    tokens: 45,
  });
  assert.equal(execution.tryCancel(), undefined);
  assert.deepEqual(await execution.cancel(), cancelled);
});

test("deadline timeout preserves child progress, rejects tryCancel during SIGTERM flush, and keeps timed_out", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-runner-timeout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sigtermFlag = join(dir, "sigterm.flag");
  const releaseFlag = join(dir, "release.flag");
  const timedOut = startChild(launch, {
    args: script(
      `const fs = require('node:fs');
       process.send({type:'ready'});
       process.on('SIGTERM', () => {
         fs.writeFileSync(${JSON.stringify(sigtermFlag)}, '');
         const poll = setInterval(() => {
           if (!fs.existsSync(${JSON.stringify(releaseFlag)})) return;
           clearInterval(poll);
           process.send(
             {type:'progress', progress:{requests:3, tokens:90, partial:'Last assistant message:\\nHalfway done.'}},
             () => process.send({type:'result', result:{status:'cancelled', report:'aborted', requests:3, tokens:95}}, () => process.exit(143))
           );
         }, 10);
       });
       setInterval(()=>{},1000);`,
    ),
    // The deadline counts from spawn; leave room for a slow child to report ready first.
    deadlineMs: 1_000,
    graceMs: 2_000,
  });
  await timedOut.ready;
  timedOut.run();
  const waitUntil = Date.now() + 5_000;
  while (Date.now() < waitUntil) {
    try {
      await readFile(sigtermFlag);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await readFile(sigtermFlag);
  assert.equal(timedOut.tryCancel(), undefined);
  await writeFile(releaseFlag, "");
  assert.deepEqual(await timedOut.done, {
    status: "timed_out",
    report: "Child execution deadline exceeded.\n\nLast assistant message:\nHalfway done.",
    requests: 3,
    tokens: 95,
  });
});

test("unexpected crash preserves prior child progress and stderr", async () => {
  const crashed = startChild(launch, {
    args: script(
      `process.send({type:'ready'});
       process.on('message', m => {
         if (m.type === 'run') {
           process.send({type:'progress', progress:{requests:1, tokens:12, partial:'Recent tool activity:\\n- write out.txt'}}, () => {
             process.stderr.write('boom\\n');
             process.exit(2);
           });
         }
       });`,
    ),
  });
  await crashed.ready;
  crashed.run();
  assert.deepEqual(await crashed.done, {
    status: "failed",
    report:
      "Child exited without successful teardown (exit 2).\nboom\n\nRecent tool activity:\n- write out.txt",
    requests: 1,
    tokens: 12,
  });
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

test("IPC messaging handles delivery acks, child sends, and exit during delivery", async () => {
  const received: string[] = [];
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
             process.send({type:'send', requestId:'r1', message:'question'});
           }
           if (m.type === 'send_result' && m.requestId === 'r1') {
             process.send({type:'send', requestId:'r2', message: 'error' in m ? 'unexpected' : 'overflow'});
           }
           if (m.type === 'send_result' && m.requestId === 'r2') {
             process.send({type:'result', result:{status:'completed', report:String(m.error), requests:1, tokens:10}}, () => process.exit(0));
           }
         });`,
      ),
      onSend: (message) => {
        received.push(message);
        if (message === "overflow") throw new Error("Main session message queue is full.");
      },
    },
  );
  await execution.ready;
  assert.deepEqual(
    await execution.deliver({
      id: "e1",
      from: "main",
      to: "child-uuid",
      message: "accept",
    }),
    { accepted: true },
  );
  assert.deepEqual(
    await execution.deliver({
      id: "e2",
      from: "main",
      to: "child-uuid",
      message: "full",
    }),
    { accepted: false, reason: "queue_full" },
  );
  execution.run();
  assert.deepEqual(await execution.done, {
    ...success,
    report: "Main session message queue is full.",
  });
  assert.deepEqual(received, ["question", "overflow"]);

  // A child's message has nowhere to go without a handler, and says so.
  const unrouted = startChild(launch, {
    args: script(
      `process.send({type:'ready'});
       process.on('message', m => {
         if (m.type === 'run') process.send({type:'send', requestId:'r1', message:'question'});
         if (m.type === 'send_result') {
           process.send({type:'result', result:{status:'completed', report:String(m.error), requests:1, tokens:10}}, () => process.exit(0));
         }
       });`,
    ),
  });
  await unrouted.ready;
  unrouted.run();
  assert.equal((await unrouted.done).report, "Agent messaging is unavailable.");

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
      message: "exit",
    }),
    { accepted: false, reason: "finished" },
  );
  assert.equal((await exiting.done).status, "failed");
});
