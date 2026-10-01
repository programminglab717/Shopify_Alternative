import type { Actor } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { sql } from 'drizzle-orm';
import { OrderEvents, type OrderPaidPayload, type OrderUpdatedPayload } from './events.js';
import { addTimelineEntry, lockOrder, updateOrder } from './order-store.js';
import type { ParcelStatusValue } from './schema.js';

// Cash on delivery as couriers pay it over (COD-10): their parcels found by the tracking numbers
// on their statements, what the parcels' orders still owe, and the cash received on them, each
// in the caller's transaction, so that a statement is taken whole or not at all.

/** A tracking number as parcels are found by it: without spaces, in capitals. */
export function trackingKey(text: string): string {
  return text.replace(/\s/g, '').toUpperCase();
}

/** A parcel a courier's statement names. */
export interface CourierParcel {
  id: string;
  orderId: string;
  trackingNumber: string;
  trackingCompany: string | null;
  status: ParcelStatusValue;
}

type ParcelRow = {
  id: string;
  order_id: string;
  tracking_number: string;
  tracking_company: string | null;
  status: ParcelStatusValue;
  key: string;
};

/**
 * The shop's parcels with each of the tracking numbers `keys` ({@link trackingKey}), by key:
 * the most recently shipped first, as a number staff typed twice is likelier the newer parcel.
 */
export async function parcelsByTrackingIn(
  tx: Tx,
  shopId: string,
  keys: readonly string[],
): Promise<Map<string, CourierParcel[]>> {
  const found = new Map<string, CourierParcel[]>();
  if (keys.length === 0) return found;
  const { rows } = await tx.execute<ParcelRow>(sql`
    SELECT id, order_id, tracking_number, tracking_company, status,
           upper(regexp_replace(tracking_number, '\\s', '', 'g')) AS key
      FROM orders.fulfillments
     WHERE shop_id = ${shopId}
       AND tracking_number IS NOT NULL
       AND upper(regexp_replace(tracking_number, '\\s', '', 'g')) = ANY(${sql.param([...new Set(keys)])}::text[])
     ORDER BY shipped_at DESC, id`);
  for (const row of rows) {
    const parcel: CourierParcel = {
      id: row.id,
      orderId: row.order_id,
      trackingNumber: row.tracking_number,
      trackingCompany: row.tracking_company,
      status: row.status,
    };
    found.set(row.key, [...(found.get(row.key) ?? []), parcel]);
  }
  return found;
}

/** What an order still owes in cash on delivery. */
export interface OrderCod {
  id: string;
  number: number;
  /** Open, cash on delivery: cash can be received on it. */
  payable: boolean;
  /** `total - amount_paid`, in minor units; 0 when it owes nothing. */
  owed: bigint;
}

type OwedRow = {
  id: string;
  number: number;
  payable: boolean;
  owed: string;
};

/**
 * What the orders `orderIds` still owe, locked in turn, by ID, for the cash about to be received
 * on them: whoever else receives cash on them waits, and then sees it received.
 */
export async function codOwedIn(
  tx: Tx,
  shopId: string,
  orderIds: readonly string[],
  options: { lock: boolean },
): Promise<Map<string, OrderCod>> {
  const owed = new Map<string, OrderCod>();
  if (orderIds.length === 0) return owed;
  const { rows } = await tx.execute<OwedRow>(sql`
    SELECT id, number,
           status = 'open' AND payment_method = 'cash_on_delivery' AS payable,
           greatest(total - amount_paid, 0)::text AS owed
      FROM orders.orders
     WHERE shop_id = ${shopId} AND id = ANY(${sql.param([...new Set(orderIds)])}::uuid[])
     ORDER BY id
       ${options.lock ? sql`FOR UPDATE` : sql``}`);
  for (const row of rows) {
    owed.set(row.id, {
      id: row.id,
      number: row.number,
      payable: row.payable,
      owed: BigInt(row.owed),
    });
  }
  return owed;
}

/**
 * Receives `amount` of cash on delivery on the order `orderId`, at most what it owes, in the
 * caller's transaction: paid in full, or in part until the rest comes. Its timeline says
 * `message`. Returns what was received; nothing on an order that is not open, owes nothing, or
 * is not cash on delivery.
 */
export async function receiveCodIn(
  tx: Tx,
  shopId: string,
  actor: Actor,
  input: { orderId: string; amount: bigint; message: string },
): Promise<bigint> {
  const order = await lockOrder(tx, shopId, input.orderId);
  if (!order || order.status !== 'open' || order.paymentMethod !== 'cash_on_delivery') return 0n;
  const owed = order.total - order.amountPaid;
  const received = input.amount < owed ? input.amount : owed;
  if (received <= 0n) return 0n;
  const amountPaid = order.amountPaid + received;
  const paid = amountPaid >= order.total;
  const updated = await updateOrder(
    tx,
    shopId,
    order,
    {
      amountPaid,
      financialStatus: !paid
        ? 'partially_paid'
        : order.amountRefunded > 0n
          ? 'partially_refunded'
          : 'paid',
    },
    paid ? ['paidAt'] : [],
  );
  await addTimelineEntry(tx, shopId, order.id, actor, 'paid', input.message);
  if (paid) {
    await appendEvent<OrderPaidPayload>(tx, shopId, {
      type: OrderEvents.OrderPaid,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: {
        amountPaid: amountPaid.toString(),
        stage: updated.stage,
        version: updated.version,
      },
    });
  } else {
    await appendEvent<OrderUpdatedPayload>(tx, shopId, {
      type: OrderEvents.OrderUpdated,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: {
        changed: ['amountPaid', 'financialStatus'],
        stage: updated.stage,
        version: updated.version,
      },
    });
  }
  return received;
}
