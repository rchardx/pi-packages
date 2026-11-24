import { type WaitOutcome, Waitable } from "./inbox.ts";
import { MAX_INBOX_MESSAGES, MAX_ROOT_WAIT_SECONDS } from "./protocol.ts";

/** A session message the root agent has not been shown yet. */
export interface Update {
  customType: string;
  content: string;
  details: unknown;
}

/**
 * Root-session updates owned by the extension until they are handed to Pi.
 * They never wait in Pi's steering queue, which the host can clear without
 * telling extensions, so the pending count here is exact.
 */
export class Mailbox extends Waitable {
  private readonly updates: { update: Update; bounded: boolean; agentId?: string }[] = [];
  private readonly maxMessages: number;
  protected override readonly maxWaitSeconds = MAX_ROOT_WAIT_SECONDS;

  constructor(maxMessages = MAX_INBOX_MESSAGES) {
    super();
    this.maxMessages = maxMessages;
  }

  /** Messages from subagents are bounded; a full mailbox rejects instead of dropping. */
  offerMessage(update: Update, agentId?: string): boolean {
    if (this.updates.filter((entry) => entry.bounded).length >= this.maxMessages) return false;
    this.updates.push({ update, bounded: true, ...(agentId !== undefined ? { agentId } : {}) });
    this.wake();
    return true;
  }

  /** Completion results are limited by the concurrency limit, not the message bound. */
  addResult(update: Update, agentId?: string): void {
    this.updates.push({ update, bounded: false, ...(agentId !== undefined ? { agentId } : {}) });
    this.wake();
  }

  hasQueued(): boolean {
    return this.updates.length > 0;
  }

  /**
   * Wait for an update, or with `all` until no targeted subagent remains unsettled.
   * When `ids` is provided, only updates from those subagents wake the wait. Completion
   * results then stay queued; a matching message from a subagent still ends the wait,
   * because its sender may be waiting on an answer.
   */
  async waitForUpdates(
    timeoutSeconds: number | undefined,
    signal: AbortSignal | undefined,
    unsettled: () => number,
    all: boolean,
    ids?: ReadonlySet<string>,
  ): Promise<WaitOutcome> {
    const matches = (entry: { agentId?: string }) =>
      !ids || (entry.agentId !== undefined && ids.has(entry.agentId));
    const hasMatchingUpdate = () => this.updates.some(matches);
    const hasMatchingMessage = () => this.updates.some((entry) => entry.bounded && matches(entry));
    const result = await this.wait(
      timeoutSeconds,
      signal,
      () => unsettled() > 0,
      all ? hasMatchingMessage : hasMatchingUpdate,
    );
    // The last subagent's result is queued just after the wake for nothing unsettled.
    if (result.outcome === "idle" && hasMatchingUpdate())
      return { outcome: "woke", waitedMs: result.waitedMs };
    return all && result.outcome === "timeout" ? { ...result, running: unsettled() } : result;
  }

  take(): Update | undefined {
    return this.updates.shift()?.update;
  }

  drain(): Update[] {
    return this.updates.splice(0).map((entry) => entry.update);
  }

  clear(): void {
    this.updates.length = 0;
    this.wake();
  }
}
