import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import {
  bounded,
  CHILD_ENV,
  DEADLINE_MS,
  isResult,
  record,
  STARTUP_MS,
  STOP_GRACE_MS,
  type Launch,
  type Result,
  type Status,
} from "./protocol.ts";

export interface Execution {
  ready: Promise<void>;
  done: Promise<Result>;
  run(): void;
  cancel(): Promise<Result>;
}
export interface RunnerOptions {
  command?: string;
  args?: string[];
  startupMs?: number;
  deadlineMs?: number;
  graceMs?: number;
}

export function startChild(launch: Launch, options: RunnerOptions = {}): Execution {
  const args = options.args ?? [
    join(getPackageDir(), "dist", "bundle", "cli.js"),
    "--mode",
    "json",
    "--no-session",
    "--no-prompt-templates",
    "--no-themes",
    launch.trusted ? "--approve" : "--no-approve",
    "--provider",
    launch.provider,
    "--model",
    launch.model,
    "--thinking",
    launch.thinking,
    ...(launch.requiredTools.length ? ["--tools", launch.requiredTools.join(",")] : ["--no-tools"]),
    ...(launch.cliFlags ?? []),
    ...launch.extensions.flatMap((path) => ["-e", path]),
    "-e",
    fileURLToPath(new URL("./child.ts", import.meta.url)),
  ];
  const child = spawn(options.command ?? process.execPath, args, {
    cwd: launch.cwd,
    env: { ...process.env, [CHILD_ENV]: "1" },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    detached: process.platform !== "win32",
  });
  let readyResolve: () => void = () => {};
  let readyReject: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Cancellation may settle startup before its caller has installed a handler.
  void ready.catch(() => {});
  let doneResolve: (result: Result) => void = () => {};
  const done = new Promise<Result>((resolve) => {
    doneResolve = resolve;
  });
  let result: Result | undefined;
  let reason: { status: Status; report: string } | undefined;
  let stderr = "";
  let settled = false;
  let started = false;
  let force: NodeJS.Timeout | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (!record(error) || error.code !== "ESRCH") throw error;
    }
  };
  const stop = (status: Status, report: string) => {
    if (settled || reason) return;
    reason = { status, report };
    readyReject(new Error(report));
    kill("SIGTERM");
    force = setTimeout(() => kill("SIGKILL"), options.graceMs ?? STOP_GRACE_MS);
  };
  const startup = setTimeout(
    () => stop("timed_out", "Child startup timed out."),
    options.startupMs ?? STARTUP_MS,
  );
  const deadline = setTimeout(
    () => stop("timed_out", "Child execution deadline exceeded."),
    options.deadlineMs ?? DEADLINE_MS,
  );
  const send = (message: object) => {
    if (!child.connected) return;
    child.send(message, (error) => {
      if (error) stop("failed", "Child IPC delivery failed.");
    });
  };
  child.on("message", (message: unknown) => {
    if (!record(message) || settled || reason) return;
    switch (message.type) {
      case "hello":
        send({
          type: "configure",
          requiredTools: launch.requiredTools,
          activeTools: launch.activeTools,
          provider: launch.provider,
          model: launch.model,
          modelConfig: launch.modelConfig,
        });
        break;
      case "ready":
        clearTimeout(startup);
        readyResolve();
        break;
      case "startup_error":
        stop(
          "failed",
          bounded(typeof message.error === "string" ? message.error : "Child startup failed."),
        );
        break;
      case "result":
        if (isResult(message.result)) result = message.result;
        else stop("failed", "Invalid child result.");
        break;
    }
  });
  // Drain JSON progress without storing transcripts. Reports use the IPC channel.
  child.stdout?.resume();
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = bounded(stderr + chunk.toString("utf8"), 4096);
  });
  child.stdin?.on("error", () => stop("failed", "Child input pipe closed."));
  child.on("error", (error) => {
    reason ??= { status: "failed", report: bounded(error.message) };
  });
  child.on("close", (code) => {
    settled = true;
    clearTimeout(startup);
    clearTimeout(deadline);
    clearTimeout(force);
    readyReject(new Error(reason?.report ?? `Child exited before startup (exit ${code}).`));
    if (reason)
      doneResolve({ ...reason, requests: result?.requests ?? 0, tokens: result?.tokens ?? 0 });
    else if (code === 0 && result) doneResolve(result);
    else
      doneResolve({
        status: "failed",
        report: bounded(`Child exited without successful teardown (exit ${code}).\n${stderr}`),
        requests: result?.requests ?? 0,
        tokens: result?.tokens ?? 0,
      });
  });
  child.stdin?.end(`Delegated task:\n\n${launch.task}`);
  return {
    ready,
    done,
    run() {
      if (!started && !settled && !reason) {
        started = true;
        send({ type: "run" });
      }
    },
    cancel() {
      stop("cancelled", "Cancelled; existing filesystem changes were not reverted.");
      return done;
    },
  };
}
