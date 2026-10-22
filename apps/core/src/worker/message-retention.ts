import type { Logger } from '@hatti/logger';
import type { MessageRetention, PurgedCounts } from '@hatti/messaging/public';
import { repeat } from './repeat.js';

/** Rows of each kind cleared or deleted at a time. */
const BATCH = 1_000;

/**
 * Clears what messages to customers said and deletes what customers wrote, in the inbox and
 * through the contact form, once twelve months old (ADR-738), across shops: each sweep, a batch at
 * a time, until a batch comes back short. A shop whose rows could not be changed is logged, and
 * tried again on the next sweep.
 */
export class MessageContentRetention {
  constructor(
    private readonly retention: MessageRetention,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: how many of each it cleared or deleted. */
  async sweep(at: Date = new Date()): Promise<PurgedCounts> {
    const total: PurgedCounts = {
      messages: 0,
      conversationMessages: 0,
      conversations: 0,
      contactMessages: 0,
    };
    for (;;) {
      const purged = await this.retention.purge(at, BATCH, (shopId, error) =>
        this.logger?.warn({ err: error, shopId }, 'message content not purged'),
      );
      for (const kind of Object.keys(total) as (keyof PurgedCounts)[]) {
        total[kind] += purged[kind];
      }
      if (Object.values(purged).every((count) => count < BATCH)) break;
    }
    if (Object.values(total).some((count) => count > 0)) {
      this.logger?.info(total, 'message content past twelve months purged');
    }
    return total;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'message retention sweep failed'),
    );
  }
}
