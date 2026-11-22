import { randomUUID } from "node:crypto";
import { oneLine } from "./notify.ts";
import {
  type DeliveryAck,
  type Launch,
  MAIN_AGENT_ID,
  MAX_CONCURRENT,
  MAX_TERMINAL_RECORDS,
  type MessageEnvelope,
  type Result,
  type RunningAgent,
  validateMessage,
} from "./protocol.ts";
import { type Execution, type RunnerOptions, startChild } from "./runner.ts";

export interface Task {
  id: string;
  role?: string;
  task: string;
  startedAt: number;
  handedOff: boolean;
  cancelRequested: boolean;
  execution?: Execution;
  result?: Result;
}

/** Names what the model passed and what is accepted; a truncated card ID is the usual cause. */
function unknownSubagent(id: string): Error {
  return new Error(
    `No subagent "${oneLine(id, 64)}" in this session. Pass the full UUID returned by subagent; subagent_list shows those still running, and old terminal records expire.`,
  );
}

export type StartChild = (launch: Launch, options?: RunnerOptions) => Execution;

export class Tasks {
  readonly records = new Map<string, Task>();
  private closed = false;

  private readonly notify: (task: Task, result: Result) => void;
  private readonly start: StartChild;
  private readonly onChange: () => void;
  private readonly deliverToMain: (envelope: MessageEnvelope) => DeliveryAck;
  private readonly onSettled: () => void;

  constructor(
    notify: (task: Task, result: Result) => void,
    start: StartChild = startChild,
    onChange: () => void = () => {},
    deliverToMain: (envelope: MessageEnvelope) => DeliveryAck = () => ({
      accepted: false,
      reason: "finished",
    }),
    onSettled: () => void = () => {},
  ) {
    this.notify = notify;
    this.start = start;
    this.onChange = onChange;
    this.deliverToMain = deliverToMain;
    this.onSettled = onSettled;
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

  /** Handed-off children whose process has not yet settled, including those stopping. */
  unsettledCount(): number {
    if (this.closed) return 0;
    return [...this.records.values()].filter((task) => task.handedOff && !task.result).length;
  }

  list(now = Date.now()): RunningAgent[] {
    return this.runningTasks().map((task) => ({
      id: task.id,
      ...(task.role ? { role: task.role } : {}),
      elapsedMs: Math.max(0, now - task.startedAt),
      task: oneLine(task.task, 120),
    }));
  }

  /** Resolves once the running child has accepted the message into its queue. */
  async sendToChild(rawTo: string, message: string): Promise<string> {
    if (this.closed) throw new Error("The owning session has ended.");
    validateMessage(message);
    const to = rawTo.trim();
    const target = this.records.get(to);
    if (!target || (!target.handedOff && !target.result)) {
      throw unknownSubagent(to);
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
      id: randomUUID(),
      from: MAIN_AGENT_ID,
      to,
      message,
    });
    if (!ack.accepted) {
      if (ack.reason === "queue_full") throw new Error(`Subagent ${to} message queue is full.`);
      const status = this.records.get(to)?.result?.status;
      throw new Error(
        status
          ? `Subagent ${to} has already finished (${status}) and cannot receive messages.`
          : `Subagent ${to} has already finished and cannot receive messages.`,
      );
    }
    return to;
  }

  private sendToMain(from: string, message: string): void {
    if (this.closed) throw new Error("The owning session has ended.");
    validateMessage(message);
    const ack = this.deliverToMain({ id: randomUUID(), from, to: MAIN_AGENT_ID, message });
    if (!ack.accepted) {
      throw new Error(
        ack.reason === "queue_full"
          ? "Main session message queue is full."
          : "The owning session has ended.",
      );
    }
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
      ...(launch.role ? { role: launch.role } : {}),
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
        { onSend: (message) => this.sendToMain(task.id, message) },
      );
    } catch (error) {
      this.records.delete(task.id);
      throw error;
    }
    task.execution = execution;
    const abort = () => {
      void this.requestCancel(task, execution);
    };
    signal?.addEventListener("abort", abort, { once: true });
    void execution.done.then((result) => {
      const wasRunning = task.handedOff && !task.result && !task.cancelRequested;
      task.result = result;
      delete task.execution;
      if (wasRunning && !this.closed) this.onChange();
      if (task.handedOff && !this.closed) {
        this.onSettled();
        if (!task.cancelRequested) this.notify(task, result);
      }
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

  private requestCancel(task: Task, execution: Execution): Promise<Result> {
    const wasRunning = task.handedOff && !task.result && !task.cancelRequested;
    task.cancelRequested = true;
    if (wasRunning && !this.closed) this.onChange();
    return execution.cancel();
  }

  /** The result carries the ID the task is recorded under, without the caller's padding. */
  async cancel(rawId: string): Promise<Result & { id: string }> {
    const id = rawId.trim();
    const task = this.records.get(id);
    if (!task) throw unknownSubagent(id);
    if (task.result) return { id, ...task.result };
    if (!task.execution) throw new Error("Subagent has no running execution.");
    return { id, ...(await this.requestCancel(task, task.execution)) };
  }

  /**
   * Stop a running handed-off subagent owned by this session. Claims cancellation
   * synchronously and returns undefined when unknown, not running, or already stopping.
   */
  async stop(id: string): Promise<Task | undefined> {
    if (this.closed) return undefined;
    const task = this.records.get(id);
    if (!task?.handedOff || task.result || task.cancelRequested || !task.execution) {
      return undefined;
    }
    await this.requestCancel(task, task.execution);
    return task;
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
