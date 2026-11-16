import { randomUUID } from "node:crypto";
import { oneLine } from "./notify.ts";
import {
  BROADCAST_TARGET,
  type DeliveryAck,
  type DeliveryReceipt,
  type Launch,
  type LiveAgent,
  MAIN_AGENT_ID,
  MAX_CONCURRENT,
  MAX_TERMINAL_RECORDS,
  type MessageEnvelope,
  type Result,
  type SkippedRecipient,
  validateSendInput,
} from "./protocol.ts";
import { type Execution, type RunnerOptions, startChild } from "./runner.ts";

export interface Task {
  id: string;
  task: string;
  startedAt: number;
  handedOff: boolean;
  cancelRequested: boolean;
  execution?: Execution;
  result?: Result;
}

export type StartChild = (launch: Launch, options?: RunnerOptions) => Execution;

export class Tasks {
  readonly records = new Map<string, Task>();
  private closed = false;

  private readonly notify: (task: Task, result: Result) => void;
  private readonly start: StartChild;
  private readonly onChange: () => void;
  private readonly deliverToMain: (envelope: MessageEnvelope) => DeliveryAck;

  constructor(
    notify: (task: Task, result: Result) => void,
    start: StartChild = startChild,
    onChange: () => void = () => {},
    deliverToMain: (envelope: MessageEnvelope) => DeliveryAck = () => ({
      accepted: false,
      reason: "finished",
    }),
  ) {
    this.notify = notify;
    this.start = start;
    this.onChange = onChange;
    this.deliverToMain = deliverToMain;
  }

  runningTasks(): Task[] {
    if (this.closed) return [];
    return [...this.records.values()].filter(
      (task) => task.handedOff && !task.result && !task.cancelRequested,
    );
  }

  runningCount(): number {
    return this.runningTasks().length;
  }

  list(viewerId: string, now = Date.now()): LiveAgent[] {
    if (this.closed) return [];
    return [
      { id: MAIN_AGENT_ID, self: viewerId === MAIN_AGENT_ID },
      ...this.runningTasks().map((task) => ({
        id: task.id,
        self: viewerId === task.id,
        elapsedMs: Math.max(0, now - task.startedAt),
        task: oneLine(task.task, 120),
      })),
    ];
  }

  async send(from: string, rawTo: string, rawMessage: string): Promise<DeliveryReceipt> {
    if (this.closed) throw new Error("The owning session has ended.");
    const { to, message } = validateSendInput(rawTo, rawMessage);
    if (to === from) throw new Error("Cannot send a message to yourself.");

    const id = randomUUID();
    const sentAt = Date.now();

    if (to !== BROADCAST_TARGET) {
      if (to === MAIN_AGENT_ID) {
        const ack = this.deliverToMain({
          id,
          from,
          to: MAIN_AGENT_ID,
          broadcast: false,
          message,
          sentAt,
        });
        if (!ack.accepted) {
          throw new Error(
            ack.reason === "queue_full"
              ? "Main session message queue is full."
              : "The owning session has ended.",
          );
        }
        return { id, from, to, broadcast: false, delivered: [MAIN_AGENT_ID], skipped: [] };
      }

      const target = this.records.get(to);
      if (!target || (!target.handedOff && !target.result)) {
        throw new Error(
          "Unknown subagent ID for this session (old terminal records may have expired).",
        );
      }
      if (target.result) {
        throw new Error(
          `Subagent ${to} has already finished (${target.result.status}) and cannot receive messages.`,
        );
      }
      if (!target.execution || target.cancelRequested) {
        throw new Error(`Subagent ${to} is no longer running and cannot receive messages.`);
      }
      const ack = await target.execution.deliver({
        id,
        from,
        to,
        broadcast: false,
        message,
        sentAt,
      });
      if (!ack.accepted) {
        if (ack.reason === "queue_full") {
          throw new Error(`Subagent ${to} message queue is full.`);
        }
        const status = this.records.get(to)?.result?.status;
        throw new Error(
          status
            ? `Subagent ${to} has already finished (${status}) and cannot receive messages.`
            : `Subagent ${to} has already finished and cannot receive messages.`,
        );
      }
      return { id, from, to, broadcast: false, delivered: [to], skipped: [] };
    }

    const recipients: Array<{ kind: "main" } | { kind: "child"; task: Task }> = [];
    if (from !== MAIN_AGENT_ID) recipients.push({ kind: "main" });
    for (const task of this.runningTasks()) {
      if (task.id !== from) recipients.push({ kind: "child", task });
    }
    if (recipients.length === 0) {
      return { id, from, to: BROADCAST_TARGET, broadcast: true, delivered: [], skipped: [] };
    }

    const outcomes = await Promise.all(
      recipients.map(
        async (recipient): Promise<{ id: string; ack: DeliveryAck; task: Task | undefined }> => {
          const targetId = recipient.kind === "main" ? MAIN_AGENT_ID : recipient.task.id;
          const envelope: MessageEnvelope = {
            id,
            from,
            to: targetId,
            broadcast: true,
            message,
            sentAt,
          };
          if (recipient.kind === "main") {
            return { id: targetId, ack: this.deliverToMain(envelope), task: undefined };
          }
          if (
            !recipient.task.execution ||
            recipient.task.result ||
            recipient.task.cancelRequested
          ) {
            return {
              id: targetId,
              ack: { accepted: false, reason: "finished" },
              task: recipient.task,
            };
          }
          const ack = await recipient.task.execution.deliver(envelope);
          return { id: targetId, ack, task: recipient.task };
        },
      ),
    );

    const delivered: string[] = [];
    const skipped: SkippedRecipient[] = [];
    for (const outcome of outcomes) {
      if (outcome.ack.accepted) {
        delivered.push(outcome.id);
      } else {
        skipped.push({
          id: outcome.id,
          reason:
            outcome.ack.reason === "queue_full"
              ? "queue full"
              : (outcome.task?.result?.status ?? "finished"),
        });
      }
    }
    return { id, from, to: BROADCAST_TARGET, broadcast: true, delivered, skipped };
  }

  async launch(
    launch: Launch,
    signal?: AbortSignal,
    maxConcurrent = MAX_CONCURRENT,
  ): Promise<string> {
    if (this.closed) throw new Error("The owning session has ended.");
    if (signal?.aborted) throw new Error("Subagent startup cancelled.");
    const active = [...this.records.values()].filter((task) => !task.result).length;
    if (active >= maxConcurrent)
      throw new Error(
        `At most ${maxConcurrent} subagents may run in this session. Wait for a completion notification.`,
      );
    const task: Task = {
      id: randomUUID(),
      task: launch.task,
      startedAt: Date.now(),
      handedOff: false,
      cancelRequested: false,
    };
    // Reserve before startup so concurrent calls cannot overbook the session.
    this.records.set(task.id, task);
    let execution: Execution;
    try {
      execution = this.start(
        { ...launch, id: task.id },
        {
          handlers: {
            onList: () => this.list(task.id),
            onSend: (to, message) => this.send(task.id, to, message),
          },
        },
      );
    } catch (error) {
      this.records.delete(task.id);
      throw error;
    }
    task.execution = execution;
    const abort = () => {
      const wasRunning = task.handedOff && !task.result && !task.cancelRequested;
      task.cancelRequested = true;
      if (wasRunning && !this.closed) this.onChange();
      void execution.cancel();
    };
    signal?.addEventListener("abort", abort, { once: true });
    void execution.done.then((result) => {
      const wasRunning = task.handedOff && !task.result && !task.cancelRequested;
      task.result = result;
      delete task.execution;
      if (wasRunning && !this.closed) this.onChange();
      if (task.handedOff && !this.closed && !task.cancelRequested) this.notify(task, result);
      this.prune();
    });
    try {
      await execution.ready;
      if (this.closed || signal?.aborted || task.result)
        throw new Error("Subagent ended during startup.");
      signal?.removeEventListener("abort", abort);
      task.handedOff = true;
      this.onChange();
      // Resume the child after the launch tool has returned its acknowledgement.
      setImmediate(() => execution.run());
      return task.id;
    } catch (error) {
      await execution.cancel();
      this.records.delete(task.id);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async cancel(id: string): Promise<Result> {
    const task = this.records.get(id);
    if (!task)
      throw new Error(
        "Unknown subagent ID for this session (old terminal records may have expired).",
      );
    if (task.result) return task.result;
    if (!task.execution) throw new Error("Subagent has no running execution.");
    const wasRunning = task.handedOff && !task.cancelRequested;
    task.cancelRequested = true;
    if (wasRunning && !this.closed) this.onChange();
    return task.execution.cancel();
  }

  async shutdown(): Promise<void> {
    const hadRunning = this.runningCount() > 0;
    this.closed = true;
    if (hadRunning) this.onChange();
    await Promise.allSettled([...this.records.values()].map((task) => task.execution?.cancel()));
    this.records.clear();
  }

  private prune() {
    const terminal = [...this.records.values()].filter((task) => task.result);
    for (const task of terminal.slice(0, Math.max(0, terminal.length - MAX_TERMINAL_RECORDS)))
      this.records.delete(task.id);
  }
}
