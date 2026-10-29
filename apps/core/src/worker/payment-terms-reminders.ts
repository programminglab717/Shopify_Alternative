import { Database } from '@hatti/db';
import type { Logger } from '@hatti/logger';
import { PAYMENT_TERMS_REMINDERS, remindPaymentTermsIn } from '@hatti/orders/public';
import { sql } from 'drizzle-orm';
import { repeat } from './repeat.js';

/**
 * Reminds customers owing on payment terms (CUS-06, ADR-945): the shops with an order on terms
 * still owed and due soon, or past due, found with the system role, which sees every shop; each
 * shop's orders reminded in its own transaction, before the date and once past it.
 */
export class PaymentTermsReminders {
  constructor(
    private readonly database: Database,
    private readonly logger?: Logger,
  ) {}

  /** One sweep of every shop with an order to remind: how many orders it reminded. */
  async sweep(at: Date = new Date()): Promise<number> {
    const soon = new Date(at.getTime() + PAYMENT_TERMS_REMINDERS.beforeMs).toISOString();
    const { rows: shops } = await this.database.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT DISTINCT shop_id FROM orders.orders
         WHERE payment_due_at IS NOT NULL AND terms_reminded < 2
           AND payment_due_at <= ${soon}::timestamptz
           AND status <> 'cancelled' AND amount_paid < total`),
    );
    let reminded = 0;
    for (const { shop_id: shopId } of shops) {
      try {
        const told = await this.database.tenant(shopId, (tx) =>
          remindPaymentTermsIn(tx, shopId, at),
        );
        if (told > 0) this.logger?.info({ shopId, reminded: told }, 'payment terms reminded');
        reminded += told;
      } catch (error) {
        // One shop's failure is not the others': it is tried again on the next sweep.
        this.logger?.warn({ err: error, shopId }, 'payment terms not reminded');
      }
    }
    return reminded;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'payment terms sweep failed'),
    );
  }
}
