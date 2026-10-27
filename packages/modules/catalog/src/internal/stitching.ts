import { InputChecker, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Stitching offered with a product (CAT-09, ADR-802): unstitched eastern wear, the way Pakistani
// shops sell most of it, sold stitched to the shopper's measurements for what the shop charges,
// shipping the days the tailor takes later. A cart line stitched says so as its "Stitching"
// property, each measurement a property of its own in inches, which the order's line keeps
// (ADR-687) and its packing slip prints for the tailor.

/** Events of a product's stitching. Payloads are thin. */
export const StitchingEvents = {
  /** A product's stitching was offered, changed or taken away. */
  Updated: 'product_stitching.updated',
} as const;

/** The property a cart line says it is stitched in, and what it says. */
export const STITCHING_PROPERTY = 'Stitching';
export const STITCHED = 'Stitched';

/**
 * The measurements a page may ask for, in the order tailors take them, each with the property its
 * answer goes in: always in inches, as Pakistani tailors measure.
 */
export const MEASUREMENTS = {
  shirt_length: 'Shirt length',
  chest: 'Chest',
  waist: 'Waist',
  hips: 'Hips',
  shoulder: 'Shoulder',
  sleeve_length: 'Sleeve length',
  armhole: 'Armhole',
  neck: 'Neck',
  wrist: 'Wrist',
  trouser_length: 'Trouser length',
  trouser_waist: 'Trouser waist',
  trouser_bottom: 'Trouser bottom',
} as const;

export type MeasurementKey = keyof typeof MEASUREMENTS;
export const MEASUREMENT_KEYS = Object.keys(MEASUREMENTS) as MeasurementKey[];

/** The property a measurement's answer goes in: "Chest (inches)". */
export function measurementProperty(key: MeasurementKey): string {
  return `${MEASUREMENTS[key]} (inches)`;
}

/** The days stitching may add, and the measurements a page asks for at least. */
export const STITCHING_LIMITS = {
  leadDays: { min: 1, max: 60 },
  /** A measurement's inches: from 1 to 99, to a quarter. */
  inches: { min: 1, max: 99 },
} as const;

/** Stitching as a product offers it. */
export interface StitchingOffer {
  /** What it adds to each unit's price, in minor units. */
  price: number;
  leadDays: number;
  measurements: MeasurementKey[];
}

/** Stitching as the shop gives it. */
export interface StitchingInput {
  /** What it adds to each unit's price, in major units, as "1500". */
  price: string;
  leadDays: number;
  measurements: readonly string[];
}

/** What is wrong with a line's answers for a product's stitching; null when nothing is. */
export type StitchingProblem =
  | { problem: 'not_offered'; field: string }
  | { problem: 'missing'; field: string }
  | { problem: 'not_a_measurement'; field: string };

/**
 * Each of `productIds`' stitching, in the caller's transaction `tx`; a product that offers none has
 * none in the map.
 */
export async function stitchingIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Map<string, StitchingOffer>> {
  if (productIds.length === 0) return new Map();
  const { rows } = await tx.execute<{
    product_id: string;
    price: string;
    lead_days: number;
    measurements: string[];
  }>(sql`
    SELECT product_id, price::text AS price, lead_days, measurements
      FROM catalog.product_stitching
     WHERE shop_id = ${shopId} AND product_id = ANY(${sql.param([...productIds])}::uuid[])`);
  return new Map(
    rows.map((row) => [
      row.product_id,
      {
        price: Number(row.price),
        leadDays: row.lead_days,
        // A key Hatti no longer has is left out.
        measurements: row.measurements.filter((key): key is MeasurementKey => key in MEASUREMENTS),
      },
    ]),
  );
}

/** Whether a line's properties say it is stitched. */
export function isStitched(properties: Readonly<Record<string, string>>): boolean {
  return (properties[STITCHING_PROPERTY] ?? '').trim() === STITCHED;
}

/** What stitching adds to each unit of a line with `properties`, in minor units. */
export function stitchingPrice(
  offer: StitchingOffer | undefined,
  properties: Readonly<Record<string, string>>,
): bigint {
  return offer && isStitched(properties) ? BigInt(offer.price) : 0n;
}

/** A measurement as written, "38" or "38.5": inches from 1 to 99, to a quarter. */
export function isMeasurement(value: string): boolean {
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(value.trim())) return false;
  const inches = Number(value);
  const { min, max } = STITCHING_LIMITS.inches;
  return inches >= min && inches <= max && Number.isInteger(inches * 4);
}

/**
 * What is wrong with a line's `properties` for its product's stitching: stitched where the product
 * offers none, or stitched with a measurement missing or not inches. A line not stitched asks
 * nothing, whatever measurements it has.
 */
export function stitchingProblem(
  offer: StitchingOffer | undefined,
  properties: Readonly<Record<string, string>>,
): StitchingProblem | null {
  if (!isStitched(properties)) return null;
  if (!offer) return { problem: 'not_offered', field: STITCHING_PROPERTY };
  for (const key of offer.measurements) {
    const field = measurementProperty(key);
    const answer = properties[field];
    if (answer === undefined || answer.trim() === '') return { problem: 'missing', field };
    if (!isMeasurement(answer)) return { problem: 'not_a_measurement', field };
  }
  return null;
}

/** Stitching a shop offers with its products (CAT-09, ADR-802). */
@Injectable()
export class StitchingService {
  constructor(private readonly db: Database) {}

  /** Each of `productIds`' stitching. */
  async of(
    tenant: TenantContext,
    productIds: readonly string[],
  ): Promise<Map<string, StitchingOffer>> {
    return this.db.tenant(tenant.shopId, (tx) => stitchingIn(tx, tenant.shopId, productIds));
  }

  /**
   * Offers stitching with a product, in place of what it offered; null, and it offers none. What
   * it offers now, null for none.
   */
  async set(
    tenant: TenantContext,
    productId: string,
    input: StitchingInput | null,
  ): Promise<MutationResult<StitchingOffer | null>> {
    const check = new InputChecker();
    let offer: StitchingOffer | null = null;
    if (input) {
      const price = check.price(['input', 'price'], input.price, tenant.currency, {
        required: true,
      });
      const leadDays = check.integer(['input', 'leadDays'], input.leadDays, {
        min: STITCHING_LIMITS.leadDays.min,
        max: STITCHING_LIMITS.leadDays.max,
      });
      const measurements: MeasurementKey[] = [];
      input.measurements.forEach((key, index) => {
        const field = ['input', 'measurements', String(index)];
        if (!(key in MEASUREMENTS)) {
          check.addMessage(
            field,
            'INVALID',
            `${key.slice(0, 40)} is not a measurement Hatti asks for`,
          );
        } else if (measurements.includes(key as MeasurementKey)) {
          check.addMessage(
            field,
            'TAKEN',
            `${MEASUREMENTS[key as MeasurementKey]} is asked for already`,
          );
        } else {
          measurements.push(key as MeasurementKey);
        }
      });
      if (input.measurements.length === 0) {
        check.addMessage(['input', 'measurements'], 'BLANK', 'Ask for one measurement at least');
      }
      if (!check.ok) return { ok: false, errors: check.errors };
      // In the order tailors take them, whatever order they came in.
      measurements.sort((a, b) => MEASUREMENT_KEYS.indexOf(a) - MEASUREMENT_KEYS.indexOf(b));
      offer = { price: Number(price!), leadDays: leadDays!, measurements };
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const shopId = tenant.shopId;
      const { rows: product } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM catalog.products WHERE shop_id = ${shopId} AND id = ${productId}
           FOR UPDATE`);
      if (!product[0]) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      const before = (await stitchingIn(tx, shopId, [productId])).get(productId) ?? null;
      if (JSON.stringify(before) === JSON.stringify(offer)) return { ok: true, value: before };
      if (offer) {
        await tx.execute(sql`
          INSERT INTO catalog.product_stitching
                 (shop_id, product_id, price, lead_days, measurements)
          VALUES (${shopId}, ${productId}, ${offer.price}, ${offer.leadDays},
                  ${sql.param(offer.measurements)}::text[])
          ON CONFLICT (shop_id, product_id) DO UPDATE
            SET price = EXCLUDED.price, lead_days = EXCLUDED.lead_days,
                measurements = EXCLUDED.measurements, updated_at = now()`);
      } else {
        await tx.execute(sql`
          DELETE FROM catalog.product_stitching
           WHERE shop_id = ${shopId} AND product_id = ${productId}`);
      }
      await appendEvent(tx, shopId, {
        type: StitchingEvents.Updated,
        aggregateType: 'product',
        aggregateId: productId,
        payload: { offered: offer !== null },
      });
      return { ok: true, value: offer };
    });
  }
}
