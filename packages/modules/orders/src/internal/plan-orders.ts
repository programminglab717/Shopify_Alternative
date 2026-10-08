import type { PlanLimit } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
import type { OrderRecord } from './records.js';
import type { ErasedAddressValue, StoredAddressValue } from './schema.js';

// A shop's orders a month on a plan that limits them (BIL-01, ADR-263): Free's 50. An order placed
// while the plan limits them counts toward the month it was placed in, in the shop's time zone,
// until it is cancelled; one past the limit is taken all the same, but staff see its customer
// hidden and cannot confirm, pack, book or ship it until the plan has room for it.

/** How far into its month's orders the shop is warned that the limit is near: 40 of Free's 50. */
export const PLAN_ORDERS_WARNING = 0.8;

/** Why staff cannot work on an order past its plan's limit, in the words its refusals use. */
export const OVER_LIMIT_MESSAGE =
  "This order came in past the orders the shop's plan allows in a month: choose a bigger plan " +
  'to see its customer and work on it';

/** The month an order placed now counts toward, and how many of its orders count already. */
export type PlanMonth = {
  /** Its first day, in the shop's time zone: "2026-10-01". */
  month: string;
  /** Its orders not cancelled, those past the limit among them. */
  counted: number;
};

/**
 * The month an order placed now counts toward, in the caller's transaction, which has taken the
 * shop's order counter: no other order of the shop is counted meanwhile.
 */
export async function planMonthIn(tx: Tx, shopId: string): Promise<PlanMonth> {
  const { rows } = await tx.execute<PlanMonth>(sql`
    WITH m AS (
      SELECT (date_trunc('month', now() AT TIME ZONE s.timezone))::date AS month
        FROM control.shops s
       WHERE s.id = ${shopId})
    SELECT m.month::text AS month,
           (SELECT count(*)::int FROM orders.orders o
             WHERE o.shop_id = ${shopId} AND o.plan_month = m.month
               AND o.status <> 'cancelled') AS counted
      FROM m`);
  return rows[0]!;
}

/** What an order placed with `counted` before it in its month says of its plan's limit. */
export function planOrderOf(
  limit: PlanLimit,
  counted: number,
): { overLimit: boolean; warn: boolean } {
  const placed = counted + 1;
  return {
    overLimit: counted >= limit.limit,
    warn: placed === Math.ceil(limit.limit * PLAN_ORDERS_WARNING) || placed === limit.limit,
  };
}

/** An address with all but its city and province left out, as erasure leaves one. */
export function hiddenAddressOf(address: StoredAddressValue): ErasedAddressValue {
  return {
    name: null,
    phone: null,
    address1: null,
    address2: null,
    landmark: null,
    city: address.city,
    provinceCode: address.provinceCode,
    zip: null,
    location: null,
  };
}

/** The order as staff see it: one past its plan's limit with its customer's details left out. */
export function shownToStaff(order: OrderRecord): OrderRecord {
  if (order.overLimitAt === null) return order;
  return {
    ...order,
    phone: null,
    email: null,
    shippingAddress: hiddenAddressOf(order.shippingAddress),
  };
}
