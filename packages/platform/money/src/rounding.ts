/**
 * Rounding modes for integer division.
 * - half-even: banker's rounding; unbiased over many operations (default for money math)
 * - half-up:   .5 rounds away from zero (typical for prices shown to people)
 * - floor / ceil / truncate: toward -∞ / +∞ / zero
 */
export type RoundingMode = 'half-even' | 'half-up' | 'floor' | 'ceil' | 'truncate';

export function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new RangeError('Division by zero');
  }
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const quotient = n / d; // truncates toward zero
  const remainder = n % d; // same sign as n
  if (remainder === 0n) return quotient;

  const sign = n < 0n ? -1n : 1n;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;

  switch (mode) {
    case 'truncate':
      return quotient;
    case 'floor':
      return sign < 0n ? quotient - 1n : quotient;
    case 'ceil':
      return sign > 0n ? quotient + 1n : quotient;
    case 'half-up':
      return twiceRemainder >= d ? quotient + sign : quotient;
    case 'half-even':
      if (twiceRemainder > d) return quotient + sign;
      if (twiceRemainder < d) return quotient;
      return quotient % 2n === 0n ? quotient : quotient + sign;
  }
}
