import type { TenantContext } from '@hatti/api';
import {
  customerOfPhoneIn,
  type CustomerDataHandler,
  type CustomerIdentity,
} from '@hatti/customers/public';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { isUuid } from '@hatti/ids';
import { exponentOf, isCurrencyCode } from '@hatti/money';
import { parsePkMobile } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Orders from the store a shop moved from (ONB-05, ADR-786): a history to look back on, never
// orders of Hatti's. They take no stock, send no messages, book no parcels and count in no report;
// nothing changes them but a customer's merge or erasure. Each names the customer its number is,
// where the shop has one when it is brought; brought twice, an order is kept once.

/** Where past orders come from. */
export type PastOrderSource = 'shopify';

/** An item of a past order, as the store sold it; `price` each, in the order's minor units. */
export interface PastOrderLine {
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  price: bigint;
}

/** Where a past order went, as the store wrote it. */
export interface PastOrderAddress {
  name: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  /** ISO 3166's two letters, as PK. */
  countryCode: string | null;
}

/** A past order as brought; amounts in its currency's minor units. */
export interface PastOrderInput {
  /** Its ID at the store, which keeps it once. */
  sourceId: string;
  /** Its name at the store, as #1001. */
  name: string;
  phone: string | null;
  email: string | null;
  placedAt: Date;
  cancelledAt: Date | null;
  currency: string;
  subtotal: bigint;
  shipping: bigint;
  discounts: bigint;
  total: bigint;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  lines: PastOrderLine[];
  shippingAddress: PastOrderAddress | null;
  note: string;
}

/** A past order as kept. */
export interface PastOrderRecord extends PastOrderInput {
  id: string;
  source: PastOrderSource;
  /** The customer its number was when it was brought, or since a merge; null for none. */
  customerId: string | null;
  customerErasedAt: Date | null;
  createdAt: Date;
}

/** Orders kept in a transaction, and lines and text cut to what is kept. */
const BATCH = 200;
const TEXT_MOST = 255;
const NOTE_MOST = 5_000;
const LINES_MOST = 250;

type PastOrderRow = {
  id: string;
  source: PastOrderSource;
  source_id: string;
  name: string;
  customer_id: string | null;
  phone: string | null;
  email: string | null;
  placed_at: string | Date;
  cancelled_at: string | Date | null;
  currency: string;
  subtotal: string;
  shipping: string;
  discounts: string;
  total: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  lines: {
    title: string;
    variantTitle: string | null;
    sku: string | null;
    quantity: number;
    price: string;
  }[];
  shipping_address: PastOrderAddress | null;
  note: string;
  customer_erased_at: string | Date | null;
  created_at: string | Date;
};

function toRecord(row: PastOrderRow): PastOrderRecord {
  return {
    id: row.id,
    source: row.source,
    sourceId: row.source_id,
    name: row.name,
    customerId: row.customer_id,
    phone: row.phone,
    email: row.email,
    placedAt: toDate(row.placed_at),
    cancelledAt: toDateOrNull(row.cancelled_at),
    currency: row.currency,
    subtotal: BigInt(row.subtotal),
    shipping: BigInt(row.shipping),
    discounts: BigInt(row.discounts),
    total: BigInt(row.total),
    financialStatus: row.financial_status,
    fulfillmentStatus: row.fulfillment_status,
    lines: row.lines.map((line) => ({ ...line, price: BigInt(line.price) })),
    shippingAddress: row.shipping_address,
    note: row.note,
    customerErasedAt: toDateOrNull(row.customer_erased_at),
    createdAt: toDate(row.created_at),
  };
}

/** `minor` units of `currency` as a decimal, as 4500.00: two places for a currency Hatti has not. */
export function majorOf(minor: bigint, currency: string): string {
  const places = isCurrencyCode(currency) ? exponentOf(currency) : 2;
  if (places === 0) return String(minor);
  const sign = minor < 0n ? '-' : '';
  const digits = String(minor < 0n ? -minor : minor).padStart(places + 1, '0');
  return `${sign}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

const cut = (value: string | null, most = TEXT_MOST): string | null =>
  value === null ? null : value.slice(0, most);

/** The shop's past orders: brought from the store it moved from, and read back. */
@Injectable()
export class PastOrderService {
  constructor(private readonly db: Database) {}

  /**
   * Keeps `orders` from `source` as the shop's past orders (ADR-786), each naming the customer its
   * number is now: Pakistani mobile numbers kept in E.164. Those kept already are left as they
   * are. How many were added, and how many of them name a customer.
   */
  async bring(
    tenant: TenantContext,
    source: PastOrderSource,
    orders: readonly PastOrderInput[],
  ): Promise<{ added: number; linked: number }> {
    let added = 0;
    let linked = 0;
    const customers = new Map<string, string | null>();
    for (let at = 0; at < orders.length; at += BATCH) {
      await this.db.tenant(tenant.shopId, async (tx) => {
        for (const order of orders.slice(at, at + BATCH)) {
          const mobile = order.phone ? (parsePkMobile(order.phone)?.e164 ?? null) : null;
          let customerId: string | null = null;
          if (mobile) {
            if (!customers.has(mobile)) {
              customers.set(
                mobile,
                (await customerOfPhoneIn(tx, tenant.shopId, mobile))?.id ?? null,
              );
            }
            customerId = customers.get(mobile) ?? null;
          }
          const lines = order.lines.slice(0, LINES_MOST).map((line) => ({
            title: line.title.slice(0, TEXT_MOST),
            variantTitle: cut(line.variantTitle),
            sku: cut(line.sku),
            quantity: line.quantity,
            price: String(line.price),
          }));
          const { rows } = await tx.execute<{ id: string }>(sql`
            INSERT INTO orders.past_orders
              (shop_id, source, source_id, name, customer_id, phone, email, placed_at,
               cancelled_at, currency, subtotal, shipping, discounts, total, financial_status,
               fulfillment_status, lines, shipping_address, note)
            VALUES (${tenant.shopId}, ${source}, ${order.sourceId.slice(0, TEXT_MOST)},
                    ${order.name.slice(0, TEXT_MOST)}, ${customerId},
                    ${mobile ?? cut(order.phone)}, ${cut(order.email)}, ${order.placedAt},
                    ${order.cancelledAt}, ${order.currency}, ${order.subtotal}, ${order.shipping},
                    ${order.discounts}, ${order.total}, ${cut(order.financialStatus)},
                    ${cut(order.fulfillmentStatus)}, ${JSON.stringify(lines)}::jsonb,
                    ${order.shippingAddress && JSON.stringify(order.shippingAddress)}::jsonb,
                    ${order.note.slice(0, NOTE_MOST)})
            ON CONFLICT (shop_id, source, source_id) DO NOTHING
            RETURNING id`);
          if (rows.length > 0) {
            added++;
            if (customerId) linked++;
          }
        }
      });
    }
    return { added, linked };
  }

  /**
   * A page of the shop's past orders, the latest placed first (ADR-786): with `customerId`, that
   * customer's alone. `after` is the last order of the page before.
   */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: string | null; customerId?: string | null },
  ): Promise<{ items: PastOrderRecord[]; hasNextPage: boolean }> {
    const { first, after = null, customerId = null } = options;
    if ((after !== null && !isUuid(after)) || (customerId !== null && !isUuid(customerId))) {
      return { items: [], hasNextPage: false };
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<PastOrderRow>(sql`
        SELECT * FROM orders.past_orders p
         WHERE p.shop_id = ${tenant.shopId}
           ${customerId === null ? sql`` : sql`AND p.customer_id = ${customerId}`}
           ${
             after === null
               ? sql``
               : sql`AND (p.placed_at, p.id) < (SELECT a.placed_at, a.id FROM orders.past_orders a
                                                 WHERE a.shop_id = ${tenant.shopId}
                                                   AND a.id = ${after})`
           }
         ORDER BY p.placed_at DESC, p.id DESC
         LIMIT ${first + 1}`);
      return { items: rows.slice(0, first).map(toRecord), hasNextPage: rows.length > first };
    });
  }

  /** The shop's past order `id`; null for none. */
  async get(tenant: TenantContext, id: string): Promise<PastOrderRecord | null> {
    if (!isUuid(id)) return null;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<PastOrderRow>(sql`
        SELECT * FROM orders.past_orders WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      return rows[0] ? toRecord(rows[0]) : null;
    });
  }
}

/** The customer's past orders: theirs by ID, or naming one of their numbers or their email. */
function theirs(shopId: string, customer: CustomerIdentity) {
  return sql`shop_id = ${shopId}
    AND (customer_id = ${customer.id}
         OR phone = ANY(${sql.param(customer.phones)}::text[])
         OR (email IS NOT NULL AND lower(email) = lower(${customer.email}::text)))`;
}

/**
 * Past orders' part in merging and erasing customers (ADR-786), as orders' (ADR-102): a merged
 * duplicate's become the customer's; an erased customer's keep their items, amounts, statuses and
 * dates, and the city, province and country they went to, losing the number, email, name, street
 * and note. Their own export gives them whole.
 */
export const PAST_ORDER_CUSTOMER_DATA: CustomerDataHandler = {
  key: 'past_orders',

  async erasureBlockers() {
    return [];
  },

  async merge(tx: Tx, shopId, fromId, intoId) {
    await tx.execute(sql`
      UPDATE orders.past_orders SET customer_id = ${intoId}
       WHERE shop_id = ${shopId} AND customer_id = ${fromId}`);
  },

  async erase(tx: Tx, shopId, customer) {
    await tx.execute(sql`
      UPDATE orders.past_orders
         SET phone = NULL, email = NULL, note = '',
             shipping_address = CASE WHEN shipping_address IS NULL THEN NULL ELSE
               jsonb_build_object(
                 'name', NULL, 'phone', NULL, 'address1', NULL, 'address2', NULL,
                 'city', shipping_address -> 'city', 'province', shipping_address -> 'province',
                 'zip', NULL, 'countryCode', shipping_address -> 'countryCode') END,
             customer_erased_at = now()
       WHERE ${theirs(shopId, customer)}`);
  },

  async export(tx: Tx, shopId, customer) {
    const { rows } = await tx.execute<PastOrderRow>(sql`
      SELECT * FROM orders.past_orders WHERE ${theirs(shopId, customer)}
       ORDER BY placed_at, id`);
    return {
      pastOrders: rows.map(toRecord).map((order) => ({
        name: order.name,
        source: order.source,
        placedAt: order.placedAt.toISOString(),
        cancelledAt: order.cancelledAt?.toISOString() ?? null,
        currency: order.currency,
        subtotal: majorOf(order.subtotal, order.currency),
        shipping: majorOf(order.shipping, order.currency),
        discounts: majorOf(order.discounts, order.currency),
        total: majorOf(order.total, order.currency),
        financialStatus: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        lines: order.lines.map((line) => ({ ...line, price: majorOf(line.price, order.currency) })),
        phone: order.phone,
        email: order.email,
        shippingAddress: order.shippingAddress,
        note: order.note,
      })),
    };
  },
};

/**
 * The customer `customerId`'s latest past orders, at most `most`, in the caller's transaction
 * (ADR-786): for their own account on the storefront, which lists them under their orders.
 */
export async function pastOrdersOfCustomerIn(
  tx: Tx,
  shopId: string,
  customerId: string,
  most: number,
): Promise<PastOrderRecord[]> {
  const { rows } = await tx.execute<PastOrderRow>(sql`
    SELECT * FROM orders.past_orders
     WHERE shop_id = ${shopId} AND customer_id = ${customerId}
     ORDER BY placed_at DESC, id DESC
     LIMIT ${most}`);
  return rows.map(toRecord);
}
