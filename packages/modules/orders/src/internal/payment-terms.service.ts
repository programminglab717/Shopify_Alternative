import { type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// What wholesale customers owe on orders on payment terms (CUS-06, ADR-888): each customer's
// orders still owed, what they come to, and what of it is past its due date, the most overdue
// first, for the shop to chase.

export const TERMS_OWED_LIMITS = { first: 100 } as const;

export interface CustomerOwed {
  customerId: string;
  /** As their latest order owed names them. */
  name: string;
  orders: number;
  /** In minor units: their orders' totals less what was received. */
  owed: bigint;
  overdue: bigint;
  /** The earliest due date of their orders owed. */
  oldestDueAt: Date;
}

export interface TermsOwed {
  owed: bigint;
  overdue: bigint;
  /** The most overdue first, then the most owed. */
  customers: CustomerOwed[];
}

interface OwedRow extends Record<string, unknown> {
  customer_id: string;
  name: string | null;
  orders: number;
  owed: string;
  overdue: string;
  oldest_due_at: Date | string;
}

@Injectable()
export class PaymentTermsService {
  constructor(private readonly db: Database) {}

  /** The customers who owe on payment terms, `first` at most, and what all of them owe. */
  async owed(tenant: TenantContext, input: { first: number }): Promise<TermsOwed> {
    const first = Math.min(Math.max(input.first, 1), TERMS_OWED_LIMITS.first);
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const owedOrders = sql`
        SELECT o.customer_id, o.shipping_address ->> 'name' AS name, o.id, o.payment_due_at,
               o.total - o.amount_paid AS owed
          FROM orders.orders o
         WHERE o.shop_id = ${shopId} AND o.payment_due_at IS NOT NULL
           AND o.status <> 'cancelled' AND o.amount_paid < o.total`;
      const { rows: totals } = await tx.execute<{ owed: string; overdue: string }>(sql`
        SELECT coalesce(sum(owed), 0)::text AS owed,
               coalesce(sum(owed) FILTER (WHERE payment_due_at < now()), 0)::text AS overdue
          FROM (${owedOrders}) t`);
      const { rows } = await tx.execute<OwedRow>(sql`
        SELECT customer_id,
               (array_agg(name ORDER BY payment_due_at DESC, id DESC))[1] AS name,
               count(*)::int AS orders,
               sum(owed)::text AS owed,
               coalesce(sum(owed) FILTER (WHERE payment_due_at < now()), 0)::text AS overdue,
               min(payment_due_at) AS oldest_due_at
          FROM (${owedOrders}) t
         WHERE customer_id IS NOT NULL
         GROUP BY customer_id
         ORDER BY coalesce(sum(owed) FILTER (WHERE payment_due_at < now()), 0) DESC,
                  sum(owed) DESC, customer_id
         LIMIT ${first}`);
      return {
        owed: BigInt(totals[0]?.owed ?? 0),
        overdue: BigInt(totals[0]?.overdue ?? 0),
        customers: rows.map((row) => ({
          customerId: row.customer_id,
          name: row.name ?? '',
          orders: row.orders,
          owed: BigInt(row.owed),
          overdue: BigInt(row.overdue),
          oldestDueAt: new Date(row.oldest_due_at),
        })),
      };
    });
  }
}
