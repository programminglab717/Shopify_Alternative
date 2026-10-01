import type { Actor } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { sql, type SQL } from 'drizzle-orm';
import { OrderEvents, type FulfillmentUpdatedPayload } from './events.js';
import { addTimelineEntry } from './order-store.js';
import type { OrderStageValue, ParcelClaimStatusValue, ParcelStatusValue } from './schema.js';

// Claims on couriers for the parcels they lost, or that came back with items written off as
// damaged (COD-09, ADR-093, ADR-098): a claim is its parcel's, filed and settled by staff, or, for
// a lost parcel, paid by a courier's statement through the functions below, which take the
// import's transaction.

export const CLAIM_LIMITS = {
  /** The shop's note on a claim: the courier's claim number, or why it was refused. */
  note: 500,
} as const;

/** Claims a courier's statement may pay: those not yet settled, and those it refused. */
export const PAYABLE_CLAIMS: readonly (ParcelClaimStatusValue | null)[] = [null, 'open', 'refused'];

/**
 * What the parcel `f` (an alias of `orders.fulfillments`) is worth, in minor units: the items in it
 * at their prices on the order.
 */
export function parcelWorth(f: SQL): SQL {
  return sql`(SELECT coalesce(sum(fl.quantity * l.unit_price), 0)::bigint
                FROM orders.fulfillment_lines fl
                JOIN orders.lines l ON l.shop_id = fl.shop_id AND l.id = fl.line_id
               WHERE fl.shop_id = ${f}.shop_id AND fl.fulfillment_id = ${f}.id)`;
}

/**
 * What of the parcel `f` (an alias of `orders.fulfillments`) was written off as it came back, in
 * minor units: the items not restocked, at their prices on the order (ADR-098).
 */
export function writtenOffWorth(f: SQL): SQL {
  return sql`(SELECT coalesce(sum((fl.quantity - coalesce(fl.restocked_quantity, 0))
                                  * l.unit_price), 0)::bigint
                FROM orders.fulfillment_lines fl
                JOIN orders.lines l ON l.shop_id = fl.shop_id AND l.id = fl.line_id
               WHERE fl.shop_id = ${f}.shop_id AND fl.fulfillment_id = ${f}.id)`;
}

/**
 * What a claim is for, for the timeline: "the lost parcel 7790", or "the damaged items of the
 * returned parcel 7790".
 */
export function claimedParcel(parcel: {
  status: ParcelStatusValue;
  trackingNumber: string | null;
}): string {
  const number = parcel.trackingNumber ? ` ${parcel.trackingNumber}` : '';
  return parcel.status === 'returned'
    ? `the damaged items of the returned parcel${number}`
    : `the lost parcel${number}`;
}

/** A parcel as a courier's statement finds it once its order is locked. */
export interface ParcelState {
  status: ParcelStatusValue;
  claimStatus: ParcelClaimStatusValue | null;
}

/**
 * The parcels `parcelIds`, by ID, as they are once their orders are locked: lost or not, and their
 * claims, which change only under their orders' locks. A statement reads them after locking the
 * orders, so that what it pays is what they still owe.
 */
export async function parcelStatesIn(
  tx: Tx,
  shopId: string,
  parcelIds: readonly string[],
): Promise<Map<string, ParcelState>> {
  const states = new Map<string, ParcelState>();
  if (parcelIds.length === 0) return states;
  const { rows } = await tx.execute<{
    id: string;
    status: ParcelStatusValue;
    claim_status: ParcelClaimStatusValue | null;
  }>(sql`
    SELECT id, status, claim_status FROM orders.fulfillments
     WHERE shop_id = ${shopId} AND id = ANY(${sql.param([...new Set(parcelIds)])}::uuid[])`);
  for (const row of rows) {
    states.set(row.id, { status: row.status, claimStatus: row.claim_status });
  }
  return states;
}

type PaidRow = {
  id: string;
  order_id: string;
  status: ParcelStatusValue;
  tracking_number: string | null;
  version: number;
  amount: string;
  stage: OrderStageValue;
  order_version: number;
};

/**
 * Pays the claims of lost parcels, by parcel ID, with what a courier's statement paid for them
 * (ADR-093), in the caller's transaction, after their orders are locked: an open claim or one the
 * courier refused is paid, and a parcel the shop had not claimed is claimed at its worth, or what
 * was paid if more, and paid at once. A claim paid otherwise or withdrawn is left as it is. Each
 * parcel's order is changed, and its timeline says `message` of the parcel and what was paid.
 * Returns the parcels whose claims were paid.
 */
export async function payClaimsIn(
  tx: Tx,
  shopId: string,
  actor: Actor,
  input: {
    payments: ReadonlyMap<string, bigint>;
    message: (amount: bigint, trackingNumber: string | null) => string;
  },
): Promise<Set<string>> {
  const payments = [...input.payments].filter(([, amount]) => amount > 0n);
  if (payments.length === 0) return new Set();
  const { rows } = await tx.execute<PaidRow>(sql`
    WITH paid AS (
      UPDATE orders.fulfillments f
         SET claim_status = 'paid',
             claim_amount = coalesce(f.claim_amount, greatest(${parcelWorth(sql`f`)}, p.amount)),
             claim_paid = p.amount,
             claimed_at = coalesce(f.claimed_at, now()),
             claim_settled_at = now(),
             version = f.version + 1, updated_at = now()
        FROM unnest(${sql.param(payments.map(([id]) => id))}::uuid[],
                    ${sql.param(payments.map(([, amount]) => amount.toString()))}::bigint[])
             AS p(id, amount)
       WHERE f.shop_id = ${shopId} AND f.id = p.id AND f.status = 'lost'
         AND (f.claim_status IS NULL OR f.claim_status IN ('open', 'refused'))
      RETURNING f.id, f.order_id, f.status, f.tracking_number, f.version, p.amount::text AS amount
    ), changed AS (
      UPDATE orders.orders o
         SET version = o.version + 1, updated_at = now()
       WHERE o.shop_id = ${shopId} AND o.id IN (SELECT order_id FROM paid)
      RETURNING o.id, o.stage, o.version
    )
    SELECT paid.*, changed.stage, changed.version AS order_version
      FROM paid
      JOIN changed ON changed.id = paid.order_id
     ORDER BY paid.order_id, paid.id`);
  for (const row of rows) {
    await addTimelineEntry(
      tx,
      shopId,
      row.order_id,
      actor,
      'claim_paid',
      input.message(BigInt(row.amount), row.tracking_number),
    );
    await appendEvent<FulfillmentUpdatedPayload>(tx, shopId, {
      type: OrderEvents.FulfillmentUpdated,
      aggregateType: 'fulfillment',
      aggregateId: row.id,
      payload: {
        orderId: row.order_id,
        status: row.status,
        changed: ['claim'],
        version: row.version,
        orderStage: row.stage,
        orderVersion: row.order_version,
      },
    });
  }
  return new Set(rows.map((row) => row.id));
}
