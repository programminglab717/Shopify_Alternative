import type { StoreCreditService } from '@hatti/customers/public';
import type { Logger } from '@hatti/logger';
import { repeat } from './repeat.js';

/**
 * Records the expiry of customers' store credit (ORD-09, ADR-184): each sweep, every credit that
 * expired with something left ends with an expiration of it, across shops. A balance leaves out
 * an expired credit already; the sweep writes its end into the ledger.
 */
export class StoreCreditExpiry {
  constructor(
    private readonly storeCredit: StoreCreditService,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: how many credits it expired. */
  async sweep(at: Date = new Date()): Promise<number> {
    const expired = await this.storeCredit.expireDue(at);
    if (expired > 0) this.logger?.info({ expired }, 'store credit expired');
    return expired;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'store credit expiry sweep failed'),
    );
  }
}
