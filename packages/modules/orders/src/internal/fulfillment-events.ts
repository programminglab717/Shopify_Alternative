import type { Tx } from '@hatti/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FulfillmentEventRecord } from './records.js';
import { fulfillmentEvents, type FulfillmentEventStatusValue } from './schema.js';

// The steps of parcels' ways to their customers (SHP-05, ADR-160), as Shopify's FulfillmentEvent
// keeps them: what couriers say, through the worker, and what staff and apps are told by couriers
// Hatti does not follow.

/**
 * The steps staff and apps record: the way in between. A parcel's delivery and its coming back
 * change it, and are fulfillmentMarkDelivered's and fulfillmentMarkReturning's.
 */
export const RECORDED_EVENT_STATUSES: readonly FulfillmentEventStatusValue[] = [
  'in_transit',
  'out_for_delivery',
  'attempted_delivery',
];

/** Each step, as the order's timeline says it. */
export const EVENT_WORDS: Readonly<Record<FulfillmentEventStatusValue, string>> = {
  confirmed: 'booked with its courier',
  in_transit: 'on its way',
  out_for_delivery: 'out for delivery',
  attempted_delivery: 'delivery tried',
  delivered: 'delivered',
  returning: 'coming back',
  returned: 'back with the shop',
  failure: 'not delivered: the courier stopped',
};

type EventRow = typeof fulfillmentEvents.$inferSelect;

export function toFulfillmentEvent(row: EventRow): FulfillmentEventRecord {
  return {
    id: row.id,
    fulfillmentId: row.fulfillmentId,
    status: row.status,
    message: row.message,
    happenedAt: row.happenedAt,
    createdAt: row.createdAt,
  };
}

/** The steps of the parcels `fulfillmentIds`, each parcel's in the order they happened. */
export async function fulfillmentEventsIn(
  tx: Tx,
  shopId: string,
  fulfillmentIds: readonly string[],
): Promise<Map<string, FulfillmentEventRecord[]>> {
  const steps = new Map<string, FulfillmentEventRecord[]>(fulfillmentIds.map((id) => [id, []]));
  if (fulfillmentIds.length === 0) return steps;
  const rows = await tx
    .select()
    .from(fulfillmentEvents)
    .where(
      and(
        eq(fulfillmentEvents.shopId, shopId),
        inArray(fulfillmentEvents.fulfillmentId, [...fulfillmentIds]),
      ),
    )
    .orderBy(asc(fulfillmentEvents.happenedAt), asc(fulfillmentEvents.id));
  for (const row of rows) steps.get(row.fulfillmentId)?.push(toFulfillmentEvent(row));
  return steps;
}
