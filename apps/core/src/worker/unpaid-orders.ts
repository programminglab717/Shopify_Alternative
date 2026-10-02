import { Database } from '@hatti/db';
import type { Logger } from '@hatti/logger';
import { OrderService, UNPAID_LIMITS } from '@hatti/orders/public';
import { paymentsUnderwayIn } from '@hatti/payments/public';
import { sql } from 'drizzle-orm';
import { repeat } from './repeat.js';

/**
 * Cancels orders never paid (ADR-168): for each shop that says after how many days, the orders
 * still waiting for their payment by transfer or online, or their advance, that long after they
 * were placed, their stock let go; but not one with a receipt waiting to be checked, nor one with
 * a payment started online in the last day, which its gateway may still take. The shops are found
 * with the system role, which sees every shop; each order is cancelled in its shop's own
 * transaction.
 */
export class UnpaidOrders {
  constructor(
    private readonly database: Database,
    private readonly orders: OrderService,
    private readonly logger?: Logger,
  ) {}

  /** One sweep of every shop that cancels them: how many orders it cancelled. */
  async sweep(at: Date = new Date()): Promise<number> {
    const { rows: shops } = await this.database.system((tx) =>
      tx.execute<{ shop_id: string; days: number }>(sql`
        SELECT shop_id, cancel_unpaid_after_days AS days
          FROM orders.order_settings
         WHERE cancel_unpaid_after_days IS NOT NULL`),
    );
    const since = new Date(at.getTime() - UNPAID_LIMITS.paymentUnderwayMs);
    let cancelled = 0;
    for (const shop of shops) {
      try {
        const count = await this.orders.cancelUnpaid(shop.shop_id, shop.days, at, (orderIds) =>
          this.database.tenant(shop.shop_id, (tx) =>
            paymentsUnderwayIn(tx, shop.shop_id, orderIds, since),
          ),
        );
        if (count > 0)
          this.logger?.info({ shopId: shop.shop_id, count }, 'unpaid orders cancelled');
        cancelled += count;
      } catch (error) {
        // One shop's failure is not the others': it is tried again on the next sweep.
        this.logger?.warn({ err: error, shopId: shop.shop_id }, 'unpaid orders not cancelled');
      }
    }
    return cancelled;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'unpaid orders sweep failed'),
    );
  }
}
