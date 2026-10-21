import type { Tx } from '@hatti/db';
import { sql, type SQL } from 'drizzle-orm';

// Areas riders struggle to find houses in (CHK-02, ADR-717): learned from the shop's own parcels,
// whose couriers said, on a failed delivery or a parcel sent back, that the address was the
// trouble.

/**
 * What couriers in Pakistan say when a rider could not find the house, in English, Roman Urdu
 * and Urdu: "Address incomplete", "Location not found", "Untraceable", "Ghalat pata", "پتہ نہیں ملا".
 * A refusal or a customer not answering is not the address's trouble.
 */
const ADDRESS_TROUBLE = String.raw`address|addr\M|location|untrace|pata\M|پت[ہا]|ایڈریس`;

/** How the shop's parcels to an area are read: over these days, at least so many, so much of them. */
export const HARD_TO_FIND = {
  days: 180,
  /** Parcels whose address was the trouble, at least. */
  least: 2,
  /** Of all the area's parcels in those days, at least. */
  share: 0.25,
} as const;

/** An address's words, read alike however they were typed: lower case, spaces single. */
const normal = (value: SQL) => sql`lower(regexp_replace(btrim(${value}), '\s+', ' ', 'g'))`;

/**
 * Whether riders have lately struggled to find houses in `area` of `city`, in the caller's `tx`:
 * of the shop's parcels to it in the last {@link HARD_TO_FIND} days, at least two, and a quarter,
 * had a step whose courier said the address was the trouble, a delivery tried or the parcel sent
 * back. The area is the address's second line, read alike however it was typed.
 */
export async function hardToFindIn(
  tx: Tx,
  shopId: string,
  place: { city: string; area: string },
): Promise<boolean> {
  if (!place.area.trim() || !place.city.trim()) return false;
  const { rows } = await tx.execute<{ troubled: number; shipped: number }>(sql`
    SELECT count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM orders.fulfillment_events e
              WHERE e.shop_id = f.shop_id AND e.fulfillment_id = f.id
                AND e.status IN ('attempted_delivery', 'returning', 'returned', 'failure')
                AND e.message ~* ${ADDRESS_TROUBLE}))::int AS troubled,
           count(*)::int AS shipped
      FROM orders.fulfillments f
      JOIN orders.orders o ON o.shop_id = f.shop_id AND o.id = f.order_id
     WHERE f.shop_id = ${shopId}
       AND f.shipped_at > now() - make_interval(days => ${HARD_TO_FIND.days})
       AND ${normal(sql`o.shipping_address->>'city'`)} = ${normal(sql`${place.city}::text`)}
       AND ${normal(sql`o.shipping_address->>'address2'`)} = ${normal(sql`${place.area}::text`)}`);
  const { troubled, shipped } = rows[0] ?? { troubled: 0, shipped: 0 };
  return troubled >= HARD_TO_FIND.least && troubled >= shipped * HARD_TO_FIND.share;
}
