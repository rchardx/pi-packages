import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatDuration } from "./notify.ts";
import {
  DEFAULT_WAIT_SECONDS,
  type DeliveryReceipt,
  type LiveAgent,
  MAX_INBOX_MESSAGES,
  MAX_MESSAGE_BYTES,
  MAX_WAIT_SECONDS,
  validateWaitTimeout,
  WAIT_COALESCE_MS,
} from "./protocol.ts";
import {
  renderListCall,
  renderListResult,
  renderSendCall,
  renderSendResult,
  renderWaitCall,
  renderWaitResult,
} from "./render.ts";

export type WaitOutcome = {
  outcome: "woke" | "idle" | "timeout";
  waitedMs: number;
};

/** Event-driven waiting on updates that an agent has not yet been shown. */
export abstract class Waitable {
  private readonly waiters = new Set<() => void>();

  abstract hasQueued(): boolean;

  wake(): void {
    for (const notify of [...this.waiters]) notify();
  }

  async wait(
    timeoutSeconds: number | undefined,
    signal?: AbortSignal,
    canStillReceive?: () => boolean,
  ): Promise<WaitOutcome> {
    const seconds = validateWaitTimeout(timeoutSeconds);
    if (signal?.aborted) throw new Error("Wait cancelled.");
    if (this.hasQueued()) return { outcome: "woke", waitedMs: 0 };
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
        if (!this.hasQueued() && canStillReceive && !canStillReceive()) {
          finish("idle");
          return;
        }
        if (!this.hasQueued() && (!canStillReceive || canStillReceive())) return;
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

export function formatAgentList(agents: readonly LiveAgent[]): string {
  if (agents.length === 0) return "No live agents in this session.";
  const lines = agents.map((agent) => {
    const selfTag = agent.self ? " (self)" : "";
    const parts = [`- ${agent.id}${selfTag}`];
    if (agent.role) parts.push(agent.role);
    if (agent.elapsedMs !== undefined) parts.push(formatDuration(agent.elapsedMs));
    if (agent.task) parts.push(agent.task);
    return parts.join(" · ");
  });
  return `Live agents in this session (${agents.length}):\n${lines.join("\n")}`;
}

export function formatDeliveryReceipt(receipt: DeliveryReceipt): string {
  if (!receipt.broadcast) {
    return `Queued message for ${receipt.to} (accepted into recipient queue; not yet processed).`;
  }
  const total = receipt.delivered.length + receipt.skipped.length;
  if (total === 0) return "No live peers to broadcast to.";
  const summary = `Broadcast queued for ${receipt.delivered.length} of ${total} peer(s).`;
  if (receipt.skipped.length === 0) return summary;
  const skippedLines = receipt.skipped.map((entry) => `- ${entry.id}: skipped (${entry.reason})`);
  return `${summary}\n${skippedLines.join("\n")}`;
}

export function formatWaitOutcome(result: WaitOutcome): string {
  switch (result.outcome) {
    case "woke":
      return "Incoming update queued; continuing to process it.";
    case "idle":
      return "No running subagents or queued updates remain.";
    case "timeout":
      return `No updates arrived within ${formatDuration(result.waitedMs)}.`;
  }
}

export interface CommunicationTransport {
  checkContext?(ctx: ExtensionToolContext): void;
  list(signal?: AbortSignal, ctx?: ExtensionToolContext): Promise<LiveAgent[]>;
  send(
    to: string,
    message: string,
    signal?: AbortSignal,
    ctx?: ExtensionToolContext,
  ): Promise<DeliveryReceipt>;
  wait(
    timeoutSeconds: number | undefined,
    signal?: AbortSignal,
    ctx?: ExtensionToolContext,
  ): Promise<WaitOutcome>;
}

export function registerCommunicationTools(
  pi: ExtensionAPI,
  transport: CommunicationTransport,
  options: { isChild: boolean },
): void {
  pi.registerTool({
    name: "subagent_list",
    label: "subagent_list",
    description:
      'List live agents in the current root session, including "main" and running subagents. Completed or cancelled subagents are omitted.',
    parameters: Type.Object({}),
    renderCall: renderListCall,
    renderResult: renderListResult,
    async execute(_callId, _params, signal, _update, ctx) {
      transport.checkContext?.(ctx);
      const agents = await transport.list(signal, ctx);
      return {
        content: [{ type: "text", text: formatAgentList(agents) }],
        details: { agents },
      };
    },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "subagent_send",
    description:
      `Send a message (at most ${MAX_MESSAGE_BYTES / 1024} KiB) to a live agent in this root session: ` +
      'pass a subagent UUID, "main" for the root session, or "*" to broadcast to all live peers excluding yourself. ' +
      "Delivery queues the message for the recipient's next turn without waiting for a reply. Completed subagents cannot receive messages.",
    parameters: Type.Object({
      to: Type.String({
        description:
          'Recipient subagent UUID, "main" for the root session, or "*" to broadcast to all live peers.',
      }),
      message: Type.String({
        description: "Nonempty message text to deliver to the recipient(s).",
      }),
    }),
    renderCall: renderSendCall,
    renderResult: renderSendResult,
    async execute(_callId, { to, message }, signal, _update, ctx) {
      transport.checkContext?.(ctx);
      const receipt = await transport.send(to, message, signal, ctx);
      return {
        content: [{ type: "text", text: formatDeliveryReceipt(receipt) }],
        details: receipt,
      };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "subagent_wait",
    description: options.isChild
      ? `Wait without polling for an incoming peer message (default ${DEFAULT_WAIT_SECONDS}s, max ${MAX_WAIT_SECONDS}s). ` +
        "Call this after subagent_send when you need a reply before completing your task; ending your turn without waiting completes and closes your agent."
      : `Wait without polling for an incoming subagent message or completion notification (default ${DEFAULT_WAIT_SECONDS}s, max ${MAX_WAIT_SECONDS}s). ` +
        "Returns immediately when updates are already queued or no subagents are running.",
    parameters: Type.Object({
      timeoutSeconds: Type.Optional(
        Type.Number({
          description: `Maximum seconds to wait before returning (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}).`,
        }),
      ),
    }),
    renderCall: renderWaitCall,
    renderResult: renderWaitResult,
    async execute(_callId, { timeoutSeconds }, signal, _update, ctx) {
      transport.checkContext?.(ctx);
      const outcome = await transport.wait(timeoutSeconds, signal, ctx);
      return {
        content: [{ type: "text", text: formatWaitOutcome(outcome) }],
        details: outcome,
      };
    },
  });
}
