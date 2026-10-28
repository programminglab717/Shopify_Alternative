import { isPresentmentCurrency, type PresentmentCurrency } from '@hatti/money';
import type { CurrencyDoc } from '@hatti/storefront-data';
import { cookieOf } from './cart.js';

// The shopper's currency (OS-21, ADR-865): one of those the shop shows its prices in besides
// rupees, picked through the theme's localization form, as Shopify's, and kept in a cookie the
// pages' scripts read too. Pages in it are the shopper's own, never kept at the edge; checkout
// charges rupees.

export const CURRENCY_COOKIE = 'currency';

/** A year: the shopper's currency stays theirs until they pick another. */
const CURRENCY_COOKIE_SECONDS = 365 * 86_400;

/** The country Shopify's localization form names, as the currency it is shown in. */
const COUNTRY_CURRENCIES: Readonly<Record<string, PresentmentCurrency | 'PKR'>> = {
  PK: 'PKR',
  AE: 'AED',
  SA: 'SAR',
  GB: 'GBP',
  US: 'USD',
  CA: 'CAD',
  // The euro's countries where Pakistanis live most.
  DE: 'EUR',
  FR: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  NL: 'EUR',
  IE: 'EUR',
  BE: 'EUR',
  GR: 'EUR',
};

/** The currency the shopper's cookie names; null for rupees, or one that is no currency. */
export function currencyCookieOf(header: string | undefined): PresentmentCurrency | null {
  const value = cookieOf(header, CURRENCY_COOKIE);
  return isPresentmentCurrency(value) ? value : null;
}

/** The cookie keeping `currency`, or forgetting it for rupees. */
export function currencyCookie(
  currency: PresentmentCurrency | null,
  options: { secure: boolean },
): string {
  const common = `Path=/; SameSite=Lax${options.secure ? '; Secure' : ''}`;
  return currency
    ? `${CURRENCY_COOKIE}=${currency}; Max-Age=${CURRENCY_COOKIE_SECONDS}; ${common}`
    : `${CURRENCY_COOKIE}=; Max-Age=0; ${common}`;
}

/**
 * The currency a localization form asks for, by `currency_code` or by `country_code`, as
 * Shopify's forms post it: 'PKR' for rupees; null when it names neither.
 */
export function askedCurrency(
  params: Readonly<Record<string, unknown>>,
): PresentmentCurrency | 'PKR' | null {
  const text = (name: string) =>
    typeof params[name] === 'string' ? (params[name] as string).trim().toUpperCase() : '';
  const code = text('currency_code');
  if (code === 'PKR' || isPresentmentCurrency(code)) return code;
  return COUNTRY_CURRENCIES[text('country_code')] ?? null;
}

/**
 * The currency to suggest to a shopper from abroad, by the country the edge says they are in, as
 * Cloudflare's `CF-IPCountry` gives it: one the shop shows its prices in; null for none.
 */
export function suggestedCurrency(
  country: string | undefined,
  currencies: readonly CurrencyDoc[] | undefined,
): PresentmentCurrency | null {
  const code = COUNTRY_CURRENCIES[(country ?? '').toUpperCase()];
  return code && code !== 'PKR' && currencies?.some((each) => each.currency === code) ? code : null;
}
