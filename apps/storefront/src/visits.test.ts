import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  VISITS_COOKIE,
  VISITS_SCRIPT,
  VISIT_LIMITS,
  keptVisits,
  storefrontVisits,
  visitsAfter,
  visitsCookie,
  withCampaign,
  type KeptVisit,
} from './visits.js';

const NOW = Math.floor(Date.parse('2026-10-02T12:00:00Z') / 1000);
const DAY = 24 * 60 * 60;
const HOST = 'zari.pk';

/** A page of the shop's loaded in a browser, its head's script run, with the cookie it had. */
function load(cookie: string | null, href: string, referrer: string, now: number) {
  const url = new URL(href);
  const jar = { value: cookie ? `other=1; ${VISITS_COOKIE}=${cookie}` : 'other=1', set: '' };
  const document = {
    referrer,
    get cookie() {
      return jar.value;
    },
    set cookie(value: string) {
      jar.set = value;
    },
  };
  const location = {
    host: url.host,
    pathname: url.pathname,
    search: url.search,
    protocol: url.protocol,
  };
  runInNewContext(VISITS_SCRIPT, {
    document,
    location,
    URL,
    atob,
    btoa,
    Date: { now: () => now * 1000 },
  });
  return jar.set;
}

/** The cookie's value, as a Set-Cookie of the script's or the server's has it. */
function valueOf(setCookie: string): string {
  return setCookie.slice(VISITS_COOKIE.length + 1, setCookie.indexOf(';'));
}

describe('visits', () => {
  it("keeps the first visit and the last from elsewhere, as the pages' script does", () => {
    // Each step: the page loaded, the site linking to it, and whether the visits change.
    const steps: [href: string, referrer: string, changes: boolean][] = [
      // The first, from an ad: kept, whatever it is.
      [
        'https://zari.pk/products/lawn?utm_source=facebook&fbclid=Iw1',
        'https://l.facebook.com/x?u=1',
        true,
      ],
      // Page to page on the shop, and back to it straight: nothing.
      ['https://zari.pk/collections/eid', 'https://zari.pk/products/lawn', false],
      ['https://zari.pk/', '', false],
      // From another site: the last.
      ['https://zari.pk/pages/about', 'https://www.google.com/', true],
      // A tagged link opened straight, as from WhatsApp: the last, the first kept.
      ['https://zari.pk/?utm_source=whatsapp&utm_campaign=broadcast', '', true],
    ];
    let cookie: string | null = null;
    let kept: KeptVisit[] = [];
    steps.forEach(([href, referrer, changes], step) => {
      const now = NOW + step * 60;
      const url = new URL(href);
      const after = visitsAfter(
        kept,
        { path: `${url.pathname}${url.search}`, host: HOST, referrer: referrer || undefined },
        now,
      );
      const set = load(cookie, href, referrer, now);
      expect([step, after !== null]).toEqual([step, changes]);
      expect([step, set !== '']).toEqual([step, changes]);
      if (!after) return;
      // The script and the server write the same cookie.
      expect(set).toBe(visitsCookie(after, { secure: true }));
      cookie = valueOf(set);
      kept = keptVisits(cookie, now);
      expect(kept).toEqual(after);
    });
    expect(kept).toEqual([
      [NOW, '/products/lawn?utm_source=facebook&fbclid=Iw1', 'https://l.facebook.com/x'],
      [NOW + 4 * 60, '/?utm_source=whatsapp&utm_campaign=broadcast', ''],
    ]);
    expect(storefrontVisits(kept, 'https://zari.pk')).toEqual([
      {
        occurredAt: '2026-10-02T12:00:00.000Z',
        landingPage: 'https://zari.pk/products/lawn?utm_source=facebook&fbclid=Iw1',
        referrerUrl: 'https://l.facebook.com/x',
      },
      {
        occurredAt: '2026-10-02T12:04:00.000Z',
        landingPage: 'https://zari.pk/?utm_source=whatsapp&utm_campaign=broadcast',
        referrerUrl: null,
      },
    ]);
  });

  it('forgets visits older than the cookie keeps them, and cookies it cannot read', () => {
    const old: KeptVisit = [NOW - 31 * DAY, '/old', ''];
    const recent: KeptVisit = [NOW - DAY, '/recent', 'https://www.instagram.com/'];
    const cookie = valueOf(visitsCookie([old, recent], { secure: false }));
    expect(keptVisits(cookie, NOW)).toEqual([recent]);
    // The first is gone, so the last of those kept is the first now, as the script has it.
    const set = load(cookie, 'https://zari.pk/', 'https://www.google.com/', NOW);
    expect(keptVisits(valueOf(set), NOW)).toEqual([recent, [NOW, '/', 'https://www.google.com/']]);
    for (const bad of [null, '', 'not base64!', 'e30', 'W1sxLDIsM11d', 'x'.repeat(5000)]) {
      expect(keptVisits(bad, NOW)).toEqual([]);
    }
    // A cookie the script cannot read is a first visit to it.
    expect(keptVisits(valueOf(load('@@@', 'https://zari.pk/', '', NOW)), NOW)).toEqual([
      [NOW, '/', ''],
    ]);
  });

  it('keeps no more of a page or a referrer than its limits, and only over https as secure', () => {
    const long = `/search?q=${'x'.repeat(2000)}&utm_source=ig`;
    const after = visitsAfter(
      [],
      { path: long, host: HOST, referrer: `https://a.pk/${'y'.repeat(900)}` },
      NOW,
    )!;
    expect(after[0]![1]).toHaveLength(VISIT_LIMITS.landing);
    expect(after[0]![2]).toHaveLength(VISIT_LIMITS.referrer);
    expect(visitsCookie(after, { secure: false })).not.toContain('Secure');
    expect(load(null, 'http://zari.pk/', '', NOW)).not.toContain('Secure');
    // A referrer that is no web page is none.
    expect(
      visitsAfter(after, { path: '/', host: HOST, referrer: 'android-app://com.x/' }, NOW),
    ).toBeNull();
  });

  it("counts the shop's own requests, as its cart's checkout button, only when sent from elsewhere", () => {
    const own = { path: '/cart', host: HOST, referrer: 'https://zari.pk/cart', landed: false };
    expect(visitsAfter([], own, NOW)).toBeNull();
    expect(visitsAfter([], { ...own, referrer: undefined }, NOW)).toBeNull();
    expect(visitsAfter([], { ...own, path: '/checkout?utm_source=sms' }, NOW)).toEqual([
      [NOW, '/checkout?utm_source=sms', ''],
    ]);
    // A page, or a cart permalink, is where the shopper landed, whatever brought them.
    expect(visitsAfter([], { ...own, landed: true }, NOW)).toEqual([[NOW, '/cart', '']]);
  });

  it("carries a discount link's campaign on to the page it leads to", () => {
    const query = new URLSearchParams('redirect=/products/lawn&utm_source=ig&fbclid=F1&x=1');
    expect(withCampaign('/products/lawn', query)).toBe('/products/lawn?utm_source=ig&fbclid=F1');
    expect(withCampaign('/?utm_source=own', query)).toBe('/?utm_source=own&fbclid=F1');
    expect(withCampaign('/ur', new URLSearchParams('redirect=/ur'))).toBe('/ur');
  });
});
