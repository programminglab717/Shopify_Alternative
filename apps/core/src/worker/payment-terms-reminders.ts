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
    const now = at.toISOString();
    const { rows: shops } = await this.database.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT DISTINCT o.shop_id FROM orders.orders o
          LEFT JOIN orders.order_settings s ON s.shop_id = o.shop_id
         WHERE o.payment_due_at IS NOT NULL
           -- As many past the date as the shop chose (ADR-964).
           AND o.terms_reminded < 1 + LEAST(coalesce(s.terms_overdue_reminders,
                                                     ${PAYMENT_TERMS_REMINDERS.overdue}),
                                            ${PAYMENT_TERMS_REMINDERS.overdue})
           -- Due within as many days as the shop reminds before the date (ADR-965), or past it.
           AND o.payment_due_at <= ${now}::timestamptz
                 + make_interval(days => coalesce(s.terms_before_days,
                                                  ${PAYMENT_TERMS_REMINDERS.beforeMs / 86_400_000}))
           AND o.status <> 'cancelled' AND o.amount_paid < o.total`),
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
