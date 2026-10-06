import type { Logger } from '@hatti/logger';
import type { StorefrontPublisher } from '../storefront/publisher.js';
import { repeat } from './repeat.js';

/**
 * How long a shop's storefront waits, nothing listed for it since, before the sweep builds it:
 * longer than an event's own tries take, ten of them a second apart and doubling, about eight and
 * a half minutes, so that the sweep builds what the events gave up on and nothing they still try.
 */
export const STOREFRONT_IDLE_MS = 10 * 60_000;

/** Shops taken at a time. */
const BATCH = 100;

/**
 * Builds the storefronts left waiting (ADR-225): shops whose items their publisher didn't build,
 * as when an event's tries ran out while Postgres or Valkey were away, rather than leaving them
 * for the shop's next change. Each sweep takes the shops listed `idleMs` ago and builds each as
 * the events' publisher does, its lock keeping the two from building a shop at once. A shop that
 * fails again is listed again and tried `idleMs` on; the others go on.
 */
export class StorefrontSweep {
  constructor(
    private readonly publisher: Pick<StorefrontPublisher, 'queue' | 'publish'>,
    private readonly logger?: Logger,
    private readonly idleMs = STOREFRONT_IDLE_MS,
  ) {}

  /** One sweep: how many items it built. */
  async sweep(): Promise<number> {
    let built = 0;
    for (;;) {
      const shops = await this.publisher.queue.takeWaiting(this.idleMs, BATCH);
      for (const shopId of shops) {
        try {
          built += await this.publisher.publish(shopId);
        } catch (error) {
          this.logger?.warn({ err: error, shopId }, 'storefront left waiting not built');
        }
      }
      // Those taken are listed from now: the next take holds others.
      if (shops.length < BATCH) return built;
    }
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'storefront sweep failed'),
    );
  }
}
