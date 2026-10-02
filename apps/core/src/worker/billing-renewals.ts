import type { BillingService } from '@hatti/billing/public';
import type { Logger } from '@hatti/logger';
import { repeat } from './repeat.js';

/**
 * Renews shops' plans with Hatti (ADR-154): a week before a paid period ends, its next period is
 * invoiced; a period that ended with Free chosen next, or a week unpaid, leaves the shop on Free.
 */
export class BillingRenewals {
  constructor(
    private readonly billing: BillingService,
    private readonly logger?: Logger,
  ) {}

  async sweep(at: Date = new Date()): Promise<{ invoiced: number; ended: number; failed: number }> {
    const done = await this.billing.sweep(at);
    if (done.invoiced + done.ended + done.failed > 0) this.logger?.info(done, 'billing renewed');
    return done;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'billing renewals sweep failed'),
    );
  }
}
