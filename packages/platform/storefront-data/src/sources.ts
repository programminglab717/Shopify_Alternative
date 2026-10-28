import { deviceOf } from './vitals.js';

// Where a shop's sessions came from, the pages they landed on and the devices they were on
// (ANL-02, ADR-884), as Shopify's sessions by referrer, landing page and device: each counted once,
// when the session began, from what its first page's script says and its browser's user agent.

/** What sessions are counted by. */
export const SESSION_DIMENSIONS = ['source', 'landing_page', 'device'] as const;
export type SessionDimension = (typeof SESSION_DIMENSIONS)[number];

export const SESSION_SOURCE_LIMITS = {
  /** A source's name, as a campaign gives it or a site's host. */
  source: 60,
  /** A landing page's path. */
  path: 200,
} as const;

/** Sites by the name merchants know them: their hosts, and those ending so. */
const KNOWN: readonly [RegExp, string][] = [
  [/(^|\.)google\.[a-z.]+$/, 'google'],
  [/(^|\.)bing\.com$/, 'bing'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'whatsapp'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)(twitter\.com|x\.com|t\.co)$/, 'x'],
  [/(^|\.)pinterest\.[a-z.]+$/, 'pinterest'],
  [/(^|\.)daraz\.(pk|com)$/, 'daraz'],
  [/(^|\.)chatgpt\.com$/, 'chatgpt'],
];

/** What a session's first page says of how it came. */
export interface SessionArrival {
  /** The page's path, as `location.pathname` gives it. */
  landing: string;
  /** `document.referrer`: the page before, on another site or none. */
  referrer: string;
  /** The `utm_source` of the page's address, where a campaign's link gave one. */
  utmSource?: string | null;
}

/** A session's source, landing page and device, as they are counted. */
export type SessionOrigin = Record<SessionDimension, string>;

/**
 * Where a session came from: its campaign's `utm_source` where its link gave one; else the site
 * its referrer was, by the name merchants know it, or its host; else `direct`, as for a referrer
 * on the shop's own host.
 */
export function sessionSourceOf(arrival: SessionArrival, shopHost: string): string {
  const campaign = (arrival.utmSource ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .slice(0, SESSION_SOURCE_LIMITS.source);
  if (campaign) return campaign;
  let host: string;
  try {
    host = new URL(arrival.referrer).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'direct';
  }
  if (!host || host === shopHost.toLowerCase().replace(/^www\./, '')) return 'direct';
  for (const [pattern, name] of KNOWN) if (pattern.test(host)) return name;
  return host.slice(0, SESSION_SOURCE_LIMITS.source);
}

/** A landing page's path: lower case, without its query, a trailing slash or anything past 200. */
export function landingPageOf(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? '';
  const trimmed = bare.toLowerCase().replace(/\/+$/, '');
  if (!trimmed.startsWith('/')) return '/';
  return trimmed.slice(0, SESSION_SOURCE_LIMITS.path) || '/';
}

/** What a session's first page's beacon says, `{ b, l, r, s }`; null where it says no session began. */
export function arrivalOf(body: unknown): SessionArrival | null {
  let fields: unknown = body;
  if (typeof body === 'string') {
    try {
      fields = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null;
  const { b, l, r, s } = fields as Record<string, unknown>;
  if (b !== 1 || typeof l !== 'string') return null;
  return {
    landing: l.slice(0, 1000),
    referrer: typeof r === 'string' ? r.slice(0, 2000) : '',
    utmSource: typeof s === 'string' ? s.slice(0, 200) : null,
  };
}

/** A session's source, landing page and device, from its first page and its user agent. */
export function sessionOriginOf(
  arrival: SessionArrival,
  shopHost: string,
  userAgent: string | undefined,
): SessionOrigin {
  return {
    source: sessionSourceOf(arrival, shopHost),
    landing_page: landingPageOf(arrival.landing),
    device: deviceOf(userAgent),
  };
}
