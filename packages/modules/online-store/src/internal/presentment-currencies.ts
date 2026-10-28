import { InputChecker, actorColumnsOf, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import {
  PRESENTMENT_CURRENCIES,
  PRESENTMENT_ROUNDINGS,
  formatRate,
  isPresentmentCurrency,
  parseRate,
  type PresentmentCurrency,
  type PresentmentRounding,
} from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OnlineStoreEvents } from './events.js';

// Prices in shoppers' own currencies (OS-21, ADR-865): a shop sells and charges in rupees, and
// shows shoppers abroad, Pakistanis in the Gulf, Britain and North America among them, its prices
// in their currency too. It picks the currencies, each at a rate it fixes or the day's, which the
// worker reads from an open currency feed, and how each is rounded. Its storefront document
// carries them with the rate each is shown at; checkout charges rupees, and says so.

/** The currencies a shop shows its prices in, with how. */
export interface PresentmentCurrencyRecord {
  currency: PresentmentCurrency;
  /** Rupees for one unit as the shop fixes it, ten-thousandths; null to follow the day's. */
  fixedRate: bigint | null;
  rounding: PresentmentRounding;
  updatedAt: Date;
}

/** The day's rate of a currency, Hatti's, from the feed. */
export interface CurrencyRateRecord {
  currency: PresentmentCurrency;
  /** Rupees for one unit, ten-thousandths. */
  rate: bigint;
  /** The feed's day, YYYY-MM-DD. */
  rateDate: string;
}

export interface PresentmentCurrencyInput {
  currency: string;
  /** "76.4521", rupees for one unit; blank or null to follow the day's rate. */
  fixedRate?: string | null;
  rounding?: string | null;
}

type CurrencyRow = {
  currency: PresentmentCurrency;
  fixed_rate: string | null;
  rounding: PresentmentRounding;
  updated_at: Date | string;
};

/** A numeric(10, 4) as Postgres gives it, "76.4521", as ten-thousandths. */
const rateOf = (text: string): bigint => parseRate(text) ?? 0n;

const toRecord = (row: CurrencyRow): PresentmentCurrencyRecord => ({
  currency: row.currency,
  fixedRate: row.fixed_rate === null ? null : rateOf(row.fixed_rate),
  rounding: row.rounding,
  updatedAt: toDate(row.updated_at),
});

/** The shop's currencies, in its picker's order, in the caller's transaction `tx`. */
export async function presentmentCurrenciesIn(
  tx: Tx,
  shopId: string,
): Promise<PresentmentCurrencyRecord[]> {
  const { rows } = await tx.execute<CurrencyRow>(sql`
    SELECT currency, fixed_rate::text AS fixed_rate, rounding, updated_at
      FROM online_store.presentment_currencies
     WHERE shop_id = ${shopId}
     ORDER BY position, currency`);
  return rows.map(toRecord);
}

/** The day's rates the worker last read, in the caller's transaction `tx`. */
export async function currencyRatesIn(tx: Tx): Promise<CurrencyRateRecord[]> {
  const { rows } = await tx.execute<{
    currency: PresentmentCurrency;
    rate: string;
    rate_date: string;
  }>(
    sql`SELECT currency, rate::text AS rate, rate_date::text AS rate_date
          FROM platform.currency_rates ORDER BY currency`,
  );
  return rows.map((row) => ({
    currency: row.currency,
    rate: rateOf(row.rate),
    rateDate: row.rate_date,
  }));
}

/**
 * The shop's currencies as its storefront shows them: each at its fixed rate, or the day's; one
 * following the day's rate before the worker has read any is left out.
 */
export async function shownCurrenciesIn(
  tx: Tx,
  shopId: string,
): Promise<{ currency: PresentmentCurrency; rate: string; rounding: PresentmentRounding }[]> {
  const currencies = await presentmentCurrenciesIn(tx, shopId);
  if (currencies.length === 0) return [];
  const rates = new Map((await currencyRatesIn(tx)).map((each) => [each.currency, each.rate]));
  return currencies.flatMap((each) => {
    const rate = each.fixedRate ?? rates.get(each.currency);
    return rate
      ? [{ currency: each.currency, rate: formatRate(rate), rounding: each.rounding }]
      : [];
  });
}

/**
 * The currencies a shop shows its prices in (ADR-865), set by staff who change its settings, all
 * at once in the picker's order. Each change is an event the storefront's publisher hears.
 */
@Injectable()
export class PresentmentCurrencyService {
  constructor(private readonly db: Database) {}

  async list(tenant: TenantContext): Promise<PresentmentCurrencyRecord[]> {
    return this.db.tenant(tenant.shopId, (tx) => presentmentCurrenciesIn(tx, tenant.shopId));
  }

  /** The day's rates, for staff to see what a currency following them is shown at. */
  async rates(tenant: TenantContext): Promise<CurrencyRateRecord[]> {
    return this.db.tenant(tenant.shopId, (tx) => currencyRatesIn(tx));
  }

  /** Sets the shop's currencies, replacing those it had; none to show rupees alone. */
  async set(
    tenant: TenantContext,
    input: readonly PresentmentCurrencyInput[],
  ): Promise<MutationResult<PresentmentCurrencyRecord[]>> {
    const check = new InputChecker();
    const seen = new Set<string>();
    const rows: { currency: PresentmentCurrency; fixedRate: bigint | null; rounding: string }[] =
      [];
    input.forEach((each, index) => {
      const at = ['input', String(index)];
      const currency = each.currency.trim().toUpperCase();
      if (!isPresentmentCurrency(currency)) {
        check.add(
          [...at, 'currency'],
          'INVALID',
          `must be one of ${PRESENTMENT_CURRENCIES.join(', ')}`,
        );
        return;
      }
      if (seen.has(currency)) {
        check.add([...at, 'currency'], 'TAKEN', 'is given twice');
        return;
      }
      seen.add(currency);
      const text = each.fixedRate?.trim() ?? '';
      const fixedRate = text === '' ? null : parseRate(text);
      if (text !== '' && fixedRate === null) {
        check.add(
          [...at, 'fixedRate'],
          'INVALID',
          'must be the rupees for one unit, as 76.4521, up to Rs 100,000',
        );
      }
      const rounding = each.rounding ?? 'exact';
      if (!(PRESENTMENT_ROUNDINGS as readonly string[]).includes(rounding)) {
        check.add([...at, 'rounding'], 'INVALID', 'must be exact, whole or ninety_nine');
      }
      rows.push({ currency, fixedRate, rounding });
    });
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      await tx.execute(sql`
        DELETE FROM online_store.presentment_currencies WHERE shop_id = ${tenant.shopId}`);
      for (const [position, row] of rows.entries()) {
        await tx.execute(sql`
          INSERT INTO online_store.presentment_currencies
                 (shop_id, currency, fixed_rate, rounding, position)
          VALUES (${tenant.shopId}, ${row.currency},
                  ${row.fixedRate === null ? null : formatRate(row.fixedRate)}::numeric,
                  ${row.rounding}, ${position})`);
      }
      await appendEvent(tx, tenant.shopId, {
        type: OnlineStoreEvents.PresentmentCurrenciesUpdated,
        aggregateType: 'shop',
        aggregateId: tenant.shopId,
        payload: {},
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'presentment_currencies.updated',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actorColumnsOf(tenant.actor),
        details: { currencies: rows.map((row) => row.currency) },
      });
      return { ok: true, value: await presentmentCurrenciesIn(tx, tenant.shopId) };
    });
  }
}
