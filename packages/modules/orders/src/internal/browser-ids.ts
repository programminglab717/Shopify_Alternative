// The IDs ad platforms' pixels give a shopper's browser, in cookies on the shop's address (MKT-10,
// ADR-144): Meta's browser ID, from its `_fbp` cookie, and the click on one of its ads that
// brought them, from `_fbc`; TikTok's browser ID, from its `_ttp` (ADR-541); and Google's tag's,
// its `_ga` cookie as it is (ADR-548). The storefront
// passes them as the order is placed through checkout, and the order keeps them for its
// conversions to name the same browser the pixel's events did.

/** The longest an ID is kept: Meta's are some sixty characters. */
export const BROWSER_ID_LIMIT = 500;

/** An order's browser IDs, as it keeps them; each left out when the browser had none. */
export type BrowserIdsValue = {
  /** Meta's browser ID: `fb.1.<when, in ms>.<random>`. */
  fbp?: string;
  /** Meta's click ID: `fb.1.<when, in ms>.<the ad click's fbclid>`. */
  fbc?: string;
  /** TikTok's browser ID, from its `_ttp` cookie. */
  ttp?: string;
  /** Google's tag's cookie, `_ga`: `GA1.1.<random>.<first visit>`. */
  ga?: string;
};

/** Meta's format, its last part as long as a cookie's value may be, without spaces. */
const META_ID = /^fb\.[0-9]\.[0-9]{1,16}\.[!-~]+$/;

/** TikTok's: letters, digits and a few marks. */
const TIKTOK_ID = /^[A-Za-z0-9._-]{10,100}$/;

/** Google's: `GA1.`, the domain's parts, and two numbers. */
const GOOGLE_ID = /^GA1\.[0-9]\.[0-9]{1,20}\.[0-9]{1,20}$/;

const FORMS = { fbp: META_ID, fbc: META_ID, ttp: TIKTOK_ID, ga: GOOGLE_ID } as const;

/** The IDs of `given` in their platform's format and not too long; null when none is. */
export function browserIdsOf(
  given: Readonly<Record<string, unknown>> | null | undefined,
): BrowserIdsValue | null {
  if (!given) return null;
  const kept: BrowserIdsValue = {};
  for (const [name, form] of Object.entries(FORMS)) {
    const value = given[name];
    if (typeof value === 'string' && value.length <= BROWSER_ID_LIMIT && form.test(value)) {
      kept[name as keyof typeof FORMS] = value;
    }
  }
  return Object.keys(kept).length > 0 ? kept : null;
}
