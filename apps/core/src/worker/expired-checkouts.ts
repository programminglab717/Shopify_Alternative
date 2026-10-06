import type { CheckoutExpiry, ExpiredCounts } from '@hatti/checkout/public';
import type { Logger } from '@hatti/logger';
import { repeat } from './repeat.js';

/** Rows of each kind deleted at a time. */
const BATCH = 1_000;

/**
 * Deletes carts, checkouts and browsers' proofs of a number once they are past their time
 * (ADR-042, ADR-230), across shops, rather than as shoppers' requests make new ones: each sweep,
 * a batch at a time, until a batch comes back short. A shop whose rows could not be deleted is
 * logged, and tried again on the next sweep.
 */
export class ExpiredCheckouts {
  constructor(
    private readonly expiry: CheckoutExpiry,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: how many of each it deleted. */
  async sweep(at: Date = new Date()): Promise<ExpiredCounts> {
    const total: ExpiredCounts = { checkouts: 0, carts: 0, proofs: 0 };
    for (;;) {
      const deleted = await this.expiry.deleteExpired(at, BATCH, (shopId, error) =>
        this.logger?.warn({ err: error, shopId }, 'expired carts and checkouts not deleted'),
      );
      total.checkouts += deleted.checkouts;
      total.carts += deleted.carts;
      total.proofs += deleted.proofs;
      // A short batch is the last: what was found but changed since is not looked for again.
      if (Object.values(deleted).every((count) => count < BATCH)) break;
    }
    if (total.checkouts + total.carts + total.proofs > 0) {
      this.logger?.info(total, 'expired carts and checkouts deleted');
    }
    return total;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'expired checkouts sweep failed'),
    );
  }
}
