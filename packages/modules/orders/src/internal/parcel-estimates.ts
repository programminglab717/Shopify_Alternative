import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';

/**
 * What a parcel is likely to cost its shop with its courier (SHP-07, ADR-383), by the courier
 * account's rate card when the courier booked it, in minor units: out, the courier's share of the
 * cash it collects, and back, should it come back.
 */
export interface ParcelChargeEstimate {
  out: bigint;
  codFee: bigint;
  back: bigint;
}

/**
 * Keeps `estimate` on the parcel `fulfillmentId`, in the caller's transaction, for the logistics
 * module as the courier books it. Nothing staff or the customer did: no timeline entry or event.
 */
export async function estimateParcelChargesIn(
  tx: Tx,
  shopId: string,
  fulfillmentId: string,
  estimate: ParcelChargeEstimate,
): Promise<void> {
  await tx.execute(sql`
    UPDATE orders.fulfillments
       SET charge_estimate_out = ${estimate.out.toString()}::bigint,
           charge_estimate_cod_fee = ${estimate.codFee.toString()}::bigint,
           charge_estimate_back = ${estimate.back.toString()}::bigint
     WHERE shop_id = ${shopId} AND id = ${fulfillmentId}`);
}

/**
 * What the parcel `f` is likely to cost by its estimate as it stands (ADR-383): out, and the
 * courier's share of the cash while it is on its way or delivered; out and back once it is coming
 * back; out once lost. Null without an estimate.
 */
export const ESTIMATED_CHARGE = sql`
  CASE WHEN f.charge_estimate_out IS NULL THEN NULL
       WHEN f.status IN ('returning', 'returned') THEN f.charge_estimate_out + f.charge_estimate_back
       WHEN f.status = 'lost' THEN f.charge_estimate_out
       ELSE f.charge_estimate_out + f.charge_estimate_cod_fee END`;
