// The IDs ad platforms' pixels give a shopper's browser, in cookies on the shop's address (MKT-10,
// ADR-144): Meta's browser ID, from its `_fbp` cookie, and the click on one of its ads that
// brought them, from `_fbc`. The storefront passes them as the order is placed through checkout,
// and the order keeps them for its conversions to name the same browser the pixel's events did.

/** The longest an ID is kept: Meta's are some sixty characters. */
export const BROWSER_ID_LIMIT = 500;

/** An order's browser IDs, as it keeps them; each left out when the browser had none. */
export type BrowserIdsValue = {
  /** Meta's browser ID: `fb.1.<when, in ms>.<random>`. */
  fbp?: string;
  /** Meta's click ID: `fb.1.<when, in ms>.<the ad click's fbclid>`. */
  fbc?: string;
};

/** Meta's format, its last part as long as a cookie's value may be, without spaces. */
const META_ID = /^fb\.[0-9]\.[0-9]{1,16}\.[!-~]+$/;

/** The IDs of `given` in Meta's format and not too long; null when none is. */
export function browserIdsOf(
  given: Readonly<Record<string, unknown>> | null | undefined,
): BrowserIdsValue | null {
  if (!given) return null;
  const kept: BrowserIdsValue = {};
  for (const name of ['fbp', 'fbc'] as const) {
    const value = given[name];
    if (typeof value === 'string' && value.length <= BROWSER_ID_LIMIT && META_ID.test(value)) {
      kept[name] = value;
    }
  }
  return kept.fbp || kept.fbc ? kept : null;
}
