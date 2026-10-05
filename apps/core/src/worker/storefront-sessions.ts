import type { Logger } from '@hatti/logger';
import type { LinkTapsService, SessionDaysService } from '@hatti/online-store/public';
import type { StorefrontActivity } from '@hatti/storefront-data';
import { repeat } from './repeat.js';

/** Shops' days taken from Valkey at a time. */
const BATCH = 500;

const SHOP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Keeps the storefronts' counts of each day's sessions in Postgres (ANL-02, ADR-180), and of the
 * day's taps on the links of the shop's link page (ADR-204): each sweep, the shops' days counted
 * since the last, their counts so far in place of those kept before, each in its shop's own
 * transactions. A day not kept is given back, for the next sweep.
 */
export class StorefrontSessions {
  constructor(
    private readonly activity: StorefrontActivity,
    private readonly stores: { days: SessionDaysService; taps: LinkTapsService },
    private readonly logger?: Logger,
  ) {}

  /** One sweep of the days counted since the last: how many it kept. */
  async sweep(): Promise<number> {
    let kept = 0;
    for (;;) {
      const changed = await this.activity.takeChanged(BATCH);
      const failed: typeof changed = [];
      for (const { shopId, day } of changed) {
        // Never a shop's: nothing to keep, nor to give back.
        if (!SHOP_ID.test(shopId) || !DAY.test(day)) continue;
        try {
          const counts = await this.activity.counts(shopId, day);
          await this.stores.days.keep(shopId, day, {
            sessions: counts.sessions,
            addedToCart: counts.added_to_cart,
            reachedCheckout: counts.reached_checkout,
            converted: counts.converted,
          });
          await this.stores.taps.keep(shopId, day, await this.activity.linkTaps(shopId, day));
          kept += 1;
        } catch (error) {
          failed.push({ shopId, day });
          this.logger?.warn({ err: error, shopId, day }, 'sessions not kept');
        }
      }
      await this.activity.giveBack(failed);
      // What failed waits for the next sweep, not this one.
      if (changed.length < BATCH || failed.length > 0) return kept;
    }
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'storefront sessions sweep failed'),
    );
  }
}
