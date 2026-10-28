import type { Logger } from '@hatti/logger';
import type { DarazService } from '@hatti/orders/public';
import { repeat } from './repeat.js';

/**
 * Each shop's Daraz account synced (CH-06, ADR-875), the one synced longest ago first: Daraz's
 * new orders brought in, its cancellations followed, and what changed of the shop's stock and
 * prices given to Daraz. One shop's failure is kept as its account's last error, and the rest go on.
 */
export class DarazSync {
  constructor(
    private readonly daraz: Pick<DarazService, 'connectedShops' | 'sync'>,
    private readonly logger?: Pick<Logger, 'warn' | 'info'>,
  ) {}

  /** One round of every connected shop: how many were synced. */
  async sweep(at: Date = new Date()): Promise<number> {
    let synced = 0;
    for (const shopId of await this.daraz.connectedShops()) {
      try {
        const result = await this.daraz.sync(shopId, at);
        if (result) {
          synced += 1;
          if (result.imported + result.cancelled + result.leftOut > 0) {
            this.logger?.info({ shopId, ...result }, 'Daraz synced');
          }
        }
      } catch (error) {
        this.logger?.warn({ err: error, shopId }, 'Daraz not synced');
      }
    }
    return synced;
  }

  /** Syncs now, then every `intervalMs`, a round never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'Daraz sync failed'),
    );
  }
}
