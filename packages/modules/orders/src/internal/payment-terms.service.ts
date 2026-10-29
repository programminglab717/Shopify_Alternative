import { InputChecker, fail, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { CustomerService } from '@hatti/customers/public';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
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

/** A customer's credit on payment terms (ADR-907): their limit, and what they owe now. */
export interface CustomerCredit {
  /** In minor units; null for none. */
  creditLimit: bigint | null;
  owed: bigint;
  overdue: bigint;
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
  constructor(
    private readonly db: Database,
    private readonly customers: CustomerService,
  ) {}

  /** A customer's credit limit and what they owe on terms now (ADR-907). */
  async credit(tenant: TenantContext, customerId: string): Promise<CustomerCredit> {
    return this.db.tenant(tenant.shopId, (tx) => creditIn(tx, tenant.shopId, customerId));
  }

  /**
   * Sets what the customer may owe on payment terms at most, in major units, "200,000"; null or
   * blank for no limit. Orders on terms already placed stay as they are.
   */
  async setCreditLimit(
    tenant: TenantContext,
    customerId: string,
    limit: string | null,
  ): Promise<MutationResult<CustomerCredit>> {
    const check = new InputChecker();
    const minor = check.price(['creditLimit'], limit, tenant.currency);
    if (minor === 0n) check.add(['creditLimit'], 'INVALID', 'must be more than zero');
    if (!check.ok) return fail(check.errors);
    if (!(await this.customers.get(tenant, customerId))) {
      return fail([{ field: ['customerId'], code: 'NOT_FOUND', message: 'Customer not found' }]);
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      if (minor === null) {
        await tx.execute(sql`
          DELETE FROM orders.credit_limits
           WHERE shop_id = ${tenant.shopId} AND customer_id = ${customerId}`);
      } else {
        await tx.execute(sql`
          INSERT INTO orders.credit_limits (shop_id, customer_id, credit_limit)
          VALUES (${tenant.shopId}, ${customerId}, ${minor})
          ON CONFLICT (shop_id, customer_id) DO UPDATE
             SET credit_limit = EXCLUDED.credit_limit, updated_at = now()`);
      }
      return { ok: true, value: await creditIn(tx, tenant.shopId, customerId) };
    });
  }

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

/** A customer's credit limit and what they owe on terms now, in the caller's transaction. */
export async function creditIn(
  tx: Tx,
  shopId: string,
  customerId: string,
): Promise<CustomerCredit> {
  const { rows } = await tx.execute<{ limit: string | null; owed: string; overdue: string }>(sql`
    SELECT (SELECT credit_limit::text FROM orders.credit_limits
             WHERE shop_id = ${shopId} AND customer_id = ${customerId}) AS limit,
           coalesce(sum(o.total - o.amount_paid), 0)::text AS owed,
           coalesce(sum(o.total - o.amount_paid) FILTER (WHERE o.payment_due_at < now()), 0)::text
             AS overdue
      FROM orders.orders o
     WHERE o.shop_id = ${shopId} AND o.customer_id = ${customerId}
       AND o.payment_due_at IS NOT NULL AND o.status <> 'cancelled' AND o.amount_paid < o.total`);
  const row = rows[0]!;
  return {
    creditLimit: row.limit === null ? null : BigInt(row.limit),
    owed: BigInt(row.owed),
    overdue: BigInt(row.overdue),
  };
}

/**
 * Why an order of `total` on payment terms for `customerId` is refused (ADR-907): what they owe
 * on terms would go past their credit limit. Null where it would not, or they have none.
 */
export async function overCreditIn(
  tx: Tx,
  shopId: string,
  customerId: string,
  total: bigint,
  currency: CurrencyCode,
): Promise<string | null> {
  const credit = await creditIn(tx, shopId, customerId);
  if (credit.creditLimit === null || credit.owed + total <= credit.creditLimit) return null;
  const rs = (minor: bigint) => formatMoney(money(minor, currency));
  return (
    `On terms this would take what the customer owes to ${rs(credit.owed + total)}, past their ` +
    `credit limit of ${rs(credit.creditLimit)}`
  );
}
