import type { Tx } from '@hatti/db';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { sql } from 'drizzle-orm';
import { orderName } from './rules.js';
import type { OrderStageValue, PaymentMethodValue } from './schema.js';

// What the AI may tell a customer of their own orders (MSG-07, ADR-849): their latest few, each
// as a line of plain facts, where it stands, how it is paid, its parcels and their tracking. The
// customer is who the conversation's number is: on WhatsApp, the number WhatsApp verified; in the
// web chat, a number the shopper typed, so only orders they name by number, placed from it.
// Nothing of their address, nor of anyone else's orders.

export const SUPPORT_FACTS_ORDERS = 5;

const STAGE_WORDS: Record<OrderStageValue, string> = {
  needs_confirmation: 'placed, waiting for the customer to confirm it',
  needs_review: 'placed, being checked by the shop before it is confirmed',
  awaiting_payment: 'placed, waiting for its payment before it ships',
  to_pack: 'confirmed, being packed',
  to_book: 'packed, waiting for the courier to be booked',
  ready_for_pickup: 'ready to collect from the shop',
  partially_fulfilled: 'partly sent',
  in_transit: 'on its way',
  returning: 'coming back to the shop, not delivered',
  delivered: 'delivered',
  returned: 'returned to the shop, not delivered',
  lost: 'lost by the courier: the shop will be in touch',
  completed: 'delivered and settled',
  cancelled: 'cancelled',
};

const PAYMENT_WORDS: Record<PaymentMethodValue, string> = {
  cash_on_delivery: 'cash on delivery',
  prepaid: 'paid before it ships',
  bank_transfer: 'bank transfer',
  online: 'paid online',
};

type OrderFactRow = {
  id: string;
  number: number;
  stage: OrderStageValue;
  payment_method: PaymentMethodValue;
  currency: string;
  total: string;
  amount_paid: string;
  placed_on: string;
  parcels: { company: string | null; number: string | null; url: string | null; status: string }[];
};

/**
 * The customer's orders, as lines of facts for the AI: those placed from `phone`, the latest
 * first, {@link SUPPORT_FACTS_ORDERS} at most; or, where `named` is given, only those of its
 * numbers placed from it.
 */
export async function supportFactsIn(
  tx: Tx,
  shopId: string,
  phone: string,
  named?: readonly number[],
): Promise<string[]> {
  if (named && named.length === 0) return [];
  const { rows } = await tx.execute<OrderFactRow>(sql`
    SELECT o.id, o.number, o.stage, o.payment_method, o.currency, o.total::text AS total,
           o.amount_paid::text AS amount_paid,
           to_char(o.created_at AT TIME ZONE 'Asia/Karachi', 'FMDD Mon YYYY') AS placed_on,
           coalesce((SELECT json_agg(json_build_object(
                              'company', f.tracking_company, 'number', f.tracking_number,
                              'url', f.tracking_url, 'status', f.status) ORDER BY f.created_at)
                       FROM orders.fulfillments f
                      WHERE f.shop_id = o.shop_id AND f.order_id = o.id), '[]') AS parcels
      FROM orders.orders o
     WHERE o.shop_id = ${shopId} AND o.phone = ${phone}
       ${named ? sql`AND o.number = ANY(${sql.param([...named])}::int[])` : sql``}
     ORDER BY o.created_at DESC
     LIMIT ${SUPPORT_FACTS_ORDERS}`);
  return rows.map((row) => {
    const amount = (minor: string) =>
      formatMoney(money(BigInt(minor), row.currency as CurrencyCode));
    const owed = BigInt(row.total) - BigInt(row.amount_paid);
    const parcels = row.parcels.map((parcel) =>
      [
        `a parcel ${parcel.status.replace(/_/g, ' ')}`,
        parcel.company && `with ${parcel.company}`,
        parcel.number && `tracking number ${parcel.number}`,
        parcel.url && `tracked at ${parcel.url}`,
      ]
        .filter(Boolean)
        .join(', '),
    );
    return [
      `Order ${orderName(row.number)}, placed ${row.placed_on}: ${STAGE_WORDS[row.stage]}`,
      `${amount(row.total)}, ${PAYMENT_WORDS[row.payment_method]}` +
        (owed > 0n && row.stage !== 'cancelled' ? `, ${amount(owed.toString())} still to pay` : ''),
      ...parcels,
    ].join('; ');
  });
}
