import { type TUnsafe, Type } from "typebox";
import { formatDuration } from "./notify.ts";
import {
  DEFAULT_WAIT_SECONDS,
  MAX_INBOX_MESSAGES,
  MAX_WAIT_SECONDS,
  type RunningAgent,
  STATUSES,
  validateWaitTimeout,
  WAIT_COALESCE_MS,
} from "./protocol.ts";

function stringEnum<const T extends readonly string[]>(values: T): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values] });
}

export const SubagentLaunchOutputSchema = Type.Object(
  {
    id: Type.String(),
    role: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SubagentCancelOutputSchema = Type.Object(
  {
    id: Type.String(),
    status: stringEnum(STATUSES),
    report: Type.String(),
    requests: Type.Integer({ minimum: 0 }),
    tokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SubagentListOutputSchema = Type.Object(
  {
    agents: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          role: Type.Optional(Type.String()),
          elapsedMs: Type.Number({ minimum: 0 }),
          task: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const SubagentSendOutputSchema = Type.Object(
  { to: Type.String() },
  { additionalProperties: false },
);

const WAIT_OUTCOMES = ["woke", "idle", "timeout"] as const;

export const RootWaitOutputSchema = Type.Object(
  {
    outcome: stringEnum(WAIT_OUTCOMES),
    waitedMs: Type.Number({ minimum: 0 }),
    running: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ChildWaitOutputSchema = Type.Object(
  {
    outcome: stringEnum(WAIT_OUTCOMES),
    waitedMs: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type WaitOutcome =
  | { outcome: "woke" | "idle" | "timeout"; waitedMs: number }
  /** A wait for every subagent that ran out of time. */
  | { outcome: "timeout"; waitedMs: number; running: number };

/** Event-driven waiting on updates that an agent has not yet been shown. */
export abstract class Waitable {
  private readonly waiters = new Set<() => void>();

  protected readonly maxWaitSeconds: number = MAX_WAIT_SECONDS;

  abstract hasQueued(): boolean;

  wake(): void {
    for (const notify of [...this.waiters]) notify();
  }

  async wait(
    timeoutSeconds: number | undefined,
    signal?: AbortSignal,
    canStillReceive?: () => boolean,
    /** What ends the wait as "woke"; by default, any queued update. */
    ready: () => boolean = () => this.hasQueued(),
  ): Promise<{ outcome: "woke" | "idle" | "timeout"; waitedMs: number }> {
    const seconds = validateWaitTimeout(timeoutSeconds, this.maxWaitSeconds);
    if (signal?.aborted) throw new Error("Wait cancelled.");
    if (ready()) return { outcome: "woke", waitedMs: 0 };
    if (canStillReceive && !canStillReceive()) return { outcome: "idle", waitedMs: 0 };

    const startedAt = Date.now();
    return new Promise<WaitOutcome>((resolve, reject) => {
      let settled = false;
      let coalesceTimer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        if (coalesceTimer) clearTimeout(coalesceTimer);
        this.waiters.delete(onWake);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (outcome: WaitOutcome["outcome"]) => {
        if (settled) return;
        cleanup();
        resolve({ outcome, waitedMs: Math.max(0, Date.now() - startedAt) });
      };
      const onAbort = () => {
        if (settled) return;
        cleanup();
        reject(new Error("Wait cancelled."));
      };
      const onWake = () => {
        if (settled) return;
        if (!ready() && canStillReceive && !canStillReceive()) {
          finish("idle");
          return;
        }
        if (!ready()) return;
        if (coalesceTimer) return;
        coalesceTimer = setTimeout(() => finish("woke"), WAIT_COALESCE_MS);
        coalesceTimer.unref();
      };
      const deadlineTimer = setTimeout(() => finish("timeout"), Math.round(seconds * 1000));
      deadlineTimer.unref();
      this.waiters.add(onWake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * Child-side record of steering messages accepted into the host queue and not yet
 * committed to the transcript. A child runs headless, where nothing clears that
 * queue, so every accepted message reaches a message_end.
 */
export class AgentInbox extends Waitable {
  private readonly queuedMessageIds = new Set<string>();
  private readonly maxMessages: number;

  constructor(maxMessages = MAX_INBOX_MESSAGES) {
    super();
    this.maxMessages = maxMessages;
  }

  acceptMessage(id: string): boolean {
    if (this.queuedMessageIds.size >= this.maxMessages) return false;
    this.queuedMessageIds.add(id);
    this.wake();
    return true;
  }

  markMessageCommitted(id: string): void {
    this.queuedMessageIds.delete(id);
  }

  hasQueued(): boolean {
    return this.queuedMessageIds.size > 0;
  }

  clear(): void {
    this.queuedMessageIds.clear();
    this.wake();
  }
}

export function formatAgentList(agents: readonly RunningAgent[]): string {
  if (agents.length === 0) return "No subagents running.";
  const lines = agents.map((agent) => {
    const parts = [`- ${agent.id}`];
    if (agent.role) parts.push(agent.role);
    parts.push(formatDuration(agent.elapsedMs), agent.task);
    return parts.join(" · ");
  });
  return `Running subagents (${agents.length}):\n${lines.join("\n")}`;
}

export function formatWaitOutcome(result: WaitOutcome): string {
  switch (result.outcome) {
    case "woke":
      return "Incoming update queued; continuing to process it.";
    case "idle":
      return "No running subagents or queued updates remain.";
    case "timeout":
      return "running" in result
        ? `${result.running} subagent(s) still running after ${formatDuration(result.waitedMs)}.`
        : `No updates arrived within ${formatDuration(result.waitedMs)}.`;
  }
}

/** The wait limit differs between the root session and a child. */
export const waitTimeoutParameter = (maxSeconds: number) =>
  Type.Optional(
    Type.Number({
      description: `Maximum seconds to wait before returning (default ${DEFAULT_WAIT_SECONDS}, max ${maxSeconds}).`,
    }),
  );
