import {
  CustomerDataRegistry,
  CustomerDataService,
  type CustomerDataHandler,
} from '@hatti/customers/public';
import { Database } from '@hatti/db';
import type { Logger } from '@hatti/logger';
import { MESSAGING_CUSTOMER_DATA } from '@hatti/messaging/public';
import { ORDER_CUSTOMER_DATA } from '@hatti/orders/public';
import { DISCOUNT_CUSTOMER_DATA } from '@hatti/pricing/public';
import { sql } from 'drizzle-orm';
import { repeat } from './repeat.js';

/**
 * Every module's part in erasing a customer, as the API's modules register theirs when it starts.
 * A module that keeps data about customers adds its handler here as well; a test holds the two
 * lists equal.
 */
export function workerCustomerDataHandlers(): CustomerDataHandler[] {
  return [ORDER_CUSTOMER_DATA, DISCOUNT_CUSTOMER_DATA, MESSAGING_CUSTOMER_DATA];
}

/** The customers' data service as the worker needs it, without the API's dependency injection. */
export function workerCustomerData(database: Database): CustomerDataService {
  const registry = new CustomerDataRegistry();
  for (const handler of workerCustomerDataHandlers()) registry.register(handler);
  return new CustomerDataService(database, registry);
}

/**
 * Carries out erasures asked for ahead of time once they are due (CUS-05, ADR-110). The shops with
 * any are found with the system role, which sees every shop; each customer is erased in their
 * shop's own transaction. One with anything still under way, such as an open order, waits for a
 * later sweep.
 */
export class CustomerErasures {
  constructor(
    private readonly database: Database,
    private readonly data: CustomerDataService,
    private readonly logger?: Logger,
  ) {}

  /** One sweep of every shop with erasures due by `at`: how many customers it erased. */
  async sweep(at: Date = new Date()): Promise<number> {
    const { rows: shops } = await this.database.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT DISTINCT shop_id FROM customers.erasure_requests WHERE due_at <= ${at}`),
    );
    let erased = 0;
    for (const shop of shops) {
      try {
        const result = await this.data.eraseDue(shop.shop_id, at);
        this.logger?.info({ shopId: shop.shop_id, ...result }, 'customer erasures due');
        erased += result.erased;
      } catch (error) {
        // One shop's failure is not the others': it is tried again on the next sweep.
        this.logger?.warn(
          { err: error, shopId: shop.shop_id },
          'customer erasures not carried out',
        );
      }
    }
    return erased;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'customer erasures sweep failed'),
    );
  }
}
