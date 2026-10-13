import type { AbandonedCheckoutService } from '@hatti/checkout/public';
import type { Logger } from '@hatti/logger';
import { repeat } from './repeat.js';

/**
 * Reminds shoppers who typed their number at checkout and left (CHK-12, ADR-393): once each, on
 * WhatsApp, as long after as their shop says, with a link back to their items. A shop whose
 * reminders could not be sent is logged, and tried again on the next sweep.
 */
export class CheckoutReminders {
  constructor(
    private readonly abandoned: AbandonedCheckoutService,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: how many it reminded. */
  async sweep(at: Date = new Date()): Promise<number> {
    const reminded = await this.abandoned.remindDue(at, (shopId, error) =>
      this.logger?.warn({ err: error, shopId }, 'checkout reminders not sent'),
    );
    if (reminded > 0) this.logger?.info({ reminded }, 'shoppers reminded of their checkouts');
    return reminded;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'checkout reminders sweep failed'),
    );
  }
}
