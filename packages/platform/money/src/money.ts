import { exponentOf, isCurrencyCode, type CurrencyCode } from './currency.js';
import { divideRounded, type RoundingMode } from './rounding.js';

/**
 * An amount of money in integer minor units (paisa for PKR).
 * Floats are never used for money anywhere in Hatti.
 */
export interface Money {
  readonly amount: bigint;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

export function money(amountMinor: bigint | number, currency: CurrencyCode): Money {
  if (!isCurrencyCode(currency)) {
    throw new MoneyError(`Unsupported currency: ${String(currency)}`);
  }
  if (typeof amountMinor === 'number') {
    if (!Number.isSafeInteger(amountMinor)) {
      throw new MoneyError(`Minor-unit amounts must be safe integers, received ${amountMinor}`);
    }
    return Object.freeze({ amount: BigInt(amountMinor), currency });
  }
  return Object.freeze({ amount: amountMinor, currency });
}

export function zero(currency: CurrencyCode): Money {
  return money(0n, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function negate(m: Money): Money {
  return money(-m.amount, m.currency);
}

export function sum(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce((total, item) => add(total, item), zero(currency));
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount === b.amount) return 0;
  return a.amount < b.amount ? -1 : 1;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount === b.amount;
}

export function isZero(m: Money): boolean {
  return m.amount === 0n;
}

export function isNegative(m: Money): boolean {
  return m.amount < 0n;
}

/** Multiplies by an exact ratio (numerator / denominator) and rounds to minor units. */
export function multiplyByRatio(
  m: Money,
  numerator: bigint,
  denominator: bigint,
  rounding: RoundingMode = 'half-even',
): Money {
  return money(divideRounded(m.amount * numerator, denominator, rounding), m.currency);
}

/** Percentage expressed in basis points: 1500 = 15%. Integer input keeps it exact. */
export function percentageOf(
  m: Money,
  basisPoints: number,
  rounding: RoundingMode = 'half-even',
): Money {
  if (!Number.isSafeInteger(basisPoints)) {
    throw new MoneyError('Basis points must be an integer (1500 = 15%)');
  }
  return multiplyByRatio(m, BigInt(basisPoints), 10_000n, rounding);
}

/** Multiplies by an integer quantity (e.g. unit price × quantity). */
export function times(m: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity)) {
    throw new MoneyError('Quantity must be an integer');
  }
  return money(m.amount * BigInt(quantity), m.currency);
}

/**
 * Splits an amount across ratios using the largest-remainder method, so the parts
 * always add up exactly to the total. Used to spread discounts across order lines.
 */
export function allocate(total: Money, ratios: readonly (number | bigint)[]): Money[] {
  if (ratios.length === 0) {
    throw new MoneyError('allocate() needs at least one ratio');
  }
  const weights = ratios.map((ratio) => {
    const weight = typeof ratio === 'bigint' ? ratio : BigInt(ratio);
    if (typeof ratio === 'number' && !Number.isSafeInteger(ratio)) {
      throw new MoneyError('Ratios must be integers');
    }
    if (weight < 0n) throw new MoneyError('Ratios must not be negative');
    return weight;
  });
  const weightSum = weights.reduce((a, b) => a + b, 0n);
  if (weightSum === 0n) {
    throw new MoneyError('Ratios must not all be zero');
  }

  const sign = total.amount < 0n ? -1n : 1n;
  const absolute = total.amount * sign;
  const shares = weights.map((weight) => (absolute * weight) / weightSum);
  let remainder = absolute - shares.reduce((a, b) => a + b, 0n);

  const byFraction = weights
    .map((weight, index) => ({ index, fraction: (absolute * weight) % weightSum }))
    .sort((x, y) =>
      x.fraction === y.fraction ? x.index - y.index : x.fraction > y.fraction ? -1 : 1,
    );
  for (let i = 0; remainder > 0n; i++, remainder--) {
    const target = byFraction[i];
    if (!target) throw new MoneyError('Allocation invariant violated');
    shares[target.index] = (shares[target.index] ?? 0n) + 1n;
  }
  return shares.map((share) => money(share * sign, total.currency));
}

/**
 * Parses a major-unit decimal string such as "12,500.50" into minor units.
 * Thousands separators are allowed; more decimal places than the currency has are rejected.
 */
export function fromMajor(value: string | number, currency: CurrencyCode): Money {
  const text = (typeof value === 'number' ? String(value) : value).trim().replace(/,/g, '');
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new MoneyError(`Not a valid amount: "${String(value)}"`);
  }
  const [, minus, whole = '0', fraction = ''] = match;
  const exponent = exponentOf(currency);
  if (fraction.length > exponent) {
    throw new MoneyError(`${currency} amounts allow at most ${exponent} decimal places`);
  }
  const minor = BigInt(whole + fraction.padEnd(exponent, '0'));
  return money(minus ? -minor : minor, currency);
}

/** Major-unit decimal string with the currency's full precision, e.g. "12500.50". */
export function toMajorString(m: Money): string {
  const exponent = exponentOf(m.currency);
  const negative = m.amount < 0n;
  const digits = (negative ? -m.amount : m.amount).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${whole}${exponent > 0 ? `.${fraction}` : ''}`;
}
