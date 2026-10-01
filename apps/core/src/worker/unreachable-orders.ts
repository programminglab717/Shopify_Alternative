import { VariantService } from '@hatti/catalog/public';
import { BlocklistService, CustomerService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { LocationService, StockService } from '@hatti/inventory/public';
import type { Logger } from '@hatti/logger';
import { OrderService } from '@hatti/orders/public';
import { sql } from 'drizzle-orm';
import { repeat } from './repeat.js';

/** The orders service as the worker needs it, without the API's dependency injection. */
export function workerOrders(database: Database): OrderService {
  return new OrderService(
    database,
    new VariantService(database),
    new LocationService(database),
    new StockService(),
    new CustomerService(database),
    new BlocklistService(database),
  );
}

/**
 * Gives up on customers who can't be reached (COD-05, ADR-092): for each shop that says after how
 * many days, cancels the orders whose customers did not answer three calls, still waiting that
 * long after they were placed, their stock let go. The shops are found with the system role,
 * which sees every shop; each order is cancelled in its shop's own transaction.
 */
export class UnreachableOrders {
  constructor(
    private readonly database: Database,
    private readonly orders: OrderService,
    private readonly logger?: Logger,
  ) {}

  /** One sweep of every shop that gives up: how many orders it cancelled. */
  async sweep(at: Date = new Date()): Promise<number> {
    const { rows: shops } = await this.database.system((tx) =>
      tx.execute<{ shop_id: string; days: number }>(sql`
        SELECT shop_id, cancel_unreachable_after_days AS days
          FROM orders.order_settings
         WHERE cancel_unreachable_after_days IS NOT NULL`),
    );
    let cancelled = 0;
    for (const shop of shops) {
      try {
        const count = await this.orders.cancelUnreachable(shop.shop_id, shop.days, at);
        if (count > 0) {
          this.logger?.info({ shopId: shop.shop_id, count }, 'unreachable orders cancelled');
        }
        cancelled += count;
      } catch (error) {
        // One shop's failure is not the others': it is tried again on the next sweep.
        this.logger?.warn({ err: error, shopId: shop.shop_id }, 'unreachable orders not cancelled');
      }
    }
    return cancelled;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'unreachable orders sweep failed'),
    );
  }
}
