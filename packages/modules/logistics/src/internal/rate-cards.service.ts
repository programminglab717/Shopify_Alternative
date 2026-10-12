import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { estimateParcelChargesIn, type ParcelChargeEstimate } from '@hatti/orders/public';
import { findCity } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { LogisticsEvents, type CourierRateCardPayload } from './events.js';

/** A half kilo: couriers price parcels by the half kilo, a part of one counting whole. */
const SLAB_GRAMS = 500;

/** The most a card's share of the cash collected may be, and of the charge for a return. */
export const RATE_CARD_LIMITS = { codFeePercent: 20, returnPercent: 200 } as const;

/**
 * What a courier account charges (SHP-07, ADR-383): by weight, its first half kilo and each half
 * kilo after, within the city the shop ships from and to other cities; a share of the cash it
 * collects; and a share of the charge again for a parcel it brings back. Minor units, and
 * hundredths of a percent.
 */
export interface RateCardRecord {
  accountId: string;
  /** As Pakistan's list names it. */
  originCity: string;
  localFirst: bigint;
  localEach: bigint;
  otherFirst: bigint;
  otherEach: bigint;
  codFeeBp: number;
  returnBp: number;
  updatedAt: Date;
}

export interface RateCardInput {
  originCity: string;
  /** Decimals, in major units. */
  localFirst: string;
  localEach: string;
  otherFirst: string;
  otherEach: string;
  /** Percent, to two places: "2.5" for 2.5%. */
  codFeePercent?: string | null;
  returnPercent?: string | null;
}

type CardRow = {
  account_id: string;
  origin_city: string;
  local_first: string;
  local_each: string;
  other_first: string;
  other_each: string;
  cod_fee_bp: number;
  return_bp: number;
  updated_at: string | Date;
};

/** A share in hundredths of a percent of `amount`, to the nearest minor unit. */
function share(amount: bigint, bp: number): bigint {
  return (amount * BigInt(bp) + 5_000n) / 10_000n;
}

/**
 * What a parcel to `city` weighing `weightGrams` with `codAmount` to collect is likely to cost by
 * `card` (ADR-383): the first half kilo and each half kilo after, within the card's city or
 * beyond it, a parcel of no known weight counting one half kilo; the card's share of the cash; and
 * its share of the charge again to bring it back.
 */
export function chargeEstimate(
  card: Pick<
    RateCardRecord,
    'originCity' | 'localFirst' | 'localEach' | 'otherFirst' | 'otherEach' | 'codFeeBp' | 'returnBp'
  >,
  parcel: { city: string | null; codAmount: bigint; weightGrams: number | null },
): ParcelChargeEstimate {
  const name = parcel.city ? (findCity(parcel.city)?.name ?? null) : null;
  const local = name !== null && name === card.originCity;
  const slabs = Math.max(1, Math.ceil((parcel.weightGrams ?? 0) / SLAB_GRAMS));
  const out =
    (local ? card.localFirst : card.otherFirst) +
    BigInt(slabs - 1) * (local ? card.localEach : card.otherEach);
  return {
    out,
    codFee: share(parcel.codAmount, card.codFeeBp),
    back: share(out, card.returnBp),
  };
}

/** A card's row in the caller's transaction, or null. */
export async function rateCardIn(
  tx: Tx,
  shopId: string,
  accountId: string,
): Promise<RateCardRecord | null> {
  const { rows } = await tx.execute<CardRow>(sql`
    SELECT account_id, origin_city, local_first::text AS local_first,
           local_each::text AS local_each, other_first::text AS other_first,
           other_each::text AS other_each, cod_fee_bp, return_bp, updated_at
      FROM logistics.rate_cards
     WHERE shop_id = ${shopId} AND account_id = ${accountId}`);
  return rows[0] ? cardOf(rows[0]) : null;
}

function cardOf(row: CardRow): RateCardRecord {
  return {
    accountId: row.account_id,
    originCity: row.origin_city,
    localFirst: BigInt(row.local_first),
    localEach: BigInt(row.local_each),
    otherFirst: BigInt(row.other_first),
    otherEach: BigInt(row.other_each),
    codFeeBp: row.cod_fee_bp,
    returnBp: row.return_bp,
    updatedAt: toDate(row.updated_at),
  };
}

/** A percent to two places, in hundredths of a percent, or null after adding what is wrong. */
function percentIn(
  check: InputChecker,
  field: string[],
  value: string | null | undefined,
  most: number,
): number {
  const text = value?.trim() ?? '';
  if (text === '') return 0;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text) || Number(text) > most) {
    check.addMessage(field, 'INVALID', `must be a percent from 0 to ${most}, like 2.5`);
    return 0;
  }
  return Math.round(Number(text) * 100);
}

/**
 * Courier accounts' rate cards (SHP-07, ADR-383): one for an account, set whole, taken away; and
 * what a booked parcel is likely to cost by its account's card, kept on the booking and on the
 * parcel as the courier books it, for profit until the courier's statement says what it charged.
 */
@Injectable()
export class RateCardService {
  constructor(private readonly db: Database) {}

  list(tenant: TenantContext): Promise<RateCardRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<CardRow>(sql`
        SELECT account_id, origin_city, local_first::text AS local_first,
               local_each::text AS local_each, other_first::text AS other_first,
               other_each::text AS other_each, cod_fee_bp, return_bp, updated_at
          FROM logistics.rate_cards
         WHERE shop_id = ${tenant.shopId}
         ORDER BY account_id`);
      return rows.map(cardOf);
    });
  }

  /** Sets the account's card whole; the account must be the shop's and not archived. */
  async set(
    tenant: TenantContext,
    accountId: string,
    input: RateCardInput,
  ): Promise<MutationResult<RateCardRecord>> {
    const { shopId, currency } = tenant;
    const check = new InputChecker();
    const city = findCity(input.originCity);
    if (!city) {
      check.addMessage(
        ['input', 'originCity'],
        'INVALID',
        `"${input.originCity.trim()}" is not a city of Pakistan we know`,
      );
    }
    const amount = (key: 'localFirst' | 'localEach' | 'otherFirst' | 'otherEach') =>
      check.price(['input', key], input[key], currency, { required: true }) ?? 0n;
    const localFirst = amount('localFirst');
    const localEach = amount('localEach');
    const otherFirst = amount('otherFirst');
    const otherEach = amount('otherEach');
    const codFeeBp = percentIn(
      check,
      ['input', 'codFeePercent'],
      input.codFeePercent,
      RATE_CARD_LIMITS.codFeePercent,
    );
    const returnBp = percentIn(
      check,
      ['input', 'returnPercent'],
      input.returnPercent,
      RATE_CARD_LIMITS.returnPercent,
    );
    if (!check.ok || !city) return fail(check.errors);
    return this.db.tenant(shopId, async (tx) => {
      const refused = await this.#accountRefusal(tx, shopId, accountId);
      if (refused) return refused;
      await tx.execute(sql`
        INSERT INTO logistics.rate_cards
               (shop_id, account_id, origin_city, local_first, local_each, other_first,
                other_each, cod_fee_bp, return_bp)
        VALUES (${shopId}, ${accountId}, ${city.name}, ${localFirst.toString()}::bigint,
                ${localEach.toString()}::bigint, ${otherFirst.toString()}::bigint,
                ${otherEach.toString()}::bigint, ${codFeeBp}, ${returnBp})
            ON CONFLICT (shop_id, account_id) DO UPDATE
           SET origin_city = EXCLUDED.origin_city, local_first = EXCLUDED.local_first,
               local_each = EXCLUDED.local_each, other_first = EXCLUDED.other_first,
               other_each = EXCLUDED.other_each, cod_fee_bp = EXCLUDED.cod_fee_bp,
               return_bp = EXCLUDED.return_bp, updated_at = now()`);
      await appendEvent<CourierRateCardPayload>(tx, shopId, {
        type: LogisticsEvents.CourierRateCardUpdated,
        aggregateType: 'courier_rate_card',
        aggregateId: accountId,
        payload: { accountId, removed: false },
      });
      return { ok: true, value: (await rateCardIn(tx, shopId, accountId))! };
    });
  }

  /** Takes the account's card away; parcels booked by it keep their estimates. */
  async remove(tenant: TenantContext, accountId: string): Promise<MutationResult<boolean>> {
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ account_id: string }>(sql`
        DELETE FROM logistics.rate_cards
         WHERE shop_id = ${shopId} AND account_id = ${accountId}
        RETURNING account_id`);
      if (rows.length === 0) {
        return failOne(['accountId'], 'NOT_FOUND', 'The courier account has no rate card');
      }
      await appendEvent<CourierRateCardPayload>(tx, shopId, {
        type: LogisticsEvents.CourierRateCardUpdated,
        aggregateType: 'courier_rate_card',
        aggregateId: accountId,
        payload: { accountId, removed: true },
      });
      return { ok: true, value: true };
    });
  }

  /**
   * Keeps what the booking's parcel is likely to cost by its account's card, as the courier
   * booked it (ADR-383); nothing where the account has no card.
   */
  async estimateBooking(
    shopId: string,
    bookingId: string,
    parcel: { city: string | null; codAmount: bigint; weightGrams: number | null },
  ): Promise<ParcelChargeEstimate | null> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ account_id: string }>(sql`
        SELECT account_id FROM logistics.bookings WHERE shop_id = ${shopId} AND id = ${bookingId}`);
      const card = rows[0] && (await rateCardIn(tx, shopId, rows[0].account_id));
      if (!card) return null;
      const estimate = chargeEstimate(card, parcel);
      await tx.execute(sql`
        UPDATE logistics.bookings
           SET estimate_out = ${estimate.out.toString()}::bigint,
               estimate_cod_fee = ${estimate.codFee.toString()}::bigint,
               estimate_back = ${estimate.back.toString()}::bigint
         WHERE shop_id = ${shopId} AND id = ${bookingId}`);
      return estimate;
    });
  }

  async #accountRefusal(
    tx: Tx,
    shopId: string,
    accountId: string,
  ): Promise<MutationResult<never> | null> {
    const { rows } = await tx.execute<{ archived: boolean }>(sql`
      SELECT archived_at IS NOT NULL AS archived FROM logistics.courier_accounts
       WHERE shop_id = ${shopId} AND id = ${accountId}`);
    if (!rows[0]) return failOne(['accountId'], 'NOT_FOUND', 'Courier account not found');
    if (rows[0].archived) {
      return failOne(['accountId'], 'INVALID', 'The courier account is archived');
    }
    return null;
  }
}

/**
 * The booking's estimate carried to its parcel `fulfillmentId` (ADR-383), in the caller's
 * transaction, as the booking is marked booked; nothing where it has none.
 */
export async function carryEstimateIn(
  tx: Tx,
  shopId: string,
  bookingId: string,
  fulfillmentId: string,
): Promise<void> {
  const { rows } = await tx.execute<{ out: string | null; cod_fee: string; back: string }>(sql`
    SELECT estimate_out::text AS out, estimate_cod_fee::text AS cod_fee,
           estimate_back::text AS back
      FROM logistics.bookings WHERE shop_id = ${shopId} AND id = ${bookingId}`);
  const row = rows[0];
  if (!row || row.out === null) return;
  await estimateParcelChargesIn(tx, shopId, fulfillmentId, {
    out: BigInt(row.out),
    codFee: BigInt(row.cod_fee),
    back: BigInt(row.back),
  });
}
