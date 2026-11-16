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
  type DeliveryReceipt,
  isResult,
  type Launch,
  type LiveAgent,
  MAX_REQUESTS,
  type MessageEnvelope,
  record,
  type Result,
  STARTUP_MS,
  STOP_GRACE_MS,
  type Status,
} from "./protocol.ts";

export interface Execution {
  ready: Promise<void>;
  done: Promise<Result>;
  run(): void;
  deliver(envelope: MessageEnvelope): Promise<DeliveryAck>;
  cancel(): Promise<Result>;
}

export interface RunnerHandlers {
  onList?: () => LiveAgent[];
  onSend?: (to: string, message: string) => Promise<DeliveryReceipt>;
}

export interface RunnerOptions {
  command?: string;
  args?: string[];
  startupMs?: number;
  deadlineMs?: number;
  graceMs?: number;
  handlers?: RunnerHandlers;
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
    "--thinking",
    launch.thinking,
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
  let reason: { status: Status; report: string } | undefined;
  let stderr = "";
  let settled = false;
  let started = false;
  let force: NodeJS.Timeout | undefined;
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
      if (!record(error) || error.code !== "ESRCH") throw error;
    }
  };
  const stop = (status: Status, report: string) => {
    if (settled || reason) return;
    reason = { status, report };
    failPendingDeliveries();
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
    options.deadlineMs ?? launch.deadlineMs ?? DEADLINE_MS,
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
          id: launch.id ?? "child",
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
      case "list":
        if (typeof message.requestId === "string") {
          const agents = options.handlers?.onList?.() ?? [];
          send({ type: "list_result", requestId: message.requestId, agents });
        }
        break;
      case "send":
        if (
          typeof message.requestId === "string" &&
          typeof message.to === "string" &&
          typeof message.message === "string"
        ) {
          const requestId = message.requestId;
          const onSend = options.handlers?.onSend;
          if (!onSend) {
            send({
              type: "send_result",
              requestId,
              error: "Agent messaging is unavailable.",
            });
            break;
          }
          void onSend(message.to, message.message).then(
            (receipt) => send({ type: "send_result", requestId, receipt }),
            (error: unknown) =>
              send({
                type: "send_result",
                requestId,
                error: error instanceof Error ? error.message : String(error),
              }),
          );
        }
        break;
      case "result":
        failPendingDeliveries();
        if (isResult(message.result)) result = message.result;
        else stop("failed", "Invalid child result.");
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
  child.on("close", (code) => {
    settled = true;
    failPendingDeliveries();
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
    deliver(envelope: MessageEnvelope): Promise<DeliveryAck> {
      if (settled || reason || result || !child.connected) {
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
    cancel() {
      stop("cancelled", "Cancelled; existing filesystem changes were not reverted.");
      return done;
    },
  };
}
