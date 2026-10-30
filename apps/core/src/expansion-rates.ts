import type { Tx } from '@hatti/db';
import { RATE_SCALE, exponentOf, isCurrencyCode, parseRate } from '@hatti/money';
import { sql } from 'drizzle-orm';

// Expansion stores priced at the day's rate (CH-11, ADR-929): what a price in one shop's
// currency is multiplied by in the other's, from the rates the currency feed last gave (ADR-865),
// each rupees for one unit, the rupee being one.

/** Rupees for one unit of each currency the feed gives, in ten-thousandths: AED 764521n. */
export async function rupeeRatesIn(tx: Tx): Promise<Map<string, bigint>> {
  const { rows } = await tx.execute<{ currency: string; rate: string }>(sql`
    SELECT currency, rate::text AS rate FROM platform.currency_rates`);
  const rates = new Map<string, bigint>();
  for (const row of rows) {
    const rate = parseRate(row.rate);
    if (rate) rates.set(row.currency, rate);
  }
  return rates;
}

/**
 * Rupees for one unit of each currency on each of `days` (ADR-974), as `YYYY-MM-DD`: the rate
 * the feed gave that day, or the last before it; today's, from {@link rupeeRatesIn}, for a
 * currency whose history begins after it. One read, however many days.
 */
export async function rupeeRatesByDayIn(
  tx: Tx,
  days: readonly string[],
): Promise<(day: string) => Map<string, bigint>> {
  const today = await rupeeRatesIn(tx);
  if (days.length === 0) return () => today;
  const last = [...days].sort().at(-1)!;
  const { rows } = await tx.execute<{ currency: string; rate_date: string; rate: string }>(sql`
    SELECT currency, rate_date::text AS rate_date, rate::text AS rate
      FROM platform.currency_rate_history
     WHERE rate_date <= ${last}::date
     ORDER BY currency, rate_date`);
  const byDay = new Map<string, Map<string, bigint>>();
  return (day) => {
    let rates = byDay.get(day);
    if (!rates) {
      rates = new Map(today);
      // Ordered by currency, then day: each currency's last on or before `day` is kept.
      for (const row of rows) {
        const rate = row.rate_date <= day ? parseRate(row.rate) : null;
        if (rate) rates.set(row.currency, rate);
      }
      byDay.set(day, rates);
    }
    return rates;
  };
}

/**
 * The day's rate from `from` to `to`, as an expansion store's rate is written, six decimals at
 * most: "0.01308" from rupees to dirhams; null where the feed gives no rate for either, or it
 * comes to nothing.
 */
export function dayRateBetween(
  rates: ReadonlyMap<string, bigint>,
  from: string,
  to: string,
): string | null {
  const rupees = (currency: string) => (currency === 'PKR' ? RATE_SCALE : rates.get(currency));
  const source = rupees(from);
  const target = rupees(to);
  if (!source || !target) return null;
  const micro = (source * 1_000_000n + target / 2n) / target;
  if (micro <= 0n) return null;
  const fraction = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  const whole = (micro / 1_000_000n).toString();
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * `amount`, in minor units of `from`, in minor units of `to` at the day's rates, to the nearest
 * (ADR-932): what an expansion store's sales come to in this shop's currency. Null where the feed
 * gives no rate for either.
 */
export function convertBetween(
  rates: ReadonlyMap<string, bigint>,
  amount: bigint,
  from: string,
  to: string,
): bigint | null {
  if (from === to) return amount;
  if (!isCurrencyCode(from) || !isCurrencyCode(to)) return null;
  const rupees = (currency: string) => (currency === 'PKR' ? RATE_SCALE : rates.get(currency));
  const source = rupees(from);
  const target = rupees(to);
  if (!source || !target) return null;
  const numerator = amount * source * 10n ** BigInt(exponentOf(to));
  const denominator = target * 10n ** BigInt(exponentOf(from));
  // Half away from nothing, for returns that leave a store's sales below it.
  const half = denominator / 2n;
  return (numerator + (numerator < 0n ? -half : half)) / denominator;
}
