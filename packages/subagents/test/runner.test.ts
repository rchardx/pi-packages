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

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch {
      if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
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
  assert.equal(pendingCancel.accepted, true);
  assert.deepEqual(execution.tryCancel(), { accepted: false, reason: "stopping" });
  const cancelled = await pendingCancel.done;
  assert.deepEqual(cancelled, {
    status: "cancelled",
    report:
      "Cancelled; existing filesystem changes were not reverted.\n\nRecent tool activity:\n- bash (interrupted)",
    requests: 2,
    tokens: 45,
  });
  assert.deepEqual(execution.tryCancel(), { accepted: false, reason: "finished" });
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
  await waitForFile(sigtermFlag);
  assert.deepEqual(timedOut.tryCancel(), { accepted: false, reason: "stopping" });
  await writeFile(releaseFlag, "");
  assert.deepEqual(await timedOut.done, {
    status: "timed_out",
    report: "Child execution deadline exceeded.\n\nLast assistant message:\nHalfway done.",
    requests: 3,
    tokens: 95,
  });
});

if (process.platform !== "win32") {
  test("process-group cleanup reaps descendants, locks exit before close, and ignores EPERM", async (t: TestContext) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-runner-pgroup-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    // 1. Descendant ignores SIGTERM for 5s while direct child exits immediately: cancel escalates at graceMs.
    const stubbornPidFile = join(dir, "stubborn.pid");
    const stubborn = startChild(launch, {
      args: script(
        `const { spawn } = require('node:child_process');
         spawn(process.execPath, [
           '-e',
           'const fs=require("node:fs"); process.on("SIGTERM",()=>{ setTimeout(()=>process.exit(0),5000); }); fs.writeFileSync(${JSON.stringify(`${stubbornPidFile}.tmp`)}, String(process.pid)); fs.renameSync(${JSON.stringify(`${stubbornPidFile}.tmp`)}, ${JSON.stringify(stubbornPidFile)}); setInterval(()=>{},1000);'
         ], { stdio: 'ignore' });
         process.on('SIGTERM', () => process.exit(0));
         process.send({type:'ready'});
         setInterval(()=>{},1000);`,
      ),
      graceMs: 150,
    });
    t.after(() => stubborn.cancel());
    await stubborn.ready;
    stubborn.run();
    const stubbornPid = Number(await waitForFile(stubbornPidFile));
    assert.ok(stubbornPid > 0);
    process.kill(stubbornPid, 0);

    const startedAt = performance.now();
    const stubbornClaim = stubborn.tryCancel();
    assert.equal(stubbornClaim.accepted, true);
    const cancelled = await stubbornClaim.done;
    assert.equal(cancelled.status, "cancelled");
    assert.ok(performance.now() - startedAt >= 120);
    assert.throws(() => process.kill(stubbornPid, 0), { code: "ESRCH" });

    // 2. Descendant exits cleanly on SIGTERM after direct child exits: resolves before graceMs without SIGKILL wait.
    const gracefulPidFile = join(dir, "graceful.pid");
    const graceful = startChild(launch, {
      args: script(
        `const { spawn } = require('node:child_process');
         spawn(process.execPath, [
           '-e',
           'const fs=require("node:fs"); process.on("SIGTERM",()=>{ setTimeout(()=>process.exit(0),60); }); fs.writeFileSync(${JSON.stringify(`${gracefulPidFile}.tmp`)}, String(process.pid)); fs.renameSync(${JSON.stringify(`${gracefulPidFile}.tmp`)}, ${JSON.stringify(gracefulPidFile)}); setInterval(()=>{},1000);'
         ], { stdio: 'ignore' });
         process.on('SIGTERM', () => process.exit(0));
         process.send({type:'ready'});
         setInterval(()=>{},1000);`,
      ),
      graceMs: 2_000,
    });
    t.after(() => graceful.cancel());
    await graceful.ready;
    graceful.run();
    const gracefulPid = Number(await waitForFile(gracefulPidFile));
    assert.ok(gracefulPid > 0);
    const gracefulStart = performance.now();
    const gracefulClaim = graceful.tryCancel();
    assert.equal(gracefulClaim.accepted, true);
    const gracefulCancelled = await gracefulClaim.done;
    assert.equal(gracefulCancelled.status, "cancelled");
    assert.ok(performance.now() - gracefulStart < 1_000);
    assert.throws(() => process.kill(gracefulPid, 0), { code: "ESRCH" });

    // 3. Direct child completes and exits 0 while a stdio-inheriting descendant holds pipes open:
    //    exit locks completion, rejects late tryCancel as "finished", and reaps the descendant so close settles.
    const leaderPidFile = join(dir, "leader.pid");
    const inheritedPidFile = join(dir, "inherited.pid");
    const inherited = startChild(launch, {
      args: script(
        `const fs = require('node:fs');
         const { spawn } = require('node:child_process');
         fs.writeFileSync(${JSON.stringify(`${leaderPidFile}.tmp`)}, String(process.pid));
         fs.renameSync(${JSON.stringify(`${leaderPidFile}.tmp`)}, ${JSON.stringify(leaderPidFile)});
         process.send({type:'ready'});
         process.on('message', m => {
           if (m.type !== 'run') return;
           spawn(process.execPath, [
             '-e',
             'const fs=require("node:fs"); process.on("SIGTERM",()=>{ setTimeout(()=>process.exit(0),5000); }); fs.writeFileSync(${JSON.stringify(`${inheritedPidFile}.tmp`)}, String(process.pid)); fs.renameSync(${JSON.stringify(`${inheritedPidFile}.tmp`)}, ${JSON.stringify(inheritedPidFile)}); setInterval(()=>{},1000);'
           ], { stdio: 'inherit' });
           const waitDesc = setInterval(() => {
             if (!fs.existsSync(${JSON.stringify(inheritedPidFile)})) return;
             clearInterval(waitDesc);
             process.send({type:'result', result:${JSON.stringify(success)}}, () => process.exit(0));
           }, 10);
         });`,
      ),
      graceMs: 150,
    });
    t.after(() => inherited.cancel());
    await inherited.ready;
    inherited.run();
    const leaderPid = Number(await waitForFile(leaderPidFile));
    const inheritedPid = Number(await waitForFile(inheritedPidFile));
    const exitDeadline = Date.now() + 5_000;
    for (;;) {
      try {
        process.kill(leaderPid, 0);
        if (Date.now() >= exitDeadline) assert.fail("Timed out waiting for leader exit");
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch (error) {
        assert.deepEqual((error as NodeJS.ErrnoException).code, "ESRCH");
        break;
      }
    }
    process.kill(inheritedPid, 0);
    assert.deepEqual(inherited.tryCancel(), { accepted: false, reason: "finished" });
    assert.deepEqual(await inherited.done, success);
    assert.throws(() => process.kill(inheritedPid, 0), { code: "ESRCH" });

    // 4. EPERM on process-group signals neither crashes the parent nor stalls settlement.
    const realKill = process.kill.bind(process);
    const killMock = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
      if (pid < 0) {
        throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
      }
      return realKill(pid, signal);
    });
    try {
      const epermChild = startChild(launch, {
        args: script(
          `process.send({type:'ready'});
           process.on('message', m => {
             if (m.type === 'run') process.send({type:'result', result:${JSON.stringify(success)}}, () => process.exit(0));
           });`,
        ),
        graceMs: 2_000,
      });
      await epermChild.ready;
      epermChild.run();
      const epermStart = performance.now();
      assert.deepEqual(await epermChild.done, success);
      assert.ok(performance.now() - epermStart < 1_000);
    } finally {
      killMock.mock.restore();
    }
  });
}

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
