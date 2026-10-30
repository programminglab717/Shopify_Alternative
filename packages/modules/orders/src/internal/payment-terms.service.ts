import { InputChecker, fail, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { CustomerService } from '@hatti/customers/public';
import { appendEvent } from '@hatti/events';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OrderEvents, type OrderPaymentTermsRemindedPayload } from './events.js';
import { orderSettingsIn } from './order-settings.service.js';

// What wholesale customers owe on orders on payment terms (CUS-06, ADR-888): each customer's
// orders still owed, what they come to, and what of it is past its due date, the most overdue
// first, for the shop to chase. Its customer is reminded before the date, and once past it
// (ADR-945), unless the shop keeps them out of reminders (ADR-969).

export const TERMS_OWED_LIMITS = { first: 100 } as const;

export const PAYMENT_TERMS_REMINDERS = {
  /**
   * The reminder before the due date: this long before it at most, and halfway there at least;
   * a shop's own, in days, takes its place, or none (ADR-965).
   */
  beforeMs: 3 * 86_400_000,
  /** The most days before the date a shop may have it. */
  mostBeforeDays: 7,
  /** The reminder after it: this long past it, the day's grace for a transfer on its way. */
  afterMs: 86_400_000,
  /**
   * Past it, reminded again this often while owed (ADR-954)... A shop's own, in days, takes its
   * place (ADR-964).
   */
  againMs: 7 * 86_400_000,
  /** ...this many times past it in all, at most; a shop's own may be fewer. */
  overdue: 4,
  /** Orders one sweep of a shop reminds at most, the earliest due first. */
  batch: 200,
} as const;

/**
 * Reminds the customers of the shop's orders on payment terms still owed (ADR-945), in the
 * caller's transaction: once before the due date, {@link PAYMENT_TERMS_REMINDERS.beforeMs} before
 * it and no sooner than halfway from the order to it; and
 * {@link PAYMENT_TERMS_REMINDERS.afterMs} past it, then each
 * {@link PAYMENT_TERMS_REMINDERS.againMs} while still owed, {@link PAYMENT_TERMS_REMINDERS.overdue}
 * times past it in all (ADR-954). One already past its date when first found is reminded first as
 * overdue. An event says which, for the worker to tell the customer. How many it reminded.
 */
export async function remindPaymentTermsIn(tx: Tx, shopId: string, at: Date): Promise<number> {
  const now = at.toISOString();
  const late = new Date(at.getTime() - PAYMENT_TERMS_REMINDERS.afterMs).toISOString();
  // As often, and as many times, as the shop chose (ADR-964), and as long before the date
  // (ADR-965): with none before it, `soon` is now, which no order due later is at or before.
  const settings = await orderSettingsIn(tx, shopId);
  const soon = new Date(at.getTime() + settings.termsBeforeDays * 86_400_000).toISOString();
  const again = new Date(at.getTime() - settings.termsReminderDays * 86_400_000).toISOString();
  // 0 none, 1 the reminder before, 2 on the reminders past the date.
  const most = 1 + Math.min(settings.termsOverdueReminders, PAYMENT_TERMS_REMINDERS.overdue);
  const { rows } = await tx.execute<{
    id: string;
    stage: OrderPaymentTermsRemindedPayload['stage'];
    version: number;
    payment_due_at: Date | string;
    terms_reminded: number;
  }>(sql`
    UPDATE orders.orders o
       SET terms_reminded = CASE WHEN o.terms_reminded >= 2 THEN o.terms_reminded + 1
                                 WHEN o.payment_due_at <= ${late}::timestamptz THEN 2 ELSE 1 END,
           terms_reminded_at = ${now}::timestamptz
     WHERE o.shop_id = ${shopId}
       AND o.id IN (
         SELECT id FROM orders.orders owing
          WHERE shop_id = ${shopId} AND payment_due_at IS NOT NULL AND terms_reminded < ${most}
            AND status <> 'cancelled' AND amount_paid < total
            -- A customer the shop keeps out of reminders (ADR-969).
            AND NOT EXISTS (SELECT 1 FROM orders.terms_reminders_off r
                             WHERE r.shop_id = ${shopId} AND r.customer_id = owing.customer_id)
            AND ((terms_reminded < 2 AND payment_due_at <= ${late}::timestamptz)
              OR (terms_reminded >= 2 AND terms_reminded_at <= ${again}::timestamptz)
              OR (terms_reminded = 0 AND payment_due_at > ${now}::timestamptz
                  AND payment_due_at <= ${soon}::timestamptz
                  AND created_at + (payment_due_at - created_at) / 2 <= ${now}::timestamptz))
          ORDER BY payment_due_at, id
          LIMIT ${PAYMENT_TERMS_REMINDERS.batch}
          FOR UPDATE SKIP LOCKED)
    RETURNING o.id, o.stage, o.version, o.payment_due_at, o.terms_reminded`);
  for (const row of rows) {
    await appendEvent<OrderPaymentTermsRemindedPayload>(tx, shopId, {
      type: OrderEvents.OrderPaymentTermsReminded,
      aggregateType: 'order',
      aggregateId: row.id,
      payload: {
        stage: row.stage,
        version: row.version,
        dueAt: new Date(row.payment_due_at).toISOString(),
        overdue: row.terms_reminded >= 2,
        ...(row.terms_reminded > 2 && { reminder: row.terms_reminded - 1 }),
      },
    });
  }
  return rows.length;
}

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
  /** Whether their orders on terms are reminded to them (ADR-969). */
  reminded: boolean;
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

  /**
   * Whether the customer's orders on payment terms are reminded to them, before the date and
   * past it (ADR-969): a customer the shop knows well may be kept out. Reminders already sent
   * stay sent.
   */
  async setReminded(
    tenant: TenantContext,
    customerId: string,
    reminded: boolean,
  ): Promise<MutationResult<CustomerCredit>> {
    if (!(await this.customers.get(tenant, customerId))) {
      return fail([{ field: ['customerId'], code: 'NOT_FOUND', message: 'Customer not found' }]);
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      if (reminded) {
        await tx.execute(sql`
          DELETE FROM orders.terms_reminders_off
           WHERE shop_id = ${tenant.shopId} AND customer_id = ${customerId}`);
      } else {
        await tx.execute(sql`
          INSERT INTO orders.terms_reminders_off (shop_id, customer_id)
          VALUES (${tenant.shopId}, ${customerId})
          ON CONFLICT (shop_id, customer_id) DO UPDATE SET updated_at = now()`);
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

/**
 * A customer's credit limit, what they owe on terms now and whether they are reminded of it, in
 * the caller's transaction.
 */
export async function creditIn(
  tx: Tx,
  shopId: string,
  customerId: string,
): Promise<CustomerCredit> {
  const { rows } = await tx.execute<{
    limit: string | null;
    owed: string;
    overdue: string;
    reminded: boolean;
  }>(sql`
    SELECT (SELECT credit_limit::text FROM orders.credit_limits
             WHERE shop_id = ${shopId} AND customer_id = ${customerId}) AS limit,
           NOT EXISTS (SELECT 1 FROM orders.terms_reminders_off
                        WHERE shop_id = ${shopId} AND customer_id = ${customerId}) AS reminded,
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
    reminded: row.reminded,
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
