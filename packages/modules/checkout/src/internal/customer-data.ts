import { CustomerDataRegistry, type CustomerDataHandler } from '@hatti/customers/public';
import { toDate } from '@hatti/db';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/**
 * Checkout's part in erasing and exporting customers (ADR-199): the browsers that proved their
 * numbers lately, kept by number. An erased customer's proofs go; a customer's own file says when
 * each of their numbers was proved, and until when it spares them a code. Nothing is merged:
 * proofs are kept by number, not by customer. Codes sent in a checkout go with it, within hours.
 */
export const CHECKOUT_CUSTOMER_DATA: CustomerDataHandler = {
  key: 'checkout',

  async erasureBlockers() {
    return [];
  },

  async merge() {},

  async erase(tx, shopId, customer) {
    await tx.execute(sql`
      DELETE FROM checkout.number_proofs
       WHERE shop_id = ${shopId} AND phone = ANY(${sql.param(customer.phones)}::text[])`);
  },

  async export(tx, shopId, customer) {
    const { rows } = await tx.execute<{
      phone: string;
      proved_at: string | Date;
      expires_at: string | Date;
    }>(sql`
      SELECT phone, proved_at, expires_at FROM checkout.number_proofs
       WHERE shop_id = ${shopId} AND phone = ANY(${sql.param(customer.phones)}::text[])
       ORDER BY proved_at, id`);
    return {
      numberProofs: rows.map((row) => ({
        number: row.phone,
        provedAt: toDate(row.proved_at),
        sparesCodesUntil: toDate(row.expires_at),
      })),
    };
  },
};

/** Adds checkout to merges, erasure and exports when the application starts. */
@Injectable()
export class CheckoutCustomerData implements OnModuleInit {
  constructor(private readonly registry: CustomerDataRegistry) {}

  onModuleInit(): void {
    this.registry.register(CHECKOUT_CUSTOMER_DATA);
  }
}
