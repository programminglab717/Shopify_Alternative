import type { StorefrontVisit } from '@hatti/storefront-api';

// Where shoppers come to the shop from (ORD-13, ADR-139). Pages are kept at the edge and are the
// same for every shopper, so a script in each page's head keeps, in a cookie of the shop's, the
// visits that brought the shopper: the first, and the last from elsewhere, each with when it
// began, the page it landed on and the page on another site that linked to it. A visit from
// elsewhere is one whose address has a campaign's tags or an ad's click ID, or that another site
// linked to; going from page to page on the shop, or coming back to it straight, is none. Cart
// permalinks go straight to checkout without a page, so the storefront counts those itself, by
// the same rules. Starting a checkout passes the visits to the core, for the order to keep.

/** The cookie: base64url JSON of up to two visits, `[seconds since 1970, path, referrer]`. */
export const VISITS_COOKIE = 'hatti_visits';

/** How long the cookie keeps a visit after it began. */
export const VISIT_DAYS = 30;

/** The longest a kept path, its query with it, and a referring page may be. */
export const VISIT_LIMITS = { landing: 800, referrer: 300 };

const DAY_SECONDS = 24 * 60 * 60;

/** The UTM tags and click IDs that make an address a campaign's, in an address's query. */
const CAMPAIGN =
  /[?&](utm_(source|medium|campaign|term|content)|fbclid|gclid|gbraid|wbraid|ttclid|msclkid)=/;

/**
 * A visit as the cookie keeps it: when it began, in seconds since 1970; its path, its query with
 * it; and the page of another site's that linked to it, or "".
 */
export type KeptVisit = [at: number, landing: string, referrer: string];

/** The visits the cookie keeps that still count at `now`, in seconds: two at most. */
export function keptVisits(value: string | null, now: number): KeptVisit[] {
  if (!value || value.length > 4096) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .slice(0, 2)
    .filter(isKeptVisit)
    .filter(([at]) => now - at <= VISIT_DAYS * DAY_SECONDS);
}

function isKeptVisit(value: unknown): value is KeptVisit {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    Number.isSafeInteger(value[0]) &&
    typeof value[1] === 'string' &&
    typeof value[2] === 'string'
  );
}

/**
 * The visits once the shopper asked for `path`, its query with it, at the shop's `host`, linked
 * from `referrer`: a visit from elsewhere is the last, and the first too when none is kept; null
 * when the request changes nothing, as the script's rules have it. A page the shopper `landed`
 * on, as every page the script runs on may be, is their first visit when none is kept, whatever
 * brought them; a request from the shop's own pages, such as its cart's checkout button, is none.
 */
export function visitsAfter(
  kept: KeptVisit[],
  request: { path: string; host: string; referrer: string | undefined; landed?: boolean },
  now: number,
): KeptVisit[] | null {
  const from = otherSite(request.referrer, request.host);
  const query = request.path.includes('?') ? request.path.slice(request.path.indexOf('?')) : '';
  const elsewhere = from !== '' || CAMPAIGN.test(query);
  if (!elsewhere && (kept.length > 0 || request.landed === false)) return null;
  const visit: KeptVisit = [
    now,
    request.path.slice(0, VISIT_LIMITS.landing),
    from.slice(0, VISIT_LIMITS.referrer),
  ];
  return kept.length > 0 ? [kept[0]!, visit] : [visit];
}

/** The page of another site's that linked to the shop, without its query; "" for none. */
function otherSite(referrer: string | undefined, host: string): string {
  if (!referrer) return '';
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  return url.host === host.toLowerCase() ? '' : `${url.origin}${url.pathname}`;
}

/** The cookie keeping `visits`, which the page's script reads and writes too: not HttpOnly. */
export function visitsCookie(visits: KeptVisit[], options: { secure: boolean }): string {
  const value = Buffer.from(JSON.stringify(visits)).toString('base64url');
  const secure = options.secure ? '; Secure' : '';
  return `${VISITS_COOKIE}=${value}; Max-Age=${VISIT_DAYS * DAY_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

/** The visits as the core takes them, their landing pages at the shop's `origin`. */
export function storefrontVisits(kept: KeptVisit[], origin: string): StorefrontVisit[] {
  return kept.map(([at, landing, referrer]) => ({
    occurredAt: new Date(at * 1000).toISOString(),
    landingPage: `${origin}${landing}`,
    referrerUrl: referrer || null,
  }));
}

/**
 * `path`, a path on the shop, with the campaign tags and click IDs of `query` it lacks: a discount
 * link sends the shopper on to a page, whose script then sees where they came from.
 */
export function withCampaign(path: string, query: URLSearchParams): string {
  const url = new URL(path, 'http://storefront.invalid');
  let added = false;
  for (const [key, value] of query) {
    if (CAMPAIGN.test(`?${key}=`) && !url.searchParams.has(key)) {
      url.searchParams.append(key, value);
      added = true;
    }
  }
  return added ? `${url.pathname}${url.search}${url.hash}` : path;
}

/**
 * The script each page's head carries, by {@link visitsAfter}'s rules: classic, small, and silent
 * when anything fails, as when cookies are blocked.
 */
export const VISITS_SCRIPT = `(function () {
  try {
    var now = Math.floor(Date.now() / 1000);
    var kept = [];
    var found = document.cookie.match(/(?:^|;\\s*)${VISITS_COOKIE}=([\\w-]+)/);
    try {
      var parsed = found ? JSON.parse(atob(found[1].replace(/-/g, '+').replace(/_/g, '/'))) : [];
      for (var i = 0; i < parsed.length && i < 2; i++) {
        if (now - parsed[i][0] <= ${VISIT_DAYS * DAY_SECONDS}) kept.push(parsed[i]);
      }
    } catch (error) {
      kept = [];
    }
    var from = '';
    if (document.referrer) {
      var referrer = new URL(document.referrer);
      if (/^https?:$/.test(referrer.protocol) && referrer.host !== location.host) {
        from = referrer.origin + referrer.pathname;
      }
    }
    if (kept.length && !from && !${CAMPAIGN}.test(location.search)) return;
    var visit = [
      now,
      (location.pathname + location.search).slice(0, ${VISIT_LIMITS.landing}),
      from.slice(0, ${VISIT_LIMITS.referrer})
    ];
    var value = btoa(JSON.stringify(kept.length ? [kept[0], visit] : [visit]));
    document.cookie = '${VISITS_COOKIE}=' +
      value.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '') +
      '; Max-Age=${VISIT_DAYS * DAY_SECONDS}; Path=/; SameSite=Lax' +
      (location.protocol === 'https:' ? '; Secure' : '');
  } catch (error) {}
})();`;
