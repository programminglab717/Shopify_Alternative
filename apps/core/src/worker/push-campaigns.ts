import type { Logger } from '@hatti/logger';
import type { ShopperPushService } from '@hatti/messaging/public';
import { repeat } from './repeat.js';

/**
 * Pushes shops' push campaigns to their shoppers' browsers (OS-14, ADR-834): each sweep, those
 * still being sent, each a batch at a time, every batch in its own transaction, until it reaches
 * every browser or marketing hours end. One that throws is tried again on the next sweep, from
 * where it got to.
 */
export class PushCampaigns {
  constructor(
    private readonly pushes: Pick<ShopperPushService, 'due' | 'pushNext'>,
    private readonly logger?: Logger,
  ) {}

  /** One sweep: how many browsers it pushed to. */
  async sweep(at: Date = new Date()): Promise<number> {
    let pushed = 0;
    for (const { shopId, id } of await this.pushes.due()) {
      try {
        for (;;) {
          const round = await this.pushes.pushNext(shopId, id, at);
          // Waiting for marketing hours, or taken by another sweep.
          if (round.outcome !== 'pushed') break;
          pushed += round.sent;
          if (round.done) {
            this.logger?.info({ shopId, pushCampaignId: id }, 'push campaign sent');
            break;
          }
        }
      } catch (error) {
        this.logger?.warn({ err: error, shopId, pushCampaignId: id }, 'push campaign not sent');
      }
    }
    return pushed;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'push campaigns sweep failed'),
    );
  }
}
