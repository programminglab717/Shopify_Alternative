// Where shoppers came to the online store from before they ordered (ORD-13, ADR-139). The
// storefront passes the visits the shopper's browser kept when they start checking out; these
// rules check them, and work out what reports group orders by: where each visit came from, and
// its landing page's UTM parameters.
import type { OrderAttributionRecord, OrderVisitRecord } from './records.js';

/** How long a visit counts towards an order: as long as the storefront's cookie keeps it. */
export const VISIT_DAYS = 30;

/** The longest a kept landing page, referring page, UTM parameter or source may be. */
export const ATTRIBUTION_LIMITS = { landingPage: 2048, referrer: 512, utm: 255, source: 100 };

/** How far ahead of the core's clock a visit may say it was: browsers' clocks drift. */
const SKEW_MS = 5 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** A visit's UTM parameters, as its landing page's query gave them; null where it gave none. */
export interface UtmValue {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
}

/** A visit, as a checkout and its order keep it. */
export interface VisitValue {
  /** When it began, in ISO 8601. */
  at: string;
  /** Where it came from: see {@link sourceOf}. */
  source: string;
  utm: UtmValue | null;
  /** The address it began at, its query with it; left out once the customer's data is erased. */
  landingPage?: string;
  /**
   * The page on another site that linked to it, without its query, when the browser said;
   * left out otherwise, and once the customer's data is erased.
   */
  referrer?: string;
}

/**
 * The visits that brought a shopper to the online store before an order: the first, and the last
 * from elsewhere, the same visit when there was one.
 */
export interface AttributionValue {
  first: VisitValue;
  last: VisitValue;
}

/**
 * Platforms by the domains they link from, in the names reports give them. Google's search is
 * at a domain of every country's, so it is matched apart.
 */
const PLATFORMS: readonly (readonly [name: string, domains: readonly string[]])[] = [
  ['facebook', ['facebook.com', 'fb.com', 'fb.me']],
  ['instagram', ['instagram.com']],
  ['messenger', ['messenger.com', 'm.me']],
  ['whatsapp', ['whatsapp.com', 'wa.me']],
  ['tiktok', ['tiktok.com']],
  ['youtube', ['youtube.com', 'youtu.be']],
  ['snapchat', ['snapchat.com']],
  ['pinterest', ['pinterest.com', 'pin.it']],
  ['x', ['x.com', 'twitter.com', 't.co']],
  ['linkedin', ['linkedin.com', 'lnkd.in']],
  ['bing', ['bing.com']],
  ['yahoo', ['yahoo.com']],
  ['duckduckgo', ['duckduckgo.com']],
];
const GOOGLE = /(^|\.)google\.(com?\.)?[a-z]{2,3}$/;

/** The parameters ad platforms add to the links their ads open, and whose ads they are. */
export const AD_CLICK_IDS: readonly (readonly [parameter: string, platform: string])[] = [
  ['fbclid', 'facebook'],
  ['gclid', 'google'],
  ['gbraid', 'google'],
  ['wbraid', 'google'],
  ['ttclid', 'tiktok'],
  ['msclkid', 'bing'],
];

/** The platform a site at `host` is, by the name reports give it; null for any other site. */
export function platformOf(host: string): string | null {
  const name = host.toLowerCase();
  if (GOOGLE.test(name)) return 'google';
  for (const [platform, domains] of PLATFORMS) {
    if (domains.some((domain) => name === domain || name.endsWith(`.${domain}`))) return platform;
  }
  return null;
}

/**
 * Where a visit came from, which reports group orders by: its landing page's `utm_source`, as
 * the shop tagged its link, in lower case; else, for an ad's click, the platform of the site
 * linking to it, or the ad's; else the platform of the site linking to it, as "facebook",
 * "instagram", "google" or "tiktok", or that site's domain; else "direct".
 */
export function sourceOf(utm: UtmValue | null, query: URLSearchParams, referrer: URL | null) {
  if (utm?.source) return utm.source.toLowerCase().slice(0, ATTRIBUTION_LIMITS.source);
  const linking = referrer && platformOf(referrer.hostname);
  const click = AD_CLICK_IDS.find(([parameter]) => query.has(parameter));
  if (click) return linking ?? click[1];
  if (referrer) {
    return (linking ?? referrer.hostname.replace(/^www\./, '')).slice(0, ATTRIBUTION_LIMITS.source);
  }
  return 'direct';
}

/**
 * The visits the storefront passed, checked: each an object with `occurredAt`, an ISO 8601 time
 * within the last {@link VISIT_DAYS} days, `landingPage`, an http or https address, and
 * `referrerUrl`, another such address or null; the first given and the last, in the order they
 * were. Null when none checks out, as when the storefront knew of none.
 */
export function attributionOf(input: unknown, now: Date): AttributionValue | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const given: unknown[] = input.length === 1 ? [input[0]] : [input[0], input[input.length - 1]];
  const visits = given
    .map((visit) => visitOf(visit, now))
    .filter((visit): visit is VisitValue => visit !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const [first] = visits;
  if (!first) return null;
  return { first, last: visits[visits.length - 1]! };
}

function visitOf(input: unknown, now: Date): VisitValue | null {
  if (typeof input !== 'object' || input === null) return null;
  const { occurredAt, landingPage, referrerUrl } = input as Record<string, unknown>;
  if (typeof occurredAt !== 'string' || occurredAt.length > 40) return null;
  const at = Date.parse(occurredAt);
  if (!Number.isFinite(at) || at > now.getTime() + SKEW_MS) return null;
  if (at < now.getTime() - VISIT_DAYS * DAY_MS) return null;
  const landing = webAddress(landingPage);
  if (!landing) return null;
  landing.hash = '';
  let referrer = webAddress(referrerUrl);
  // A page of the shop's own is no other site's link.
  if (referrer?.host === landing.host) referrer = null;
  const utm = utmOf(landing.searchParams);
  const visit: VisitValue = {
    at: new Date(Math.min(at, now.getTime())).toISOString(),
    source: sourceOf(utm, landing.searchParams, referrer),
    utm,
    landingPage: landing.href.slice(0, ATTRIBUTION_LIMITS.landingPage),
  };
  if (referrer) {
    visit.referrer = `${referrer.origin}${referrer.pathname}`.slice(0, ATTRIBUTION_LIMITS.referrer);
  }
  return visit;
}

/** An http or https address, as a browser gave it; null for anything else. */
function webAddress(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 4 * ATTRIBUTION_LIMITS.landingPage) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

function utmOf(query: URLSearchParams): UtmValue | null {
  const utm: UtmValue = {
    source: utmParameter(query, 'utm_source'),
    medium: utmParameter(query, 'utm_medium'),
    campaign: utmParameter(query, 'utm_campaign'),
    term: utmParameter(query, 'utm_term'),
    content: utmParameter(query, 'utm_content'),
  };
  return Object.values(utm).some((value) => value !== null) ? utm : null;
}

function utmParameter(query: URLSearchParams, name: string): string | null {
  const value = query
    .get(name)
    ?.replace(/\p{Cc}/gu, '')
    .trim();
  return value ? value.slice(0, ATTRIBUTION_LIMITS.utm) : null;
}

/** Whole days from an order's first visit to when it was placed. */
export function daysToConversion(attribution: AttributionValue, placedAt: Date): number {
  return Math.max(0, Math.floor((placedAt.getTime() - Date.parse(attribution.first.at)) / DAY_MS));
}

/** An order's visits as the Admin API reads them. */
export function toAttributionRecord(
  orderId: string,
  attribution: AttributionValue,
  placedAt: Date,
): OrderAttributionRecord {
  return {
    orderId,
    firstVisit: toVisitRecord(attribution.first),
    lastVisit: toVisitRecord(attribution.last),
    daysToConversion: daysToConversion(attribution, placedAt),
  };
}

function toVisitRecord(visit: VisitValue): OrderVisitRecord {
  return {
    occurredAt: new Date(visit.at),
    source: visit.source,
    utm: visit.utm,
    landingPage: visit.landingPage ?? null,
    referrerUrl: visit.referrer ?? null,
  };
}
