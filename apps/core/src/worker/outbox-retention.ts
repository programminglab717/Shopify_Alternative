import type { Db } from '@hatti/db';
import { OUTBOX_KEPT_DAYS, maintainOutboxPartitions, purgePublishedEvents } from '@hatti/events';
import type { Logger } from '@hatti/logger';
import { repeat } from './repeat.js';

/** Events deleted at a time: each a short statement, never a long lock on the outbox. */
const BATCH = 5_000;

/** Purges `limit` events published before a time, and says how many. */
export type PurgePublished = (before: Date, limit: number) => Promise<number>;

/** Keeps the outbox's daily partitions at `at`, those of days ended by `before` dropped. */
export type MaintainPartitions = (
  at: Date,
  before: Date,
) => Promise<{ made: number; dropped: number }>;

/**
 * Deletes outbox events published more than seven days ago (ADR-746), a batch at a time until a
 * batch comes back short, so the outbox holds a week of events however many a shop makes. Those
 * not yet published, or parked, are kept. Each sweep keeps the outbox's daily partitions too
 * (ADR-988): the week ahead made, and past days emptied of all but those kept dropped whole.
 */
export class OutboxRetention {
  readonly #purge: PurgePublished;
  readonly #partitions: MaintainPartitions | null;

  constructor(
    db: Db | PurgePublished,
    private readonly logger?: Logger,
    partitions?: MaintainPartitions,
  ) {
    this.#purge =
      typeof db === 'function' ? db : (before, limit) => purgePublishedEvents(db, before, limit);
    this.#partitions =
      partitions ??
      (typeof db === 'function' ? null : (at, before) => maintainOutboxPartitions(db, at, before));
  }

  /** One sweep at `at`: how many events it deleted. */
  async sweep(at: Date = new Date()): Promise<number> {
    const before = new Date(at.getTime() - OUTBOX_KEPT_DAYS * 86_400_000);
    // Whole days first, then what is left of the rest a batch at a time.
    const partitions = this.#partitions ? await this.#partitions(at, before) : null;
    if (partitions && (partitions.made > 0 || partitions.dropped > 0)) {
      this.logger?.info(partitions, 'outbox daily partitions made and dropped');
    }
    let total = 0;
    for (;;) {
      const deleted = await this.#purge(before, BATCH);
      total += deleted;
      if (deleted < BATCH) break;
    }
    if (total > 0) this.logger?.info({ deleted: total }, 'outbox events past seven days deleted');
    return total;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'outbox retention sweep failed'),
    );
  }
}
