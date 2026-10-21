import type { Logger } from '@hatti/logger';
import type {
  GoogleAdsAccountService,
  MetaAdAccountService,
  TikTokAdAccountService,
} from '@hatti/marketing/public';
import { repeat } from './repeat.js';

/** Shops pulled in a round on each platform, those asked longest ago first: the rest wait. */
const BATCH = 500;

/** A platform's accounts shops connected, whose spend is pulled. */
export type AdSpendAccounts = Pick<
  MetaAdAccountService | TikTokAdAccountService | GoogleAdsAccountService,
  'dueShops' | 'sync'
>;

/**
 * Pulls shops' ad spend from the Meta ad accounts (MKT-12, ADR-564), TikTok advertiser accounts
 * (ADR-566) and Google Ads accounts (ADR-678) they connected: each round, every shop's last week on each, by day and
 * campaign, as the platforms revise their recent days, in the place of what was pulled of it
 * before; what the shop typed by hand stays. A shop the platform refuses keeps why, for the admin
 * to show, and is tried again the next round.
 */
export class AdSpendSync {
  /** `platforms`: each platform's accounts, by its name, pulled in that order. */
  constructor(
    private readonly platforms: Readonly<Record<string, AdSpendAccounts>>,
    private readonly logger?: Logger,
  ) {}

  /**
   * One round: each shop not pulled in the last `gapMs` on each platform, as one pulled by hand
   * or just connected was. How many pulls the platforms answered.
   */
  async sweep(at: Date = new Date(), gapMs = 0): Promise<number> {
    let pulled = 0;
    for (const [platform, accounts] of Object.entries(this.platforms)) {
      const shops = await accounts.dueShops(new Date(at.getTime() - gapMs), BATCH);
      for (const shopId of shops) {
        try {
          const result = await accounts.sync(shopId, at);
          if (result?.ok) {
            pulled += 1;
          } else if (result) {
            this.logger?.info({ shopId, platform, error: result.message }, 'ad spend not pulled');
          }
        } catch (error) {
          // One shop's failure is not the others': it is tried again the next round.
          this.logger?.warn({ err: error, shopId, platform }, 'ad spend not pulled');
        }
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
