import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
import { awaitsCustomer, transferOwed } from './rules.js';
import type {
  CancelReasonValue,
  ConfirmationStatusValue,
  FulfillmentStatusValue,
  OrderSourceValue,
  OrderStatusValue,
  ParcelStatusValue,
  PaymentMethodValue,
} from './schema.js';

/**
 * What a message about an order tells its customer (MSG-01, ADR-146): the order by its number,
 * its total, whom to write to, and the parcel it is about, by its courier and tracking.
 */
export interface OrderNotificationFacts {
  id: string;
  number: number;
  source: OrderSourceValue;
  currency: string;
  /** Minor units. */
  total: bigint;
  /** Minor units: what was paid of it so far, and the advance it asks for on cash on delivery. */
  amountPaid: bigint;
  advanceDue: bigint;
  /**
   * Minor units: what it waits for before it ships, by transfer or online or its advance
   * (ADR-174); nothing for one waiting for none.
   */
  awaited: bigint;
  /**
   * What the rider collects, in minor units: what a cash-on-delivery order still owes once its
   * advance is in; nothing for one paid otherwise (ADR-160).
   */
  cashDue: bigint;
  customerId: string;
  /** Whether the customer's data was erased (CUS-05): no number is left to write to. */
  erased: boolean;
  /** In E.164: "+923001234567". */
  phone: string | null;
  /** As its address has it. */
  name: string | null;
  cancelReason: CancelReasonValue | null;
  /** Whether it is a cash-on-delivery order waiting for its customer to confirm it. */
  awaitsCustomer: boolean;
  /** The parcel asked about, when one was. */
  parcel: {
    status: ParcelStatusValue;
    company: string | null;
    number: string | null;
    url: string | null;
  } | null;
}

/** The order `orderId`, and its parcel `parcelId`, as a message tells of them; null if gone. */
export async function orderNotificationFactsIn(
  tx: Tx,
  shopId: string,
  orderId: string,
  parcelId?: string | null,
): Promise<OrderNotificationFacts | null> {
  const { rows } = await tx.execute<{
    id: string;
    number: number;
    source: OrderSourceValue;
    currency: string;
    total: string;
    amount_paid: string;
    advance_due: string;
    customer_id: string;
    erased: boolean;
    phone: string | null;
    name: string | null;
    cancel_reason: CancelReasonValue | null;
    status: OrderStatusValue;
    payment_method: PaymentMethodValue;
    confirmation_status: ConfirmationStatusValue;
    fulfillment_status: FulfillmentStatusValue;
    tracking_company: string | null;
    tracking_number: string | null;
    tracking_url: string | null;
    parcel_status: ParcelStatusValue | null;
  }>(sql`
    SELECT o.id, o.number, o.source, o.currency, o.total, o.amount_paid, o.advance_due,
           o.customer_id,
           o.customer_erased_at IS NOT NULL AS erased, o.phone,
           o.shipping_address ->> 'name' AS name, o.cancel_reason, o.status, o.payment_method,
           o.confirmation_status, o.fulfillment_status,
           f.tracking_company, f.tracking_number, f.tracking_url, f.status AS parcel_status
      FROM orders.orders o
      LEFT JOIN orders.fulfillments f
        ON f.shop_id = o.shop_id AND f.order_id = o.id AND f.id = ${parcelId ?? null}::uuid
     WHERE o.shop_id = ${shopId} AND o.id = ${orderId}`);
  const row = rows[0];
  if (!row) return null;
  const owed = {
    paymentMethod: row.payment_method,
    total: BigInt(row.total),
    amountPaid: BigInt(row.amount_paid),
    advanceDue: BigInt(row.advance_due),
  };
  const unpaid = owed.total - owed.amountPaid - transferOwed(owed);
  return {
    id: row.id,
    number: row.number,
    source: row.source,
    currency: row.currency,
    total: BigInt(row.total),
    amountPaid: owed.amountPaid,
    advanceDue: owed.advanceDue,
    awaited: transferOwed(owed),
    cashDue: row.payment_method === 'cash_on_delivery' && unpaid > 0n ? unpaid : 0n,
    customerId: row.customer_id,
    erased: row.erased,
    phone: row.phone,
    name: row.name,
    cancelReason: row.cancel_reason,
    awaitsCustomer: awaitsCustomer({
      status: row.status,
      paymentMethod: row.payment_method,
      confirmationStatus: row.confirmation_status,
      fulfillmentStatus: row.fulfillment_status,
    }),
    parcel: row.parcel_status
      ? {
          status: row.parcel_status,
          company: row.tracking_company,
          number: row.tracking_number,
          url: row.tracking_url,
        }
      : null,
  };
}
