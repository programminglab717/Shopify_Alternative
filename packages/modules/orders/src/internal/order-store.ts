import type { Actor } from '@hatti/api';
import { toDate, toDateOrNull, type Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import type { CurrencyCode } from '@hatti/money';
import { searchKey } from '@hatti/pk';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { OrderLineRecord, OrderRecord } from './records.js';
import { FIRST_ORDER_NUMBER, stageOf } from './rules.js';
import { orderEvents, orders, type ActorKind, type AddressValue, type OrderRow } from './schema.js';

interface OrderJsonRow extends Record<string, unknown> {
  id: string;
  number: number;
  source: OrderRecord['source'];
  status: OrderRecord['status'];
  confirmation_status: OrderRecord['confirmationStatus'];
  financial_status: OrderRecord['financialStatus'];
  fulfillment_status: OrderRecord['fulfillmentStatus'];
  stage: OrderRecord['stage'];
  payment_method: OrderRecord['paymentMethod'];
  currency: string;
  // int8 arrives as text, so no amount loses precision.
  subtotal: string;
  discount: string;
  shipping: string;
  total: string;
  amount_paid: string;
  cod_amount: string;
  phone: string;
  email: string | null;
  shipping_address: AddressValue;
  location_id: string;
  note: string;
  tags: string[];
  cancel_reason: OrderRecord['cancelReason'];
  confirmed_at: string | null;
  cancelled_at: string | null;
  paid_at: string | null;
  closed_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  lines: {
    id: string;
    position: number;
    variant_id: string;
    product_id: string;
    title: string;
    variant_title: string;
    sku: string | null;
    quantity: number;
    unit_price: string;
    total: string;
    weight_grams: number | null;
  }[];
}

function toOrderRecord(row: OrderJsonRow): OrderRecord {
  return {
    id: row.id,
    number: row.number,
    source: row.source,
    status: row.status,
    confirmationStatus: row.confirmation_status,
    financialStatus: row.financial_status,
    fulfillmentStatus: row.fulfillment_status,
    stage: row.stage,
    paymentMethod: row.payment_method,
    currency: row.currency as CurrencyCode,
    subtotal: BigInt(row.subtotal),
    discount: BigInt(row.discount),
    shipping: BigInt(row.shipping),
    total: BigInt(row.total),
    amountPaid: BigInt(row.amount_paid),
    codAmount: BigInt(row.cod_amount),
    phone: row.phone,
    email: row.email,
    shippingAddress: row.shipping_address,
    locationId: row.location_id,
    note: row.note,
    tags: row.tags,
    cancelReason: row.cancel_reason,
    confirmedAt: toDateOrNull(row.confirmed_at),
    cancelledAt: toDateOrNull(row.cancelled_at),
    paidAt: toDateOrNull(row.paid_at),
    closedAt: toDateOrNull(row.closed_at),
    version: row.version,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    lines: row.lines.map((line): OrderLineRecord => ({
      id: line.id,
      position: line.position,
      variantId: line.variant_id,
      productId: line.product_id,
      title: line.title,
      variantTitle: line.variant_title,
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: BigInt(line.unit_price),
      total: BigInt(line.total),
      weightGrams: line.weight_grams,
    })),
  };
}

/**
 * Orders with their lines, in one statement whatever the page size. Amounts travel as text inside
 * the JSON, which loses precision on numbers above 2^53.
 */
export async function loadOrders(
  tx: Tx,
  shopId: string,
  options: { where?: SQL; order?: SQL; limit?: number } = {},
): Promise<OrderRecord[]> {
  const { rows } = await tx.execute<OrderJsonRow>(sql`
    SELECT o.id, o.number, o.source, o.status, o.confirmation_status, o.financial_status,
           o.fulfillment_status, o.stage, o.payment_method, o.currency, o.subtotal, o.discount,
           o.shipping, o.total, o.amount_paid, o.cod_amount, o.phone, o.email,
           o.shipping_address, o.location_id, o.note, o.tags, o.cancel_reason, o.confirmed_at,
           o.cancelled_at, o.paid_at, o.closed_at, o.version, o.created_at, o.updated_at,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', l.id, 'position', l.position, 'variant_id', l.variant_id,
                      'product_id', l.product_id, 'title', l.title,
                      'variant_title', l.variant_title, 'sku', l.sku, 'quantity', l.quantity,
                      'unit_price', l.unit_price::text, 'total', l.total::text,
                      'weight_grams', l.weight_grams) ORDER BY l.position)
               FROM orders.lines l
              WHERE l.shop_id = o.shop_id AND l.order_id = o.id), '[]') AS lines
      FROM orders.orders o
     WHERE o.shop_id = ${shopId} AND ${options.where ?? sql`true`}
     ORDER BY ${options.order ?? sql`o.id DESC`}
     ${options.limit === undefined ? sql`` : sql`LIMIT ${options.limit}`}`);
  return rows.map(toOrderRecord);
}

export async function loadOrder(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<OrderRecord | null> {
  const [order] = await loadOrders(tx, shopId, { where: sql`o.id = ${orderId}` });
  return order ?? null;
}

/** Locks an order for a change; state changes of one order happen one at a time. */
export async function lockOrder(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<OrderRow | undefined> {
  const [row] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.shopId, shopId), eq(orders.id, orderId)))
    .for('update');
  return row;
}

/**
 * The shop's next order number. Take it last in the order's transaction: the counter row stays
 * locked until the transaction ends, and numbers taken by failed orders are given back.
 */
export async function nextOrderNumber(tx: Tx, shopId: string): Promise<number> {
  const { rows } = await tx.execute<{ number: number }>(sql`
    INSERT INTO orders.counters (shop_id, next_number)
    VALUES (${shopId}, ${FIRST_ORDER_NUMBER + 1})
        ON CONFLICT (shop_id) DO UPDATE SET next_number = orders.counters.next_number + 1
    RETURNING next_number - 1 AS number`);
  return rows[0]!.number;
}

/** What the order's search matches: the customer's name, city and email. */
export function searchTextOf(address: AddressValue, email: string | null): string {
  return searchKey([address.name, address.city, email ?? ''].join(' '));
}

export function actorColumns(actor: Actor | 'system'): {
  actorKind: ActorKind;
  actorId: string | null;
} {
  if (actor === 'system') return { actorKind: 'system', actorId: null };
  return actor.kind === 'app'
    ? { actorKind: 'app', actorId: actor.tokenId }
    : { actorKind: 'staff', actorId: actor.userId };
}

/** Adds an entry to an order's timeline. */
export async function addTimelineEntry(
  tx: Tx,
  shopId: string,
  orderId: string,
  actor: Actor | 'system',
  kind: string,
  message: string,
): Promise<void> {
  await tx.insert(orderEvents).values({
    shopId,
    id: newId(),
    orderId,
    kind,
    message,
    ...actorColumns(actor),
  });
}

/** Timestamps an update can set to the transaction's time. */
export type OrderStamp = 'confirmedAt' | 'cancelledAt' | 'paidAt' | 'closedAt';

/**
 * Writes `changes` to a locked order, sets the `stamps` to now, recomputes its stage and bumps
 * its version. Returns the order as written.
 */
export async function updateOrder(
  tx: Tx,
  shopId: string,
  current: OrderRow,
  changes: Partial<Omit<OrderRow, 'shopId' | 'id' | 'stage' | 'version' | 'updatedAt'>>,
  stamps: readonly OrderStamp[] = [],
): Promise<OrderRow> {
  const set: PgUpdateSetSource<typeof orders> = {
    ...changes,
    stage: stageOf({ ...current, ...changes }),
    version: sql`${orders.version} + 1`,
    updatedAt: sql`now()`,
  };
  for (const stamp of stamps) set[stamp] = sql`now()`;
  const [updated] = await tx
    .update(orders)
    .set(set)
    .where(and(eq(orders.shopId, shopId), eq(orders.id, current.id)))
    .returning();
  return updated!;
}
