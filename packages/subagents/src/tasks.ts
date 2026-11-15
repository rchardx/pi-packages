import { randomUUID } from "node:crypto";
import { MAX_CONCURRENT, MAX_TERMINAL_RECORDS, type Launch, type Result } from "./protocol.ts";
import { type Execution, startChild } from "./runner.ts";

export interface Task {
  id: string;
  task: string;
  startedAt: number;
  cancelRequested: boolean;
  execution?: Execution;
  result?: Result;
}

export class Tasks {
  readonly records = new Map<string, Task>();
  private closed = false;

  private readonly notify: (task: Task, result: Result) => void;
  private readonly start: (launch: Launch) => Execution;

  constructor(
    notify: (task: Task, result: Result) => void,
    start: (launch: Launch) => Execution = startChild,
  ) {
    this.notify = notify;
    this.start = start;
  }

  async launch(launch: Launch, signal?: AbortSignal): Promise<string> {
    if (this.closed) throw new Error("The owning session has ended.");
    if (signal?.aborted) throw new Error("Subagent startup cancelled.");
    const running = [...this.records.values()].filter((task) => !task.result).length;
    if (running >= MAX_CONCURRENT)
      throw new Error(
        `At most ${MAX_CONCURRENT} subagents may run in this session. Wait for a completion notification.`,
      );
    const task: Task = {
      id: randomUUID(),
      task: launch.task,
      startedAt: Date.now(),
      cancelRequested: false,
    };
    // Reserve before startup so concurrent calls cannot overbook the session.
    this.records.set(task.id, task);
    let execution: Execution;
    try {
      execution = this.start(launch);
    } catch (error) {
      this.records.delete(task.id);
      throw error;
    }
    task.execution = execution;
    let handedOff = false;
    const abort = () => {
      task.cancelRequested = true;
      void execution.cancel();
    };
    signal?.addEventListener("abort", abort, { once: true });
    void execution.done.then((result) => {
      task.result = result;
      delete task.execution;
      if (handedOff && !this.closed && !task.cancelRequested) this.notify(task, result);
      this.prune();
    });
    try {
      await execution.ready;
      if (this.closed || signal?.aborted || task.result)
        throw new Error("Subagent ended during startup.");
      signal?.removeEventListener("abort", abort);
      handedOff = true;
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
    task.cancelRequested = true;
    return task.execution.cancel();
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.records.values()].map((task) => task.execution?.cancel()));
    this.records.clear();
  }

  private prune() {
    const terminal = [...this.records.values()].filter((task) => task.result);
    for (const task of terminal.slice(0, Math.max(0, terminal.length - MAX_TERMINAL_RECORDS)))
      this.records.delete(task.id);
  }
}
