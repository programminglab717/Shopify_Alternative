import type { AbandonedCheckoutService } from '@hatti/checkout/public';
import type { Logger } from '@hatti/logger';
import { repeat } from './repeat.js';

/**
 * Reminds shoppers who typed their number at checkout and left (CHK-12, ADR-393): once each, on
 * WhatsApp, as long after as their shop says, with a link back to their items; and offers those
 * still not ordering the shop's discount code, some hours after, where it chose one (ADR-426). A
 * shop whose messages could not be sent is logged, and tried again on the next sweep.
 */
export class CheckoutReminders {
  constructor(
    private readonly abandoned: AbandonedCheckoutService,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: how many it reminded, and offered a code to. */
  async sweep(at: Date = new Date()): Promise<{ reminded: number; offered: number }> {
    const reminded = await this.abandoned.remindDue(at, (shopId, error) =>
      this.logger?.warn({ err: error, shopId }, 'checkout reminders not sent'),
    );
    if (reminded > 0) this.logger?.info({ reminded }, 'shoppers reminded of their checkouts');
    const offered = await this.abandoned.offerDue(at, (shopId, error) =>
      this.logger?.warn({ err: error, shopId }, 'checkout offers not sent'),
    );
    if (offered > 0) this.logger?.info({ offered }, 'shoppers offered a code for their checkouts');
    return { reminded, offered };
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
