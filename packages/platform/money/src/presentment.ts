import { CURRENCIES, type CurrencyCode } from './currency.js';
import { money, type Money } from './money.js';
import { divideRounded } from './rounding.js';

// Prices shown in a shopper's own currency (OS-21, ADR-865): a shop sells in rupees and charges
// in rupees, and shows shoppers abroad its prices in their currency as well, at a rate, rounded as
// the shop asks. A rate is how merchants say it, rupees for one unit: 1 AED = Rs 76.4521, kept as
// ten-thousandths of a rupee, so converting is exact.

/** The currencies a shop may show its prices in besides its own. */
export const PRESENTMENT_CURRENCIES = ['AED', 'SAR', 'GBP', 'USD', 'CAD', 'EUR'] as const;

export type PresentmentCurrency = (typeof PRESENTMENT_CURRENCIES)[number];

export function isPresentmentCurrency(value: unknown): value is PresentmentCurrency {
  return typeof value === 'string' && (PRESENTMENT_CURRENCIES as readonly string[]).includes(value);
}

/** How a converted price is rounded: to the cent, to a whole unit, or up to the next .99. */
export type PresentmentRounding = 'exact' | 'whole' | 'ninety_nine';

export const PRESENTMENT_ROUNDINGS: readonly PresentmentRounding[] = [
  'exact',
  'whole',
  'ninety_nine',
];

/** A rate's ten-thousandths of a rupee in one rupee. */
export const RATE_SCALE = 10_000n;

/** The largest rate taken, Rs 100,000 for one unit. */
const RATE_MAX = 100_000n * RATE_SCALE;

/**
 * "76.4521" as ten-thousandths of a rupee, 764521n: more than nothing, four decimals at most, up
 * to Rs 100,000; null for anything else.
 */
export function parseRate(text: string): bigint | null {
  const match = /^(\d{1,6})(?:\.(\d{1,4}))?$/.exec(text.trim());
  if (!match) return null;
  const rate = BigInt(match[1]!) * RATE_SCALE + BigInt((match[2] ?? '').padEnd(4, '0'));
  return rate > 0n && rate <= RATE_MAX ? rate : null;
}

/** A rate as merchants read it: 764521n is "76.4521", 2800000n "280". */
export function formatRate(rate: bigint): string {
  const whole = rate / RATE_SCALE;
  const fraction = (rate % RATE_SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * A rate from a feed's units of the currency for one rupee, 0.01308, as ten-thousandths of a
 * rupee for one unit; null where it is no rate at all.
 */
export function rateFromUnitsPerRupee(unitsPerRupee: number): bigint | null {
  if (!Number.isFinite(unitsPerRupee) || unitsPerRupee <= 0) return null;
  const rate = BigInt(Math.round(Number(RATE_SCALE) / unitsPerRupee));
  return rate > 0n && rate <= RATE_MAX ? rate : null;
}

/**
 * `paisa` shown in `currency` at `rate`, rounded as asked: a whole unit half up, or up to the
 * next .99; nothing stays nothing, and an amount off is rounded as the price it takes off.
 */
export function presentFromRupees(
  paisa: bigint,
  currency: PresentmentCurrency,
  rate: bigint,
  rounding: PresentmentRounding = 'exact',
): Money {
  const negative = paisa < 0n;
  const absolute = negative ? -paisa : paisa;
  // Paisa and cents are both hundredths: the rate's scale is all that differs.
  const scale = 10n ** BigInt(CURRENCIES[currency].exponent);
  let minor = divideRounded(absolute * RATE_SCALE * scale, rate * 100n, 'half-up');
  if (minor > 0n && rounding === 'whole') {
    // A price of something is never shown as nothing.
    minor = (divideRounded(minor, scale, 'half-up') || 1n) * scale;
  } else if (minor > 0n && rounding === 'ninety_nine') {
    minor = divideRounded(minor + 1n, scale, 'ceil') * scale - 1n;
  }
  return money(negative ? -minor : minor, currency as CurrencyCode);
}
