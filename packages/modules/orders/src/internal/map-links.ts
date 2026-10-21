import { parseDegrees, type MapPoint } from '@hatti/pk';

// A pin from a map's link (CHK-02, ADR-718): shoppers in Pakistan share where they live as a
// Google Maps link, or its coordinates, more often than they stand at the address with their phone.
// The link is read for its place; the app's short links, which say nothing until followed, are
// followed to where they lead, on Google's own hosts alone.

/** Hosts of the short links Google Maps shares, which are followed to read where they lead. */
const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl']);

/** How many redirects a short link is followed through, and how long each may take. */
export const MAP_LINK_LIMITS = { redirects: 3, timeoutMs: 3_000, length: 500 } as const;

const DEGREES = String.raw`(-?\d{1,3}(?:\.\d+)?)`;

/** Where a place is in a link or text, the most precise first. */
const PATTERNS = [
  // A place's own coordinates in a Google Maps link: ".../data=!3m1!4b1!4m6!3m5!...!3d24.86!4d67.01".
  new RegExp(String.raw`!3d${DEGREES}!4d${DEGREES}`),
  // Asked for by query: "?q=24.86,67.01", "?api=1&query=24.86,67.01", "?ll=", "&destination=".
  new RegExp(String.raw`[?&](?:q|query|ll|destination|daddr)=(?:loc:)?${DEGREES},\s*${DEGREES}`),
  // The map's centre: ".../@24.86,67.01,17z".
  new RegExp(String.raw`@${DEGREES},${DEGREES}`),
  // Typed as coordinates: "24.8607, 67.0011" or "24.8607 67.0011".
  new RegExp(String.raw`^\s*${DEGREES}\s*[,\s]\s*${DEGREES}\s*$`),
];

/** The place a link or text names by its coordinates; null where it names none. */
export function pointInText(text: string): MapPoint | null {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // Not encoded as a URI: read as typed.
  }
  for (const pattern of PATTERNS) {
    const match = pattern.exec(decoded);
    if (!match) continue;
    const latitude = parseDegrees(match[1]!);
    const longitude = parseDegrees(match[2]!);
    if (latitude !== null && longitude !== null && Math.abs(latitude) <= 90) {
      return { latitude, longitude };
    }
  }
  return null;
}

/**
 * The place a shopper's map link or coordinates name: read from it, or, for one of Google Maps'
 * short links, from where it leads, followed through at most {@link MAP_LINK_LIMITS} redirects,
 * each within its time. Null where none is found, the link leads off Google's short hosts, or
 * following it fails. `fetcher` is the platform's fetch, for tests to stand in for.
 */
export async function pointOfMapLink(
  text: string,
  fetcher: typeof fetch = fetch,
): Promise<MapPoint | null> {
  const typed = text.trim().slice(0, MAP_LINK_LIMITS.length);
  if (!typed) return null;
  const direct = pointInText(typed);
  if (direct) return direct;
  let next = typed;
  for (let hop = 0; hop < MAP_LINK_LIMITS.redirects; hop++) {
    let url: URL;
    try {
      url = new URL(next);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || !SHORT_HOSTS.has(url.hostname)) return null;
    let location: string | null;
    try {
      const response = await fetcher(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(MAP_LINK_LIMITS.timeoutMs),
      });
      location = response.headers.get('location');
    } catch {
      return null;
    }
    if (!location) return null;
    const found = pointInText(location);
    if (found) return found;
    next = new URL(location, url).toString();
  }
  return null;
}
