import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import fsPromises, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

function nodeScript(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

async function loadSession(
  t: TestContext,
  mode: "tui" | "rpc" | "print" | "json" = "tui",
  settings?: { shellCommandPrefix?: string; shellPath?: string },
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-background-extension-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const settingsManager = SettingsManager.inMemory(settings ?? {});
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: join(directory, "models.json"),
    modelsStorePath: join(directory, "catalog.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader: loader,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(directory),
    tools: ["bash"],
  });
  t.after(async () => {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  // SDK sessions default to print-mode bindings; bind the mode under test.
  const notices: string[] = [];
  const statuses = new Map<string, string>();
  await session.bindExtensions({
    mode,
    uiContext: {
      ...session.extensionRunner.createContext().ui,
      notify: (message) => {
        notices.push(message);
      },
      setStatus: (key, text) => {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
    },
  });
  assert.deepEqual(session.getActiveToolNames(), ["bash"]);
  const tool = session.agent.state.tools.find((candidate) => candidate.name === "bash");
  assert.ok(tool);
  return { session, directory, tool, notices, statuses };
}

function textOf(result: { content: unknown }): string {
  const content = result.content as { type: string; text?: string }[];
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

/** Wait until predicate() returns a value or the deadline passes. */
async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function notificationMessages(session: {
  messages: unknown;
}): { customType: string; content: string; details: unknown }[] {
  const messages = session.messages as {
    role: string;
    customType?: string;
    content?: string;
    details?: unknown;
  }[];
  return messages
    .filter((message) => message.role === "custom")
    .map((message) => ({
      customType: message.customType ?? "",
      content: typeof message.content === "string" ? message.content : "",
      details: message.details,
    }));
}

test("/background is a user command and reports an empty session without a model turn", async (t) => {
  const { session, notices, statuses } = await loadSession(t);
  assert.equal(statuses.has("background"), false);
  const command = session.extensionRunner.getCommand("background");
  assert.ok(command);
  assert.equal(session.extensionRunner.getCommand("bg"), undefined);
  assert.equal(session.extensionRunner.getCommand("ps"), undefined);
  assert.deepEqual(session.getActiveToolNames(), ["bash"]);
  const messages = [...session.messages];
  await session.prompt("/background");
  assert.deepEqual(notices, ["No background jobs running."]);
  assert.deepEqual(session.messages, messages);
});

for (const mode of ["tui", "rpc"] as const) {
  test(`/background shows a read-only snapshot of running jobs in ${mode}`, async (t) => {
    const { session, directory, tool, notices, statuses } = await loadSession(t, mode);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const idle = nodeScript("setTimeout(() => {}, 30000)");
    const firstLine = `printf '中文 ${"long command ".repeat(10)}'`;
    const commands = [idle, `${firstLine}\n${idle}`];
    const ids: string[] = [];
    for (const command of commands) {
      const started = await tool.execute(`snapshot-${ids.length}`, { command, background: true });
      const id = /Started background job (bg_[0-9a-f]{8})\./u.exec(textOf(started))?.[1];
      assert.ok(id);
      ids.push(id);
      assert.equal(statuses.get("background"), `bg: ${ids.length} running · /background`);
    }
    // Listing is independent of config parsing and never modifies model context.
    await writeFile(join(directory, "background.json"), "{");
    const messages = [...session.messages];
    now += 72_000;
    await session.prompt("/background");
    assert.equal(notices.length, 1);
    assert.equal(
      notices[0],
      `Background jobs · 2 running\n\n${ids[0]}  running  1m12s\n  ${idle}\n\n` +
        `${ids[1]}  running  1m12s\n  ${firstLine}\n  ${idle}`,
    );
    assert.deepEqual(session.messages, messages);
    now += 1000;
    await session.prompt("/background");
    assert.equal(notices.length, 2);
    assert.ok(notices[1]?.includes("running  1m13s"));
    assert.deepEqual(session.messages, messages);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(statuses.has("background"), false);
    await session.prompt("/background");
    assert.equal(notices.at(-1), "No background jobs running.");
  });
}

test("footer counts fall on success and failure without changing other status entries", async (t) => {
  const { session, directory, tool, statuses } = await loadSession(t);
  statuses.set("other-extension", "unchanged");
  for (const exitCode of [0, 2]) {
    const script = `const fs = require('node:fs'); const finish = () => {
      if (!fs.existsSync('finish-${exitCode}')) return;
      watcher.close(); process.exitCode = ${exitCode};
    }; const watcher = fs.watch('.', finish); finish();`.replaceAll("\n", " ");
    await tool.execute(`footer-${exitCode}`, { command: nodeScript(script), background: true });
  }
  assert.equal(statuses.get("background"), "bg: 2 running · /background");
  await writeFile(join(directory, "finish-0"), "finish");
  await waitFor(() =>
    notificationMessages(session).find((message) => message.content.includes("exited with code 0")),
  );
  assert.equal(statuses.get("background"), "bg: 1 running · /background");
  await writeFile(join(directory, "finish-2"), "finish");
  await waitFor(() =>
    notificationMessages(session).find((message) => message.content.includes("exited with code 2")),
  );
  assert.equal(statuses.has("background"), false);
  assert.equal(statuses.get("other-extension"), "unchanged");
});

test("early failure and cancellation leave no background footer status", async (t) => {
  const { session, tool, statuses } = await loadSession(t);
  await assert.rejects(
    tool.execute("bad-timeout", {
      command: "true",
      background: true,
      timeout: -1,
    }),
    /timeout/iu,
  );
  assert.equal(statuses.has("background"), false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tool.execute(
      "cancelled",
      {
        command: "true",
        background: true,
      },
      controller.signal,
    ),
    /abort/iu,
  );
  assert.equal(statuses.has("background"), false);
  assert.equal(notificationMessages(session).length, 0);
});

test("foreground commands behave like the built-in bash tool and leave no logs", async (t) => {
  const { directory, tool, statuses } = await loadSession(t);
  const result = await tool.execute("fg-1", { command: nodeScript('console.log("hello")') });
  assert.equal(textOf(result), "hello\n");
  const failure = await tool.execute("fg-2", { command: nodeScript("process.exit(2)") });
  assert.match(textOf(failure), /Command exited with code 2/u);
  assert.equal(failure.isError, true);
  const truncation = await tool.execute("fg-3", {
    command: nodeScript('for(let i=0;i<3000;i++) console.log("line",i)'),
  });
  assert.match(textOf(truncation), /Full output: /u);
  // Foreground commands keep no job logs on disk; their output is the result.
  const { readdir } = await import("node:fs/promises");
  const jobFiles = (
    await readdir(join(directory, "bash-jobs"), { recursive: true }).catch(() => [] as string[])
  ).filter((entry) => entry.endsWith(".log"));
  assert.deepEqual(jobFiles, []);
  assert.equal(statuses.has("background"), false);
});

test("background: true returns immediately, notifies on completion, and logs output", async (t) => {
  const { session, directory, tool, notices, statuses } = await loadSession(t);
  const start = Date.now();
  const started = await tool.execute("bg-1", {
    command: nodeScript('setTimeout(() => console.log("job done"), 400)'),
    background: true,
  });
  assert.ok(Date.now() - start < 400, "the tool call must return before the command finishes");
  assert.equal(statuses.get("background"), "bg: 1 running · /background");
  const startedText = textOf(started);
  const jobId = /Started background job (bg_[0-9a-f]{8})\./u.exec(startedText)?.[1];
  assert.ok(jobId, startedText);
  assert.match(tool.description, /Do not poll background jobs/u);
  assert.match(tool.description, /Do not start another copy/u);
  assert.match(tool.description, /end your turn/u);
  assert.match(tool.description, /8 MiB/u);
  const logPath = new RegExp(`Log: (\\S+${jobId}\\.log)`, "u").exec(startedText)?.[1];
  assert.ok(logPath);
  assert.ok(logPath.startsWith(join(directory, "bash-jobs")), logPath);
  assert.equal(startedText, `Started background job ${jobId}.\nLog: ${logPath}`);

  const notification = await waitFor(() =>
    notificationMessages(session).find((message) => message.customType === "bash-job:notification"),
  );
  assert.match(notification.content, /✓/u);
  assert.match(notification.content, new RegExp(`${jobId} exited with code 0`, "u"));
  assert.match(notification.content, /job done/u);
  assert.equal(statuses.has("background"), false);

  const log = await readFile(logPath, "utf8");
  assert.match(log, /job done/u);
  assert.match(log, /\[pi-background\] job bg_[0-9a-f]{8} completed \(exit 0\)/u);
  await session.prompt("/background");
  assert.equal(notices.at(-1), "No background jobs running.");
});

test("background start reports unavailable logs without repeating tool instructions", async (t) => {
  const { session, directory, tool } = await loadSession(t);
  await writeFile(join(directory, "bash-jobs"), "not a directory");
  const result = await tool.execute("no-log", {
    command: nodeScript('setTimeout(() => console.log("tail-only output"), 200)'),
    background: true,
  });
  assert.match(
    textOf(result),
    /^Started background job bg_[0-9a-f]{8}\.\nLog unavailable; completion notification will include the output tail\.$/u,
  );
  const notification = await waitFor(() => notificationMessages(session)[0]);
  assert.match(notification.content, /tail-only output/u);
  assert.doesNotMatch(notification.content, /Log:|MiB/u);
});

test("a slow foreground command moves to the background at the threshold", async (t) => {
  const { session, directory, tool, statuses } = await loadSession(t);
  await writeFile(join(directory, "background.json"), JSON.stringify({ thresholdSeconds: 0.2 }));
  const start = Date.now();
  const moved = await tool.execute("bg-2", {
    command: nodeScript('setTimeout(() => console.log("late output"), 800)'),
  });
  assert.ok(Date.now() - start < 800, "the tool call must return at the threshold");
  assert.equal(statuses.get("background"), "bg: 1 running · /background");
  const movedText = textOf(moved);
  assert.match(
    movedText,
    /^Command exceeded the 0\.2s foreground threshold\.\nMoved to background job bg_[0-9a-f]{8}\.\nLog: /u,
  );
  const jobId = /background job (bg_[0-9a-f]{8})/u.exec(movedText)?.[1];
  assert.ok(jobId);

  const notification = await waitFor(() =>
    notificationMessages(session).find(
      (message) =>
        message.customType === "bash-job:notification" && message.content.includes(jobId),
    ),
  );
  assert.match(notification.content, /exited with code 0/u);
  assert.match(notification.content, /late output/u);
  assert.equal(statuses.has("background"), false);
});

for (const ending of ["completed", "failed", "shutdown"] as const) {
  test(`auto-background log initialization precedes ${ending} finalization`, {
    timeout: 10_000,
  }, async (t) => {
    const { session, directory, tool, statuses } = await loadSession(t);
    await writeFile(
      join(directory, "background.json"),
      JSON.stringify({ thresholdSeconds: 0.001 }),
    );
    const gate = new EventEmitter();
    const entered = once(gate, "entered");
    const released = once(gate, "release");
    const mkdir = fsPromises.mkdir;
    const mkdirMock = t.mock.method(
      fsPromises,
      "mkdir",
      async (...args: Parameters<typeof mkdir>) => {
        if (String(args[0]).startsWith(join(directory, "bash-jobs"))) {
          gate.emit("entered");
          await released;
        }
        return mkdir(...args);
      },
    );
    const spawnMock = t.mock.method(childProcess, "spawn");
    const streamMock = t.mock.method(fs, "createWriteStream");
    syncBuiltinESMExports();
    t.after(() => {
      gate.emit("release");
      mkdirMock.mock.restore();
      spawnMock.mock.restore();
      streamMock.mock.restore();
      syncBuiltinESMExports();
    });
    // A filesystem gate keeps the real child alive until mkdir is blocked.
    const command =
      ending === "shutdown"
        ? nodeScript("setTimeout(() => {}, 30000)")
        : nodeScript(
            `const fs = require('node:fs'); const finish = () => {
          if (!fs.existsSync('finish-command')) return;
          watcher.close();
          ${ending === "completed" ? "process.stdout.write(Buffer.alloc(300 * 1024, 120));" : ""}
          console.log('finished during mkdir');
          process.exitCode = ${ending === "failed" ? 3 : 0};
        }; const watcher = fs.watch('.', finish); finish();`.replaceAll("\n", " "),
          );
    const execution = tool.execute(`race-${ending}`, { command });
    await entered;
    if (ending === "shutdown") {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } else {
      await writeFile(join(directory, "finish-command"), "finish");
      const child = await waitFor(() => spawnMock.mock.calls[0]?.result);
      if (child.exitCode === null && child.signalCode === null) await once(child, "close");
      // Let promise continuations run, not a timing guess about process exit.
      await setImmediate();
    }
    assert.equal(
      notificationMessages(session).length,
      0,
      "no notification before log initialization",
    );
    gate.emit("release");
    const result = await execution;
    if (ending === "shutdown") {
      await setImmediate();
      assert.equal(streamMock.mock.callCount(), 0, "shutdown must not open a late log stream");
      assert.equal(statuses.has("background"), false);
      assert.equal(notificationMessages(session).length, 0);
      return;
    }
    assert.match(textOf(result), /Output so far:/u);
    assert.match(textOf(result), /finished during mkdir/u);
    const logPath = /Log: (\S+)/u.exec(textOf(result))?.[1];
    assert.ok(logPath);
    const notification = await waitFor(() => notificationMessages(session)[0]);
    assert.ok(notification.content.includes(logPath));
    assert.match(
      notification.content,
      ending === "failed" ? /exited with code 3/u : /exited with code 0/u,
    );
    const outputLog = await readFile(logPath, "utf8");
    assert.match(outputLog, /\[pi-background\] job .* (completed|failed) \(exit [03]\)/u);
    if (ending === "completed") {
      assert.ok(outputLog.startsWith("[pi-background] earlier output omitted\n"));
      assert.match(outputLog, /finished during mkdir/u);
    } else {
      assert.doesNotMatch(outputLog, /earlier output omitted/u);
    }
    const log = streamMock.mock.calls[0]?.result;
    assert.ok(log);
    assert.equal(log.writableFinished, true);
    assert.equal(notificationMessages(session).length, 1);
    assert.equal(statuses.has("background"), false);
  });
}

test("capped logs do not stop output draining or completion tails", async (t) => {
  const { session, tool } = await loadSession(t);
  const result = await tool.execute("chatty", {
    command: nodeScript(
      'const chunk = Buffer.alloc(65536, 120); for (let i = 0; i < 160; i++) process.stdout.write(chunk); console.log("\\nlatest tail after cap");',
    ),
    background: true,
  });
  const logPath = /Log: (\S+)/u.exec(textOf(result))?.[1];
  assert.ok(logPath);
  const notification = await waitFor(() => notificationMessages(session)[0]);
  assert.match(notification.content, /exited with code 0/u);
  assert.match(notification.content, /latest tail after cap/u);
  assert.match(notification.content, /Log output limit reached \(8 MiB\)/u);
  const log = await readFile(logPath, "utf8");
  assert.ok(Buffer.byteLength(log) < 8 * 1024 * 1024 + 512);
  assert.match(log, /output limit reached/u);
  assert.doesNotMatch(log, /earlier output omitted/u);
  assert.doesNotMatch(log, /latest tail after cap/u);
  assert.match(log, /completed \(exit 0\)/u);
});

test("the shellCommandPrefix setting applies to commands", async (t) => {
  const { tool } = await loadSession(t, "tui", {
    shellCommandPrefix: "export PI_BG_PREFIX=from-prefix",
  });
  const result = await tool.execute("p-1", {
    command: nodeScript("process.stdout.write(process.env.PI_BG_PREFIX ?? 'missing')"),
  });
  assert.match(textOf(result), /from-prefix/u);
});

test("thresholdSeconds 0 disables auto-backgrounding", async (t) => {
  const { directory, tool } = await loadSession(t);
  await writeFile(join(directory, "background.json"), JSON.stringify({ thresholdSeconds: 0 }));
  const start = Date.now();
  const result = await tool.execute("no-bg", {
    command: nodeScript('setTimeout(() => console.log("blocked to completion"), 400)'),
  });
  assert.ok(Date.now() - start >= 400, "the command must block without auto-backgrounding");
  assert.match(textOf(result), /blocked to completion/u);
});

test("an explicit timeout keeps the built-in kill semantics", async (t) => {
  const { tool } = await loadSession(t);
  await assert.rejects(
    tool.execute("fg-4", {
      command: nodeScript("setTimeout(() => {}, 30000)"),
      timeout: 0.2,
    }),
    /Command timed out after 0\.2 seconds/u,
  );
});

test("the maxJobs limit rejects further background jobs", async (t) => {
  const { directory, tool } = await loadSession(t);
  await writeFile(
    join(directory, "background.json"),
    JSON.stringify({ thresholdSeconds: 120, maxJobs: 1 }),
  );
  await tool.execute("bg-3", {
    command: nodeScript("setTimeout(() => {}, 5000)"),
    background: true,
  });
  await assert.rejects(
    tool.execute("bg-4", {
      command: nodeScript("setTimeout(() => {}, 5000)"),
      background: true,
    }),
    /max 1/u,
  );

  // Parallel explicit starts in one turn are counted from the first call on.
  const [first, second] = await Promise.allSettled([
    tool.execute("bg-5", {
      command: nodeScript("setTimeout(() => {}, 5000)"),
      background: true,
    }),
    tool.execute("bg-6", {
      command: nodeScript("setTimeout(() => {}, 5000)"),
      background: true,
    }),
  ]);
  assert.equal(first.status, "rejected");
  assert.match(String((first as PromiseRejectedResult).reason), /max 1/u);
  assert.equal(second.status, "rejected");
  assert.match(String((second as PromiseRejectedResult).reason), /max 1/u);
});

test("a backgrounded job survives aborting the turn signal (Esc) that spawned it", async (t) => {
  const { session, tool } = await loadSession(t);
  const turnSignal = new AbortController();
  const started = await tool.execute(
    "bg-esc",
    { command: nodeScript('setTimeout(() => console.log("survived"), 300)'), background: true },
    turnSignal.signal,
  );
  const jobId = /Started background job (bg_[0-9a-f]{8})\./u.exec(textOf(started))?.[1];
  assert.ok(jobId);
  // Esc after backgrounding must not reach the job.
  turnSignal.abort();
  const notification = await waitFor(() =>
    notificationMessages(session).find(
      (message) =>
        message.customType === "bash-job:notification" && message.content.includes(jobId),
    ),
  );
  assert.match(notification.content, /✓/u);
  assert.match(notification.content, /survived/u);
});

for (const mode of ["print", "json"] as const) {
  test(`${mode} mode documents and rejects background, and never auto-backgrounds`, async (t) => {
    const { directory, session, tool } = await loadSession(t, mode);
    assert.match(tool.description, /available only in tui\/rpc mode/u);
    assert.match(tool.description, /0 disables it/u);
    const metadata = session.getAllTools().find((candidate) => candidate.name === "bash");
    assert.ok(metadata);
    assert.ok(
      metadata.promptGuidelines?.some((line) =>
        line.includes("In print/json mode, run the command in the foreground"),
      ),
    );
    await assert.rejects(
      tool.execute("pr-1", { command: nodeScript("process.exit(0)"), background: true }),
      new RegExp(`unavailable in ${mode} mode`, "u"),
    );
    await writeFile(join(directory, "background.json"), JSON.stringify({ thresholdSeconds: 0.1 }));
    const start = Date.now();
    const result = await tool.execute("pr-2", {
      command: nodeScript('setTimeout(() => console.log("ran to completion"), 400)'),
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 400, `${mode} mode must block for the command (${elapsed}ms)`);
    assert.match(textOf(result), /ran to completion/u);
  });
}

test("invalid background configuration fails before a command runs", async (t) => {
  const { directory, tool } = await loadSession(t);
  await writeFile(join(directory, "background.json"), "{");
  await assert.rejects(
    tool.execute("invalid-config", {
      command: nodeScript("require('node:fs').writeFileSync('should-not-exist', 'ran')"),
    }),
    /Invalid background configuration/u,
  );
  await assert.rejects(readFile(join(directory, "should-not-exist")), { code: "ENOENT" });
});
