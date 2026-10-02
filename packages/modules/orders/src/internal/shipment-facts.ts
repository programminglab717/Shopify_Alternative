import { DEFAULT_VARIANT_TITLE } from '@hatti/catalog/public';
import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
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
           o.shipping_address, o.customer_erased_at, o.currency,
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
  const weighed = row.items.every((item) => item.weight !== null);
  return {
    id: row.id,
    number: row.number,
    name: orderName(row.number),
    address: row.customer_erased_at === null ? (row.shipping_address as AddressValue) : null,
    codAmount: BigInt(row.cod_amount),
    currency: row.currency,
    items: row.items.map((item) => ({
      title:
        item.variant_title && item.variant_title !== DEFAULT_VARIANT_TITLE
          ? `${item.title} - ${item.variant_title}`
          : item.title,
      quantity: item.left,
    })),
    weightGrams:
      weighed && row.items.length > 0
        ? row.items.reduce((sum, item) => sum + item.weight! * item.left, 0)
        : null,
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
  if (row.customer_erased_at !== null) {
    return "The customer's details on this order were erased at their request";
  }
  if (row.confirmation_status !== 'confirmed' && row.confirmation_status !== 'not_required') {
    return 'Confirm the order with the customer before shipping it';
  }
  if (row.stage === 'awaiting_payment') {
    return row.payment_method === 'bank_transfer'
      ? 'Mark the order paid once its bank transfer is in'
      : 'Record the advance it asks for once it is in';
  }
  if (row.items.length === 0) return 'Everything on this order has shipped';
  if (row.parcels.length > 0) {
    return 'Part of this order has shipped: book the rest with the courier yourself';
  }
  return null;
}
