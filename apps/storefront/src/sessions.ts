// A shop's sessions, as Shopify's analytics count them (ANL-02, ADR-180): a session is a browser's
// visit, its pages with no half hour between them. Pages are kept at the edge and are the same
// for every shopper, so a script in each page's head keeps the session's ID in a cookie of the
// shop's, made when there is none and kept for half an hour from each page, and tells the
// storefront of the page; the storefront counts the session's cart, checkout and order itself,
// from the same cookie.

/** The cookie keeping a session's ID: 22 URL-safe characters, random. */
export const SESSION_COOKIE = 'hatti_session';

/** How long a session lasts after its last page. */
export const SESSION_MINUTES = 30;

/** Where a page's script tells the storefront it was seen. */
export const VISIT_PATH = '/.hatti/visit';

const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** The session's ID a request's cookies keep, or null for none, or one not an ID. */
export function sessionOf(cookies: string | undefined): string | null {
  const found = /(?:^|;\s*)hatti_session=([^;]*)/.exec(cookies ?? '')?.[1];
  return found && SESSION_ID.test(found) ? found : null;
}

/** Crawlers and tools that run pages' scripts, whose pages are no shopper's. */
const ROBOTS = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit/i;

/** Whether `userAgent` is a robot's, or says nothing: no session of a shopper's. */
export function isRobot(userAgent: string | undefined): boolean {
  return !userAgent || ROBOTS.test(userAgent);
}

/**
 * The script each shopper's page carries: classic, small, and silent when anything fails, as
 * when cookies are blocked.
 */
export const SESSION_SCRIPT = `(function () {
  try {
    var found = document.cookie.match(/(?:^|;\\s*)${SESSION_COOKIE}=([\\w-]{16,64})(?:;|$)/);
    var id = found && found[1];
    if (!id) {
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      id = btoa(String.fromCharCode.apply(null, bytes))
        .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    }
    document.cookie = '${SESSION_COOKIE}=' + id + '; Max-Age=${SESSION_MINUTES * 60}; Path=/; SameSite=Lax' +
      (location.protocol === 'https:' ? '; Secure' : '');
    if (navigator.sendBeacon) navigator.sendBeacon('${VISIT_PATH}');
    else fetch('${VISIT_PATH}', { method: 'POST', keepalive: true });
  } catch (error) {}
})();`;
