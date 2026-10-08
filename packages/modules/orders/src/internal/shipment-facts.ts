import { DEFAULT_VARIANT_TITLE } from '@hatti/catalog/public';
import { toDate, type Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
import { OVER_LIMIT_MESSAGE } from './plan-orders.js';
import { orderName } from './rules.js';
import type {
  AddressValue,
  ConfirmationStatusValue,
  OrderStageValue,
  OrderStatusValue,
  ParcelStatusValue,
  StoredAddressValue,
} from './schema.js';

/**
 * What a courier booking an order is told of it (SHP-02, ADR-149): who receives it where, what
 * to collect, and what is in the parcel; and why it cannot be booked yet, if it cannot.
 */
export interface OrderShipmentFacts {
  id: string;
  number: number;
  /** "#1043". */
  name: string;
  /** Null once its customer's details were erased. */
  address: AddressValue | null;
  /**
   * Minor units: the cash the courier collects at the door, what the order still owes when paid
   * on delivery; none otherwise.
   */
  codAmount: bigint;
  currency: string;
  /** What is left to ship, line by line. */
  items: { title: string; quantity: number }[];
  /** Of what is left to ship, where every line's variant has a weight; null otherwise. */
  weightGrams: number | null;
  /** Its parcels so far, the latest first. */
  parcels: { id: string; trackingNumber: string | null; status: ParcelStatusValue }[];
  /** Why a courier cannot be booked for it now, as shipping it would say; null when it can. */
  refusal: string | null;
}

type ShipmentRow = {
  id: string;
  number: number;
  status: OrderStatusValue;
  stage: OrderStageValue;
  confirmation_status: ConfirmationStatusValue;
  payment_method: string;
  shipping_address: StoredAddressValue;
  customer_erased_at: string | Date | null;
  over_limit_at: string | Date | null;
  cod_amount: string;
  currency: string;
  items: { title: string; variant_title: string | null; left: number; weight: number | null }[];
  parcels: { id: string; tracking_number: string | null; status: ParcelStatusValue }[];
};

/** The order `orderId` as a courier booking it reads it; null if it is gone. */
export async function orderShipmentFactsIn(
  tx: Tx,
  shopId: string,
  orderId: string,
): Promise<OrderShipmentFacts | null> {
  const { rows } = await tx.execute<ShipmentRow>(sql`
    SELECT o.id, o.number, o.status, o.stage, o.confirmation_status, o.payment_method,
           o.shipping_address, o.customer_erased_at, o.over_limit_at, o.currency,
           CASE WHEN o.status = 'open' AND o.payment_method = 'cash_on_delivery'
                THEN greatest(o.total - o.amount_paid, 0) ELSE 0 END::text AS cod_amount,
           coalesce((
             SELECT json_agg(json_build_object(
                      'title', l.title, 'variant_title', l.variant_title,
                      'left', l.quantity - l.fulfilled_quantity,
                      'weight', l.weight_grams) ORDER BY l.position)
               FROM orders.lines l
              WHERE l.shop_id = o.shop_id AND l.order_id = o.id
                AND l.quantity > l.fulfilled_quantity), '[]') AS items,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', f.id, 'tracking_number', f.tracking_number, 'status', f.status)
                      ORDER BY f.shipped_at DESC, f.id)
               FROM orders.fulfillments f
              WHERE f.shop_id = o.shop_id AND f.order_id = o.id), '[]') AS parcels
      FROM orders.orders o
     WHERE o.shop_id = ${shopId} AND o.id = ${orderId}`);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    name: orderName(row.number),
    address: row.customer_erased_at === null ? (row.shipping_address as AddressValue) : null,
    codAmount: BigInt(row.cod_amount),
    currency: row.currency,
    items: row.items.map((item) => ({
      title: itemTitle(item.title, item.variant_title),
      quantity: item.left,
    })),
    weightGrams: weightOf(row.items, (item) => item.left),
    parcels: row.parcels.map((parcel) => ({
      id: parcel.id,
      trackingNumber: parcel.tracking_number,
      status: parcel.status,
    })),
    refusal: refusalOf(row),
  };
}

/**
 * Why a courier cannot be booked for the order now, in the words shipping it would use. Couriers
 * are booked for whole orders: the cash they collect is what the order owes.
 */
function refusalOf(row: ShipmentRow): string | null {
  if (row.status !== 'open') return `A ${row.status} order can't be shipped`;
  if (row.over_limit_at !== null) return OVER_LIMIT_MESSAGE;
  if (row.customer_erased_at !== null) {
    return "The customer's details on this order were erased at their request";
  }
  if (row.confirmation_status !== 'confirmed' && row.confirmation_status !== 'not_required') {
    return 'Confirm the order with the customer before shipping it';
  }
  if (row.stage === 'awaiting_payment') {
    return row.payment_method === 'bank_transfer'
      ? 'Mark the order paid once its bank transfer is in'
      : row.payment_method === 'online'
        ? 'The order waits for its payment online'
        : 'Record the advance it asks for once it is in';
  }
  if (row.items.length === 0) return 'Everything on this order has shipped';
  if (row.parcels.length > 0) {
    return 'Part of this order has shipped: book the rest with the courier yourself';
  }
  return null;
}

/** A parcel as its courier's label and load sheet tell it (SHP-02, ADR-150). */
export interface ParcelShipmentFacts {
  id: string;
  orderId: string;
  orderNumber: number;
  /** Null once its customer's details were erased. */
  address: AddressValue | null;
  /** The parcel's own items. */
  items: { title: string; quantity: number }[];
  /** Where every item's variant has a weight; null otherwise. */
  weightGrams: number | null;
  /** Where it shipped from. */
  locationId: string;
  trackingCompany: string | null;
  trackingNumber: string | null;
  status: ParcelStatusValue;
  shippedAt: Date;
}

type ParcelRow = {
  id: string;
  order_id: string;
  number: number;
  shipping_address: StoredAddressValue;
  customer_erased_at: string | Date | null;
  location_id: string;
  tracking_company: string | null;
  tracking_number: string | null;
  status: ParcelStatusValue;
  shipped_at: string | Date;
  items: { title: string; variant_title: string | null; quantity: number; weight: number | null }[];
};

/** The parcels `fulfillmentIds` as their labels tell them, by ID; those not found are left out. */
export async function parcelShipmentFactsIn(
  tx: Tx,
  shopId: string,
  fulfillmentIds: readonly string[],
): Promise<Map<string, ParcelShipmentFacts>> {
  const facts = new Map<string, ParcelShipmentFacts>();
  if (fulfillmentIds.length === 0) return facts;
  const { rows } = await tx.execute<ParcelRow>(sql`
    SELECT f.id, f.order_id, o.number, o.shipping_address, o.customer_erased_at, f.location_id,
           f.tracking_company, f.tracking_number, f.status, f.shipped_at,
           coalesce((
             SELECT json_agg(json_build_object(
                      'title', l.title, 'variant_title', l.variant_title,
                      'quantity', fl.quantity, 'weight', l.weight_grams) ORDER BY l.position)
               FROM orders.fulfillment_lines fl
               JOIN orders.lines l ON l.shop_id = fl.shop_id AND l.id = fl.line_id
              WHERE fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id), '[]') AS items
      FROM orders.fulfillments f
      JOIN orders.orders o ON o.shop_id = f.shop_id AND o.id = f.order_id
     WHERE f.shop_id = ${shopId}
       AND f.id = ANY(${sql.param([...new Set(fulfillmentIds)])}::uuid[])`);
  for (const row of rows) {
    facts.set(row.id, {
      id: row.id,
      orderId: row.order_id,
      orderNumber: row.number,
      address: row.customer_erased_at === null ? (row.shipping_address as AddressValue) : null,
      items: row.items.map((item) => ({
        title: itemTitle(item.title, item.variant_title),
        quantity: item.quantity,
      })),
      weightGrams: weightOf(row.items, (item) => item.quantity),
      locationId: row.location_id,
      trackingCompany: row.tracking_company,
      trackingNumber: row.tracking_number,
      status: row.status,
      shippedAt: toDate(row.shipped_at),
    });
  }
  return facts;
}

/** "Kurta - Red", or "Kurta" for a product of one variant. */
function itemTitle(title: string, variantTitle: string | null): string {
  return variantTitle && variantTitle !== DEFAULT_VARIANT_TITLE
    ? `${title} - ${variantTitle}`
    : title;
}

/** What the items weigh, where every one's variant has a weight; null otherwise. */
function weightOf<T extends { weight: number | null }>(
  items: readonly T[],
  quantity: (item: T) => number,
): number | null {
  if (items.length === 0 || items.some((item) => item.weight === null)) return null;
  return items.reduce((sum, item) => sum + item.weight! * quantity(item), 0);
}
