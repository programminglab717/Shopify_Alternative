import type { Logger } from '@hatti/logger';
import type { ClosedShopData } from '../closed-shops.js';
import { repeat } from './repeat.js';

/** Shops purged a sweep at most: each is a pass over every table of a shop's. */
const BATCH = 5;

/**
 * Deletes closed shops' data 90 days after they closed, but the records kept (ADR-741): each
 * sweep, the longest closed first. A shop whose data could not all go, or whose purge failed, is
 * logged, and tried again on the next sweep. Only while `CLOSED_SHOP_PURGE` is on.
 */
export class ClosedShopPurges {
  constructor(
    private readonly data: Pick<ClosedShopData, 'due' | 'purge'>,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: the shops purged. */
  async sweep(at: Date = new Date()): Promise<string[]> {
    const purged: string[] = [];
    for (const shop of await this.data.due(at, BATCH)) {
      try {
        const result = await this.data.purge(shop.id, at);
        if (!result) continue;
        if (result.blocked.length > 0) {
          this.logger?.warn(
            { shopId: shop.id, blocked: result.blocked },
            "closed shop's data not all deleted",
          );
          continue;
        }
        this.logger?.info(
          { shopId: shop.id, deleted: result.deleted },
          "closed shop's data deleted",
        );
        purged.push(shop.id);
      } catch (error) {
        this.logger?.warn({ err: error, shopId: shop.id }, "closed shop's data not deleted");
      }
    }
    return purged;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'closed shop purge sweep failed'),
    );
  }
}
