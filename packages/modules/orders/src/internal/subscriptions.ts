import {
  shopProfile,
  actorColumnsOf,
  failOne,
  type Actor,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import {
  SELLING_PLAN_PROPERTY,
  VariantService,
  planPrice,
  sellingPlansForIn,
  sellingPlansIn,
  type SellingPlanInterval,
} from '@hatti/catalog/public';
import { Database, toDate, type Tx } from '@hatti/db';
import { recordAudit } from '@hatti/events';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import type { CurrencyCode } from '@hatti/money';
import { addDays, pkDayOf } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OrderService } from './order.service.js';
import { addTimelineEntry, loadOrder } from './order-store.js';
import type { OrderRecord } from './records.js';
import type { AddressValue, OrderSourceValue, StoredAddressValue } from './schema.js';

// Subscriptions (CAT-16, ADR-862): an order whose lines were subscribed on a selling plan is
// placed again each interval, the same items to the same address, at the plan's price off the
// items' prices then, by cash on delivery (or bank transfer, where the first was so paid), with
// what the first order charged for delivery. Each order is a new one, confirmed with the customer
// as any other; its lines say which subscription placed it, in a hidden property. The customer
// skips the next order, pauses, resumes or cancels from any of its orders' pages; staff from the
// admin. A due order that can't be placed (an item sold out, say) is tried on each of the next
// days, then skipped after three.

/** The hidden property the lines of an order a subscription placed name it in. */
export const SUBSCRIPTION_PROPERTY = '_subscription';

export const SUBSCRIPTION_LIMITS = {
  /** Days a due order is tried before it is skipped. */
  tries: 3,
  /** Subscriptions a sweep places orders for. */
  batch: 50,
} as const;

export type SubscriptionStatus = 'active' | 'paused' | 'cancelled';
export type SubscriptionChange = 'skip' | 'pause' | 'resume' | 'cancel';

export interface SubscriptionLine {
  variantId: string;
  quantity: number;
  properties: Record<string, string>;
}

export interface SubscriptionRecord {
  id: string;
  customerId: string;
  originOrderId: string;
  planName: string;
  intervalUnit: SellingPlanInterval;
  intervalCount: number;
  discountPercent: number;
  lines: SubscriptionLine[];
  shippingAddress: StoredAddressValue;
  paymentMethod: 'cash_on_delivery' | 'bank_transfer';
  status: SubscriptionStatus;
  /** The day its next order is placed, YYYY-MM-DD in Pakistan's time. */
  nextOrderOn: string;
  ordersPlaced: number;
  /** The orders it takes before its customer may cancel it themselves; 0 for none (ADR-928). */
  minimumOrders: number;
  lastOrderId: string | null;
  lastError: string | null;
  createdAt: Date;
  cancelledAt: Date | null;
}

type SubscriptionRow = {
  id: string;
  customer_id: string;
  origin_order_id: string;
  plan_name: string;
  interval_unit: SellingPlanInterval;
  interval_count: number;
  discount_percent: number;
  lines: SubscriptionLine[];
  shipping_address: StoredAddressValue;
  email: string | null;
  payment_method: 'cash_on_delivery' | 'bank_transfer';
  source: OrderSourceValue;
  shipping: string;
  cod_fee: string;
  status: SubscriptionStatus;
  next_order_on: string;
  orders_placed: number;
  minimum_orders: number;
  last_order_id: string | null;
  last_error: string | null;
  failed_tries: number;
  created_at: Date | string;
  cancelled_at: Date | string | null;
};

const COLUMNS = sql.raw(
  'id, customer_id, origin_order_id, plan_name, interval_unit, interval_count, ' +
    'discount_percent, lines, shipping_address, email, payment_method, source, ' +
    'shipping::text AS shipping, cod_fee::text AS cod_fee, status, ' +
    "to_char(next_order_on, 'YYYY-MM-DD') AS next_order_on, orders_placed, minimum_orders, " +
    'last_order_id, ' +
    'last_error, failed_tries, created_at, cancelled_at',
);

const toRecord = (row: SubscriptionRow): SubscriptionRecord => ({
  id: row.id,
  customerId: row.customer_id,
  originOrderId: row.origin_order_id,
  planName: row.plan_name,
  intervalUnit: row.interval_unit,
  intervalCount: row.interval_count,
  discountPercent: row.discount_percent,
  lines: row.lines,
  shippingAddress: row.shipping_address,
  paymentMethod: row.payment_method,
  status: row.status,
  nextOrderOn: row.next_order_on,
  ordersPlaced: row.orders_placed,
  minimumOrders: row.minimum_orders,
  lastOrderId: row.last_order_id,
  lastError: row.last_error,
  createdAt: toDate(row.created_at),
  cancelledAt: row.cancelled_at === null ? null : toDate(row.cancelled_at),
});

/**
 * The day an interval after `day` (YYYY-MM-DD): a week or a month at a time, a month from the
 * 31st being its last day.
 */
export function nextOrderDay(day: string, unit: SellingPlanInterval, count: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  if (unit === 'week') return addDays(day, 7 * count);
  const last = new Date(Date.UTC(year, month - 1 + count + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + count, Math.min(date, last)))
    .toISOString()
    .slice(0, 10);
}

/** "Every month", as a plan's interval is said: "Every 2 weeks". */
export function intervalText(unit: SellingPlanInterval, count: number): string {
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

/** "28 November 2026". */
export function dayText(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The subscription an order belongs to, in the caller's `tx`: made with it, or placed by it. */
export async function subscriptionOfOrderIn(
  tx: Tx,
  shopId: string,
  order: Pick<OrderRecord, 'id' | 'lines'>,
): Promise<SubscriptionRecord | null> {
  const named = order.lines
    .map((line) => line.properties[SUBSCRIPTION_PROPERTY])
    .find((value) => value !== undefined);
  const placedBy = named ? tryFromPublicId(named, 'orderSubscription') : null;
  const { rows } = await tx.execute<SubscriptionRow>(sql`
    SELECT ${COLUMNS} FROM orders.subscriptions
     WHERE shop_id = ${shopId}
       AND ${placedBy ? sql`id = ${placedBy}` : sql`origin_order_id = ${order.id}`}
     ORDER BY created_at LIMIT 1`);
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * The customer's subscriptions not cancelled, in the caller's `tx`, the newest first, at most
 * `limit`: what their own account lists (ADR-916).
 */
export async function subscriptionsOfCustomerIn(
  tx: Tx,
  shopId: string,
  customerId: string,
  limit: number,
): Promise<SubscriptionRecord[]> {
  const { rows } = await tx.execute<SubscriptionRow>(sql`
    SELECT ${COLUMNS} FROM orders.subscriptions
     WHERE shop_id = ${shopId} AND customer_id = ${customerId} AND status <> 'cancelled'
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit}`);
  return rows.map(toRecord);
}

/**
 * Skips its next order, pauses, resumes or cancels a subscription, in the caller's `tx`, by
 * `actor` or its customer through an order's page: the order its timeline tells of. Resumed, its
 * next order is placed on the day it was due, or tomorrow if that day passed. Null when done; why
 * not, otherwise.
 */
export async function changeSubscriptionIn(
  tx: Tx,
  shopId: string,
  id: string,
  change: SubscriptionChange,
  by: {
    actor: Actor | 'system';
    orderId: string | null;
    who: string;
    why?: string;
    /** The customer, from their order's page: held to the plan's minimum orders (ADR-928). */
    customer?: boolean;
  },
  at: Date = new Date(),
): Promise<'not_found' | 'cancelled' | 'committed' | null> {
  const { rows } = await tx.execute<SubscriptionRow>(sql`
    SELECT ${COLUMNS} FROM orders.subscriptions
     WHERE shop_id = ${shopId} AND id = ${id} FOR UPDATE`);
  const current = rows[0];
  if (!current) return 'not_found';
  if (current.status === 'cancelled') return 'cancelled';
  // The customer cancels once they took the orders the plan asked for; staff, whenever they must.
  if (change === 'cancel' && by.customer && current.orders_placed < current.minimum_orders) {
    return 'committed';
  }
  const today = pkDayOf(at);
  let message: string;
  switch (change) {
    case 'skip': {
      const next = nextOrderDay(
        current.next_order_on,
        current.interval_unit,
        current.interval_count,
      );
      await tx.execute(sql`
        UPDATE orders.subscriptions
           SET next_order_on = ${next}, failed_tries = 0, last_error = NULL, updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id}`);
      message = `${by.who} skipped the subscription's order of ${dayText(current.next_order_on)}: the next is placed on ${dayText(next)}`;
      break;
    }
    case 'pause':
      await tx.execute(sql`
        UPDATE orders.subscriptions SET status = 'paused', updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id}`);
      message = `${by.who} paused the subscription`;
      break;
    case 'resume': {
      // On the day it was due, or tomorrow where that day passed.
      const due = current.next_order_on > today ? current.next_order_on : addDays(today, 1);
      await tx.execute(sql`
        UPDATE orders.subscriptions
           SET status = 'active', next_order_on = ${due}, failed_tries = 0, updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id}`);
      message = `${by.who} resumed the subscription: its next order is placed on ${dayText(due)}`;
      break;
    }
    case 'cancel':
      await tx.execute(sql`
        UPDATE orders.subscriptions SET status = 'cancelled', cancelled_at = now(), updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id}`);
      message = `${by.who} cancelled the subscription`;
      break;
  }
  const orderId = by.orderId ?? current.last_order_id ?? current.origin_order_id;
  await addTimelineEntry(
    tx,
    shopId,
    orderId,
    by.actor,
    'subscription',
    by.why ? `${message}, ${by.why}` : message,
  );
  return null;
}

/**
 * Customers' subscriptions (ADR-862): made from the orders subscribed with, as the worker hears
 * of them; listed and changed by staff who write orders; and each due one's order placed by the
 * worker's sweep.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly db: Database,
    private readonly orders: OrderService,
    private readonly variants: VariantService,
  ) {}

  /** The shop's subscriptions, the latest first, of `status` where given. */
  async list(
    tenant: TenantContext,
    options: { status?: SubscriptionStatus | null; first?: number } = {},
  ): Promise<SubscriptionRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<SubscriptionRow>(sql`
        SELECT ${COLUMNS} FROM orders.subscriptions
         WHERE shop_id = ${tenant.shopId}
           ${options.status ? sql`AND status = ${options.status}` : sql``}
         ORDER BY created_at DESC, id DESC
         LIMIT ${Math.min(Math.max(options.first ?? 50, 1), 100)}`),
    );
    return rows.map(toRecord);
  }

  async get(tenant: TenantContext, id: string): Promise<SubscriptionRecord | null> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<SubscriptionRow>(sql`
        SELECT ${COLUMNS} FROM orders.subscriptions WHERE shop_id = ${tenant.shopId} AND id = ${id}`),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Skips, pauses, resumes or cancels a subscription for staff. */
  async change(
    tenant: TenantContext,
    id: string,
    change: SubscriptionChange,
  ): Promise<MutationResult<SubscriptionRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const why = await changeSubscriptionIn(tx, tenant.shopId, id, change, {
        actor: tenant.actor,
        orderId: null,
        who: 'Staff',
      });
      if (why === 'not_found') {
        return failOne<SubscriptionRecord>(
          ['id'],
          'NOT_FOUND',
          'No subscription of the shop has this ID',
        );
      }
      if (why === 'cancelled') {
        return failOne<SubscriptionRecord>(['id'], 'INVALID', 'The subscription was cancelled');
      }
      await recordAudit(tx, tenant.shopId, {
        action: `subscription.${change}`,
        subjectType: 'orderSubscription',
        subjectId: id,
        ...actorColumnsOf(tenant.actor),
        details: {},
      });
      const { rows } = await tx.execute<SubscriptionRow>(sql`
        SELECT ${COLUMNS} FROM orders.subscriptions WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      return { ok: true, value: toRecord(rows[0]!) };
    });
  }

  /**
   * Makes the subscriptions of an order whose lines were subscribed on the shop's selling plans,
   * one for each plan, once however often it is heard: its next order an interval after it was
   * placed. Lines on a plan the shop no longer has are bought once. How many it made.
   */
  async createFromOrder(shopId: string, orderId: string): Promise<number> {
    return this.db.tenant(shopId, async (tx) => {
      const order = await loadOrder(tx, shopId, orderId);
      if (!order || order.customerErasedAt || order.status === 'cancelled') return 0;
      if (order.lines.some((line) => line.properties[SUBSCRIPTION_PROPERTY] !== undefined)) {
        return 0;
      }
      const plans = await sellingPlansIn(tx, shopId);
      // A line is subscribed on a plan its product is sold on, as its cart priced it.
      const offered = await sellingPlansForIn(
        tx,
        shopId,
        order.lines.map((line) => line.productId),
      );
      const byPlan = new Map<string, SubscriptionLine[]>();
      for (const line of order.lines) {
        const named = line.properties[SELLING_PLAN_PROPERTY];
        const planId = named ? tryFromPublicId(named, 'sellingPlan') : null;
        if (!planId || !offered.get(line.productId)?.some((plan) => plan.id === planId)) continue;
        const { [SELLING_PLAN_PROPERTY]: _plan, ...properties } = line.properties;
        byPlan.set(planId, [
          ...(byPlan.get(planId) ?? []),
          { variantId: line.variantId, quantity: line.quantity, properties },
        ]);
      }
      let made = 0;
      const placedOn = pkDayOf(order.createdAt);
      for (const [planId, lines] of byPlan) {
        const plan = plans.find((each) => each.id === planId)!;
        // The first of its subscriptions charges for delivery as the order did; the others ride
        // with it, or come alone and free.
        const next = nextOrderDay(placedOn, plan.intervalUnit, plan.intervalCount);
        const payment =
          order.paymentMethod === 'bank_transfer' ? 'bank_transfer' : 'cash_on_delivery';
        const { rows } = await tx.execute<{ id: string }>(sql`
          INSERT INTO orders.subscriptions
                 (shop_id, customer_id, origin_order_id, plan_id, plan_name, interval_unit,
                  interval_count, discount_percent, lines, shipping_address, email,
                  payment_method, source, shipping, cod_fee, next_order_on, last_order_id,
                  minimum_orders)
          VALUES (${shopId}, ${order.customerId}, ${order.id}, ${plan.id}, ${plan.name},
                  ${plan.intervalUnit}, ${plan.intervalCount}, ${plan.discountPercent},
                  ${JSON.stringify(lines)}::jsonb, ${JSON.stringify(order.shippingAddress)}::jsonb,
                  ${order.email}, ${payment}, ${order.source},
                  ${made === 0 ? order.shipping : 0n},
                  ${payment === 'cash_on_delivery' && made === 0 ? order.codFee : 0n},
                  ${next}, ${order.id}, ${plan.minimumOrders})
          ON CONFLICT (shop_id, origin_order_id, plan_id) DO NOTHING
          RETURNING id`);
        if (!rows[0]) continue;
        made += 1;
        await addTimelineEntry(
          tx,
          shopId,
          order.id,
          'system',
          'subscription',
          `Subscribed: ${plan.name}, ${plan.discountPercent}% off. The next order is placed on ${dayText(next)}`,
        );
      }
      return made;
    });
  }

  /**
   * Places the orders of the subscriptions due at `at`, across shops, up to
   * {@link SUBSCRIPTION_LIMITS.batch}: each in a transaction of its own, the subscription locked.
   * One that can't be placed is tried on each of the next days, and skipped after three.
   */
  async placeDue(at: Date = new Date()): Promise<{ placed: number; failed: number }> {
    const today = pkDayOf(at);
    const { rows: due } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string; id: string }>(sql`
        SELECT shop_id, id FROM orders.subscriptions
         WHERE status = 'active' AND next_order_on <= ${today}
         ORDER BY next_order_on, id
         LIMIT ${SUBSCRIPTION_LIMITS.batch}`),
    );
    const done = { placed: 0, failed: 0 };
    for (const { shop_id: shopId, id } of due) {
      try {
        const outcome = await this.db.tenant(shopId, (tx) => this.#placeIn(tx, shopId, id, today));
        if (outcome === 'placed') done.placed += 1;
        else if (outcome === 'failed') done.failed += 1;
      } catch (error) {
        // Tried again at the next sweep; the others go on.
        done.failed += 1;
        this.errors.push(error);
      }
    }
    return done;
  }

  /** What went wrong unexpectedly in sweeps, for the worker to log; it empties it. */
  readonly errors: unknown[] = [];

  /**
   * Cancels the subscriptions made with an order its customer or staff cancelled before any other
   * of its orders was placed: they didn't want the first, so not the rest. How many.
   */
  async cancelWithOrder(shopId: string, orderId: string): Promise<number> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM orders.subscriptions
         WHERE shop_id = ${shopId} AND origin_order_id = ${orderId} AND orders_placed = 1
           AND status <> 'cancelled'`);
      for (const { id } of rows) {
        await changeSubscriptionIn(tx, shopId, id, 'cancel', {
          actor: 'system',
          orderId,
          who: 'Hatti',
          why: 'as its first order was cancelled',
        });
      }
      return rows.length;
    });
  }

  async #placeIn(
    tx: Tx,
    shopId: string,
    id: string,
    today: string,
  ): Promise<'placed' | 'failed' | 'none'> {
    const { rows } = await tx.execute<SubscriptionRow>(sql`
      SELECT ${COLUMNS} FROM orders.subscriptions
       WHERE shop_id = ${shopId} AND id = ${id} AND status = 'active' AND next_order_on <= ${today}
         FOR UPDATE SKIP LOCKED`);
    const subscription = rows[0];
    if (!subscription) return 'none';
    const address = subscription.shipping_address;
    if (address.phone === null) return 'none';
    const snapshots = await this.variants.snapshotsOf(
      tx,
      shopId,
      subscription.lines.map((line) => line.variantId),
    );
    const shop = await shopProfile(tx, shopId);
    const reference = toPublicId('orderSubscription', subscription.id);
    const placed = await this.orders.placeIn(
      tx,
      {
        shopId,
        currency: shop.currency as CurrencyCode,
        actor: 'system',
        source: subscription.source,
        how: `by the subscription “${subscription.plan_name}”`,
      },
      {
        field: [],
        lines: subscription.lines.map((line) => {
          const snapshot = snapshots.get(line.variantId);
          return {
            variantId: line.variantId,
            quantity: line.quantity,
            price: snapshot ? planPrice(snapshot.price, subscription.discount_percent) : null,
            properties: { ...line.properties, [SUBSCRIPTION_PROPERTY]: reference },
          };
        }),
        address: address as AddressValue,
        email: subscription.email,
        paymentMethod: subscription.payment_method,
        shipping: BigInt(subscription.shipping),
        ...(subscription.payment_method === 'cash_on_delivery' && {
          codFee: BigInt(subscription.cod_fee),
        }),
        discount: 0n,
        advance: 0n,
        locationId: null,
        deliveryMethod: 'shipping',
        note: '',
        giftMessage: null,
        tags: ['subscription'],
      },
    );
    const next = nextOrderDay(
      subscription.next_order_on,
      subscription.interval_unit,
      subscription.interval_count,
    );
    if (placed.ok) {
      await tx.execute(sql`
        UPDATE orders.subscriptions
           SET next_order_on = ${next}, orders_placed = orders_placed + 1,
               last_order_id = ${placed.value.id}, last_error = NULL, failed_tries = 0,
               updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id}`);
      return 'placed';
    }
    // Nothing of the order was written: its errors say why, and it is tried again tomorrow.
    const error = placed.errors[0]?.message ?? 'The order could not be placed';
    const tries = subscription.failed_tries + 1;
    const skip = tries >= SUBSCRIPTION_LIMITS.tries;
    await tx.execute(sql`
      UPDATE orders.subscriptions
         SET last_error = ${error.slice(0, 300)}, failed_tries = ${skip ? 0 : tries},
             next_order_on = ${skip ? next : addDays(today, 1)},
             updated_at = now()
       WHERE shop_id = ${shopId} AND id = ${id}`);
    return 'failed';
  }
}
