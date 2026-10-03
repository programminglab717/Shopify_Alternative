import { Database } from '@hatti/db';
import type { Logger } from '@hatti/logger';
import { CONFIRMATION_REMINDER, OrderService } from '@hatti/orders/public';
import { sql } from 'drizzle-orm';
import { repeat } from './repeat.js';

/**
 * Asks customers once more to confirm their cash-on-delivery orders (COD-01, ADR-175): for each
 * shop with orders still waiting for their answer three hours after they were placed, in its
 * calling hours. The shops are found with the system role, which sees every shop, through the
 * confirmation queue's index; each order is asked again in its shop's own transaction, and the
 * worker's notifications send it.
 */
export class ConfirmationReminders {
  constructor(
    private readonly database: Database,
    private readonly orders: OrderService,
    private readonly logger?: Logger,
  ) {}

  /** One sweep of every shop with orders to ask again: how many it asked. */
  async sweep(at: Date = new Date()): Promise<number> {
    const { rows: shops } = await this.database.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT DISTINCT shop_id FROM orders.orders
         WHERE stage = 'needs_confirmation' AND confirmation_reminded_at IS NULL
           AND created_at < ${new Date(at.getTime() - CONFIRMATION_REMINDER.afterMs)}
           AND created_at >= ${new Date(at.getTime() - CONFIRMATION_REMINDER.withinMs)}`),
    );
    let reminded = 0;
    for (const shop of shops) {
      try {
        const count = await this.orders.remindToConfirm(shop.shop_id, at);
        if (count > 0) this.logger?.info({ shopId: shop.shop_id, count }, 'asked again to confirm');
        reminded += count;
      } catch (error) {
        // One shop's failure is not the others': it is tried again on the next sweep.
        this.logger?.warn({ err: error, shopId: shop.shop_id }, 'not asked again to confirm');
      }
    }
    return reminded;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'confirmation reminders sweep failed'),
    );
  }
}
