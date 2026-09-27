export const CURRENCIES = {
  PKR: { exponent: 2, symbol: 'Rs' },
  USD: { exponent: 2, symbol: '$' },
  AED: { exponent: 2, symbol: 'AED' },
  SAR: { exponent: 2, symbol: 'SAR' },
  GBP: { exponent: 2, symbol: '£' },
  EUR: { exponent: 2, symbol: '€' },
  CAD: { exponent: 2, symbol: 'CA$' },
} as const satisfies Record<string, { exponent: number; symbol: string }>;

export type CurrencyCode = keyof typeof CURRENCIES;

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && Object.hasOwn(CURRENCIES, value);
}

export function exponentOf(currency: CurrencyCode): number {
  return CURRENCIES[currency].exponent;
}
