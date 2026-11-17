import { Waitable } from "./inbox.ts";
import { MAX_INBOX_MESSAGES } from "./protocol.ts";

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
  private readonly updates: { update: Update; bounded: boolean }[] = [];
  private readonly maxMessages: number;

  constructor(maxMessages = MAX_INBOX_MESSAGES) {
    super();
    this.maxMessages = maxMessages;
  }

  /** Peer messages are bounded; a full mailbox rejects instead of dropping. */
  offerMessage(update: Update): boolean {
    if (this.updates.filter((entry) => entry.bounded).length >= this.maxMessages) return false;
    this.updates.push({ update, bounded: true });
    this.wake();
    return true;
  }

  /** Completion results are limited by the concurrency limit, not the peer bound. */
  addResult(update: Update): void {
    this.updates.push({ update, bounded: false });
    this.wake();
  }

  hasQueued(): boolean {
    return this.updates.length > 0;
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
