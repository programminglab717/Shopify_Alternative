import type { Logger } from '@hatti/logger';
import type { OnlinePaymentService } from '@hatti/payments/public';
import { repeat } from './repeat.js';

/**
 * Asks the gateways after payments started online whose customers never came back (ADR-208):
 * each sweep, the shops with such payments due, found with the system role, each asked after in
 * its own transactions; a payment a gateway says is made is recorded paid, as its return would
 * have been. One shop's failure is not the others'.
 */
export class PaymentInquiries {
  constructor(
    private readonly payments: Pick<OnlinePaymentService, 'shopsWithInquiriesDue' | 'inquireDue'>,
    private readonly logger?: Logger,
  ) {}

  /** One sweep: how many payments it asked after, and found paid. */
  async sweep(at: Date = new Date()): Promise<{ asked: number; paid: number }> {
    let asked = 0;
    let paid = 0;
    for (const shopId of await this.payments.shopsWithInquiriesDue(at)) {
      try {
        const result = await this.payments.inquireDue(shopId, at);
        if (result.paid > 0) this.logger?.info({ shopId, ...result }, 'payments found paid');
        asked += result.asked;
        paid += result.paid;
      } catch (error) {
        // Tried again on the next sweep.
        this.logger?.warn({ err: error, shopId }, 'payments not asked after');
      }
    }
    return { asked, paid };
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'payment inquiries sweep failed'),
    );
  }
}
