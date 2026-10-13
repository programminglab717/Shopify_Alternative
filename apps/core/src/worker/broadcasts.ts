import type { Logger } from '@hatti/logger';
import type { BroadcastsService } from '@hatti/messaging/public';
import { repeat } from './repeat.js';

/**
 * Queues shops' WhatsApp broadcasts once their time comes (MKT-01, ADR-422): each sweep, those
 * due, found with the system role, each queued a batch at a time, every batch in its own
 * transaction, until it is all queued or marketing hours end; then the sender sends them from the
 * shop's own number. One broadcast that cannot go, its template or segment gone, fails alone, and
 * one that throws is tried again on the next sweep.
 */
export class BroadcastQueue {
  constructor(
    private readonly broadcasts: Pick<BroadcastsService, 'due' | 'queueNext'>,
    private readonly logger?: Logger,
  ) {}

  /** One sweep: how many messages it queued. */
  async sweep(at: Date = new Date()): Promise<number> {
    let queued = 0;
    for (const { shopId, id } of await this.broadcasts.due(at)) {
      try {
        for (;;) {
          const round = await this.broadcasts.queueNext(shopId, id, at);
          if (round.outcome === 'failed') {
            this.logger?.warn({ shopId, broadcastId: id, error: round.error }, 'broadcast failed');
          }
          // Waiting for marketing hours, or moved on by another sweep or the shop.
          if (round.outcome !== 'queued') break;
          queued += round.queued;
          if (round.done) {
            this.logger?.info({ shopId, broadcastId: id }, 'broadcast queued');
            break;
          }
        }
      } catch (error) {
        this.logger?.warn({ err: error, shopId, broadcastId: id }, 'broadcast not queued');
      }
    }
    return queued;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'broadcasts sweep failed'),
    );
  }
}
