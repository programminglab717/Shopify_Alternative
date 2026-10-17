import type { Logger } from '@hatti/logger';
import type { MetaAdAccountService } from '@hatti/marketing/public';
import { repeat } from './repeat.js';

/** Shops pulled in a round, those asked longest ago first: the rest wait for the next. */
const BATCH = 500;

/**
 * Pulls shops' ad spend from the Meta ad accounts they connected (MKT-12, ADR-564): each round,
 * every shop's last week, by day and campaign, as Meta revises its recent days, in the place of
 * what was pulled of it before; what the shop typed by hand stays. A shop Meta refuses keeps
 * why, for the admin to show, and is tried again the next round.
 */
export class AdSpendSync {
  constructor(
    private readonly accounts: MetaAdAccountService,
    private readonly logger?: Logger,
  ) {}

  /**
   * One round: each shop not pulled in the last `gapMs`, as one pulled by hand or just
   * connected was. How many Meta answered for.
   */
  async sweep(at: Date = new Date(), gapMs = 0): Promise<number> {
    const shops = await this.accounts.dueShops(new Date(at.getTime() - gapMs), BATCH);
    let pulled = 0;
    for (const shopId of shops) {
      try {
        const result = await this.accounts.sync(shopId, at);
        if (result?.ok) {
          pulled += 1;
        } else if (result) {
          this.logger?.info({ shopId, error: result.message }, 'ad spend not pulled');
        }
      } catch (error) {
        // One shop's failure is not the others': it is tried again the next round.
        this.logger?.warn({ err: error, shopId }, 'ad spend not pulled');
      }
    }
    return pulled;
  }

  /** Pulls now, then every `intervalMs`, a round never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(new Date(), intervalMs / 2),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'ad spend sweep failed'),
    );
  }
}
