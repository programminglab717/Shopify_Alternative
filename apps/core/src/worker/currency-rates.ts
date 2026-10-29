import type { ExpansionStoreService } from '@hatti/catalog/public';
import type { Database } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import type { Logger } from '@hatti/logger';
import {
  PRESENTMENT_CURRENCIES,
  formatRate,
  parseRate,
  rateFromUnitsPerRupee,
  type PresentmentCurrency,
} from '@hatti/money';
import { OnlineStoreEvents } from '@hatti/online-store/public';
import { sql } from 'drizzle-orm';
import { dayRateBetween, rupeeRatesIn } from '../expansion-rates.js';
import { repeat } from './repeat.js';

/** How far a day's rate may move from the last before it is taken for the feed's mistake. */
const MOST_MOVED = 0.25;

/**
 * The day's rates of the currencies shops show their prices in (OS-21, ADR-865), read from an
 * open currency feed: units of each for one rupee, as Fawaz Ahmed's exchange API gives them. Each
 * rate is kept as rupees for one unit; a rate that moved more than a quarter since the last is
 * left as it was and logged, as a feed's mistake would be. Each shop showing a currency whose rate
 * changed and that it doesn't fix is written again, its pages showing the new rate. Expansion
 * stores following the day's rate between their shops' currencies take the new one (ADR-929).
 */
export class CurrencyRates {
  constructor(
    private readonly database: Database,
    private readonly feedUrl: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly logger?: Pick<Logger, 'warn' | 'info'>,
    private readonly expansion?: Pick<ExpansionStoreService, 'following' | 'followed'>,
  ) {}

  /** One read of the feed: the currencies whose rate changed. */
  async sweep(at: Date = new Date()): Promise<PresentmentCurrency[]> {
    const response = await this.fetcher(this.feedUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`The currency feed answered ${response.status}`);
    const body = (await response.json()) as { date?: unknown; pkr?: Record<string, unknown> };
    const day =
      typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
    if (!day || !body.pkr || typeof body.pkr !== 'object') {
      throw new Error('The currency feed gave no rates for the rupee');
    }
    const { rows: kept } = await this.database.system((tx) =>
      tx.execute<{ currency: PresentmentCurrency; rate: string }>(sql`
        SELECT currency, rate::text AS rate FROM platform.currency_rates`),
    );
    const before = new Map(kept.map((row) => [row.currency, parseRate(row.rate)]));
    const changed: PresentmentCurrency[] = [];
    for (const currency of PRESENTMENT_CURRENCIES) {
      const rate = rateFromUnitsPerRupee(Number(body.pkr[currency.toLowerCase()]));
      if (rate === null) continue;
      const last = before.get(currency);
      if (last === rate) continue;
      if (last && Math.abs(Number(rate - last) / Number(last)) > MOST_MOVED) {
        this.logger?.warn(
          { currency, last: formatRate(last), rate: formatRate(rate), day },
          'currency rate moved too far; kept the last',
        );
        continue;
      }
      await this.database.system((tx) =>
        tx.execute(sql`
          INSERT INTO platform.currency_rates (currency, rate, rate_date, fetched_at)
          VALUES (${currency}, ${formatRate(rate)}::numeric, ${day}::date,
                  ${at.toISOString()}::timestamptz)
          ON CONFLICT (currency) DO UPDATE
             SET rate = excluded.rate, rate_date = excluded.rate_date,
                 fetched_at = excluded.fetched_at`),
      );
      changed.push(currency);
    }
    if (changed.length === 0) return changed;
    const { rows: shops } = await this.database.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT DISTINCT shop_id FROM online_store.presentment_currencies
         WHERE fixed_rate IS NULL AND currency = ANY (${sql.param([...changed])}::text[])
         ORDER BY shop_id`),
    );
    for (const { shop_id: shopId } of shops) {
      await this.database.tenant(shopId, (tx) =>
        appendEvent(tx, shopId, {
          type: OnlineStoreEvents.PresentmentCurrenciesUpdated,
          aggregateType: 'shop',
          aggregateId: shopId,
          payload: {},
        }),
      );
    }
    const followed = await this.#follow(at);
    this.logger?.info({ day, changed, shops: shops.length, followed }, 'currency rates read');
    return changed;
  }

  /** Expansion stores following the day's rate, given it (ADR-929): how many took a new one. */
  async #follow(at: Date): Promise<number> {
    const links = (await this.expansion?.following()) ?? [];
    if (links.length === 0) return 0;
    const ids = [...new Set(links.flatMap((link) => [link.shopId, link.targetShopId]))];
    const { rates, currencies } = await this.database.system(async (tx) => {
      const { rows } = await tx.execute<{ id: string; currency: string }>(sql`
        SELECT id, currency FROM control.shops WHERE id = ANY (${sql.param(ids)}::uuid[])`);
      return {
        rates: await rupeeRatesIn(tx),
        currencies: new Map(rows.map((row) => [row.id, row.currency])),
      };
    });
    let taken = 0;
    for (const link of links) {
      const from = currencies.get(link.shopId);
      const to = currencies.get(link.targetShopId);
      const rate = from && to ? dayRateBetween(rates, from, to) : null;
      if (rate && (await this.expansion!.followed(link.shopId, link.targetShopId, rate, at))) {
        taken += 1;
      }
    }
    return taken;
  }

  /** Reads now, then every `intervalMs`, a read never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'currency rates not read'),
    );
  }
}
