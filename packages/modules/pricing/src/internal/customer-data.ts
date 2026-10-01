import { CustomerDataRegistry, type CustomerDataHandler } from '@hatti/customers/public';
import { toDate } from '@hatti/db';
import { toPublicId } from '@hatti/ids';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/**
 * Discount codes' part in merging, erasing and exporting customers: a merged duplicate's uses of
 * codes become the customer's, so that a code they may use once stays used. Erasure leaves them:
 * they hold nothing of the customer's but whose they are. A customer's own export lists them,
 * each with the order it was used on; what it took off is on that order.
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

  async export(tx, shopId, customer) {
    const { rows } = await tx.execute<{
      code: string;
      order_id: string;
      created_at: Date | string;
    }>(sql`
      SELECT c.code, r.order_id, r.created_at
        FROM pricing.discount_redemptions r
        JOIN pricing.discount_codes c ON c.shop_id = r.shop_id AND c.id = r.code_id
       WHERE r.shop_id = ${shopId} AND r.customer_id = ${customer.id}
       ORDER BY r.created_at, r.order_id`);
    return {
      discountCodeUses: rows.map((row) => ({
        code: row.code,
        orderId: toPublicId('order', row.order_id),
        usedAt: toDate(row.created_at),
      })),
    };
  },
};

/** Adds discount codes' uses to merges, erasure and exports when the application starts. */
@Injectable()
export class DiscountCustomerData implements OnModuleInit {
  constructor(private readonly registry: CustomerDataRegistry) {}

  onModuleInit(): void {
    this.registry.register(DISCOUNT_CUSTOMER_DATA);
  }
}
