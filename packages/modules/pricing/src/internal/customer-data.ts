import { CustomerDataRegistry, type CustomerDataHandler } from '@hatti/customers/public';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/**
 * Discount codes' part in merging and erasing customers: a merged duplicate's uses of codes
 * become the customer's, so that a code they may use once stays used. Erasure leaves them: they
 * hold nothing of the customer's but whose they are.
 */
export const DISCOUNT_CUSTOMER_DATA: CustomerDataHandler = {
  key: 'discounts',

  erasureBlockers() {
    return Promise.resolve([]);
  },

  async merge(tx, shopId, fromId, intoId) {
    await tx.execute(sql`
      UPDATE pricing.discount_redemptions SET customer_id = ${intoId}
       WHERE shop_id = ${shopId} AND customer_id = ${fromId}`);
  },

  erase() {
    return Promise.resolve();
  },
};

/** Adds discount codes' uses to merges and erasure when the application starts. */
@Injectable()
export class DiscountCustomerData implements OnModuleInit {
  constructor(private readonly registry: CustomerDataRegistry) {}

  onModuleInit(): void {
    this.registry.register(DISCOUNT_CUSTOMER_DATA);
  }
}
