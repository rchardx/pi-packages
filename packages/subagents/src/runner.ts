import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import {
  bounded,
  CHILD_ENV,
  DEADLINE_MS,
  type DeliveryAck,
  formatIncompleteReport,
  isProgress,
  isResult,
  type Launch,
  MAX_REQUESTS,
  type MessageEnvelope,
  type Progress,
  record,
  type Result,
  STARTUP_MS,
  STOP_GRACE_MS,
  type Status,
} from "./protocol.ts";

const GROUP_POLL_MS = 20;
const POST_KILL_POLLS = 10;

export type CancelClaim =
  | { accepted: true; done: Promise<Result> }
  | { accepted: false; reason: "stopping" | "finished" };

export interface Execution {
  ready: Promise<void>;
  done: Promise<Result>;
  run(): void;
  deliver(envelope: MessageEnvelope): Promise<DeliveryAck>;
  /** Claims cancellation when the child is still running; reports why otherwise. */
  tryCancel(): CancelClaim;
  cancel(): Promise<Result>;
}

export interface RunnerOptions {
  command?: string;
  args?: string[];
  startupMs?: number;
  deadlineMs?: number;
  graceMs?: number;
  /** Hands a child's message to the root session; throws when it cannot be accepted. */
  onSend?: (message: string) => void;
}

export function startChild(launch: Launch, options: RunnerOptions = {}): Execution {
  const allowedTools = [...launch.requiredTools, ...launch.mcpTools];
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
    ...(launch.thinking !== undefined ? ["--thinking", launch.thinking] : []),
    ...(allowedTools.length ? ["--tools", allowedTools.join(",")] : ["--no-tools"]),
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
  let progress: Progress | undefined;
  let reason: { status: Status; report: string } | undefined;
  let stderr = "";
  let exited = false;
  let settled = false;
  let started = false;
  let force: NodeJS.Timeout | undefined;
  let forceKilled = false;
  let groupTerminating = false;
  const pendingDeliveries = new Map<string, (ack: DeliveryAck) => void>();

  const failPendingDeliveries = () => {
    for (const resolveAck of pendingDeliveries.values()) {
      resolveAck({ accepted: false, reason: "finished" });
    }
    pendingDeliveries.clear();
  };

  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (!record(error) || (error.code !== "ESRCH" && error.code !== "EPERM")) throw error;
    }
  };
  const isGroupAlive = (): boolean => {
    if (!child.pid || process.platform === "win32") return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (record(error) && (error.code === "ESRCH" || error.code === "EPERM")) return false;
      throw error;
    }
  };
  const terminateGroup = () => {
    if (groupTerminating) return;
    groupTerminating = true;
    kill("SIGTERM");
    force = setTimeout(() => {
      force = undefined;
      forceKilled = true;
      kill("SIGKILL");
    }, options.graceMs ?? STOP_GRACE_MS);
  };
  const stop = (status: Status, report: string): boolean => {
    if (settled || exited || reason) return false;
    reason = { status, report };
    failPendingDeliveries();
    readyReject(new Error(report));
    terminateGroup();
    return true;
  };
  const startup = setTimeout(
    () => stop("timed_out", "Child startup timed out."),
    options.startupMs ?? STARTUP_MS,
  );
  const deadline = setTimeout(
    () => stop("timed_out", "Child execution deadline exceeded."),
    options.deadlineMs ?? launch.deadlineMs ?? DEADLINE_MS,
  );
  const send = (message: object) => {
    if (!child.connected) return;
    child.send(message, (error) => {
      if (error) stop("failed", "Child IPC delivery failed.");
    });
  };
  child.on("message", (message: unknown) => {
    if (!record(message) || settled) return;
    if (message.type === "progress") {
      if (isProgress(message.progress)) progress = message.progress;
      return;
    }
    if (message.type === "result") {
      failPendingDeliveries();
      if (isResult(message.result)) result = message.result;
      else if (!stop("failed", "Invalid child result.")) {
        reason ??= { status: "failed", report: "Invalid child result." };
      }
      return;
    }
    if (reason || exited) return;
    switch (message.type) {
      case "hello":
        send({
          type: "configure",
          id: launch.id ?? "child",
          role: launch.role,
          instructions: launch.instructions,
          requiredTools: launch.requiredTools,
          activeTools: launch.activeTools,
          provider: launch.provider,
          model: launch.model,
          modelConfig: launch.modelConfig,
          maxRequests: launch.maxRequests ?? MAX_REQUESTS,
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
      case "delivery_ack":
        if (typeof message.deliveryId === "string") {
          const resolveAck = pendingDeliveries.get(message.deliveryId);
          if (resolveAck) {
            pendingDeliveries.delete(message.deliveryId);
            if (message.accepted === true) {
              resolveAck({ accepted: true });
            } else {
              resolveAck({
                accepted: false,
                reason: message.reason === "queue_full" ? "queue_full" : "finished",
              });
            }
          }
        }
        break;
      case "send":
        if (typeof message.requestId === "string" && typeof message.message === "string") {
          let error: string | undefined;
          try {
            if (!options.onSend) throw new Error("Agent messaging is unavailable.");
            options.onSend(message.message);
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
          send({
            type: "send_result",
            requestId: message.requestId,
            ...(error !== undefined ? { error } : {}),
          });
        }
        break;
    }
  });
  child.on("disconnect", failPendingDeliveries);
  // Drain JSON progress without storing transcripts. Reports use the IPC channel.
  child.stdout?.resume();
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = bounded(stderr + chunk.toString("utf8"), 4096);
  });
  child.stdin?.on("error", () => stop("failed", "Child input pipe closed."));
  child.on("error", (error) => {
    reason ??= { status: "failed", report: bounded(error.message) };
  });
  child.on("exit", () => {
    exited = true;
    failPendingDeliveries();
    clearTimeout(startup);
    clearTimeout(deadline);
    if (isGroupAlive()) terminateGroup();
  });
  child.on("close", (code) => {
    settled = true;
    failPendingDeliveries();
    clearTimeout(startup);
    clearTimeout(deadline);
    const detail = stderr.trim();
    readyReject(
      new Error(
        reason?.report ??
          bounded(
            detail
              ? `Child exited before startup (exit ${code}).\n${detail}`
              : `Child exited before startup (exit ${code}).`,
          ),
      ),
    );
    const requests = result?.requests ?? progress?.requests ?? 0;
    const tokens = result?.tokens ?? progress?.tokens ?? 0;
    let finalResult: Result;
    if (reason) {
      // A result sent during the grace window supplies the final counts only: its report
      // carries the child's own headline, which would duplicate this one.
      finalResult = {
        status: reason.status,
        report: formatIncompleteReport(reason.report, progress?.partial),
        requests,
        tokens,
      };
    } else if (code === 0 && result) {
      finalResult = result;
    } else {
      const crashHeadline = detail
        ? `Child exited without successful teardown (exit ${code}).\n${detail}`
        : `Child exited without successful teardown (exit ${code}).`;
      finalResult = {
        status: "failed",
        report: formatIncompleteReport(crashHeadline, progress?.partial),
        requests,
        tokens,
      };
    }
    if (!isGroupAlive()) {
      clearTimeout(force);
      doneResolve(finalResult);
      return;
    }
    let postKillPolls = 0;
    const pollGroup = () => {
      if (!isGroupAlive()) {
        clearTimeout(force);
        doneResolve(finalResult);
        return;
      }
      if (forceKilled) {
        kill("SIGKILL");
        if (++postKillPolls >= POST_KILL_POLLS) {
          doneResolve(finalResult);
          return;
        }
      }
      setTimeout(pollGroup, GROUP_POLL_MS);
    };
    setTimeout(pollGroup, GROUP_POLL_MS);
  });
  const tryCancel = (): CancelClaim => {
    if (stop("cancelled", "Cancelled; existing filesystem changes were not reverted.")) {
      return { accepted: true, done };
    }
    return {
      accepted: false,
      reason: !settled && reason !== undefined ? "stopping" : "finished",
    };
  };
  child.stdin?.end(`Delegated task:\n\n${launch.task}`);
  return {
    ready,
    done,
    run() {
      if (!started && !settled && !exited && !reason) {
        started = true;
        send({ type: "run" });
      }
    },
    deliver(envelope: MessageEnvelope): Promise<DeliveryAck> {
      if (settled || exited || reason || result || !child.connected) {
        return Promise.resolve({ accepted: false, reason: "finished" });
      }
      const deliveryId = randomUUID();
      return new Promise<DeliveryAck>((resolve) => {
        pendingDeliveries.set(deliveryId, resolve);
        child.send({ type: "deliver", deliveryId, envelope }, (error) => {
          if (error) {
            const pending = pendingDeliveries.get(deliveryId);
            if (pending) {
              pendingDeliveries.delete(deliveryId);
              pending({ accepted: false, reason: "finished" });
            }
          }
        });
      });
    },
    tryCancel,
    cancel() {
      tryCancel();
      return done;
    },
  };
}
