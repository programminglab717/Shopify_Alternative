import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_LIMITS,
  attributionOf,
  daysToConversion,
  platformOf,
  toAttributionRecord,
} from './attribution.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');

function visit(landingPage: string, referrerUrl: string | null = null, occurredAt = NOW) {
  return { occurredAt: occurredAt.toISOString(), landingPage, referrerUrl };
}

describe('attributionOf', () => {
  it('keeps the first visit and the last, with where each came from and its UTM parameters', () => {
    const first = visit(
      'https://zari.pk/products/lawn?utm_source=Facebook&utm_medium=paid_social' +
        '&utm_campaign=eid-sale&utm_content=red%20kurta&fbclid=IwAR0abc#reviews',
      'https://l.facebook.com/l.php?u=https%3A%2F%2Fzari.pk',
      new Date('2026-09-28T08:00:00.000Z'),
    );
    const last = visit('https://zari.pk/', 'https://www.google.com.pk/search?q=zari');
    expect(attributionOf([first, last], NOW)).toEqual({
      first: {
        at: '2026-09-28T08:00:00.000Z',
        // The link's own tag, in lower case.
        source: 'facebook',
        utm: {
          source: 'Facebook',
          medium: 'paid_social',
          campaign: 'eid-sale',
          term: null,
          content: 'red kurta',
        },
        // Without the part after #, which no server sees; the other site's page without its query.
        landingPage:
          'https://zari.pk/products/lawn?utm_source=Facebook&utm_medium=paid_social' +
          '&utm_campaign=eid-sale&utm_content=red%20kurta&fbclid=IwAR0abc',
        referrer: 'https://l.facebook.com/l.php',
      },
      last: {
        at: NOW.toISOString(),
        source: 'google',
        utm: null,
        landingPage: 'https://zari.pk/',
        referrer: 'https://www.google.com.pk/search',
      },
    });
  });

  it('names where a visit came from by its tag, its ad, the site linking to it, or none', () => {
    const sourceOf = (landingPage: string, referrer: string | null = null) =>
      attributionOf([visit(landingPage, referrer)], NOW)?.first.source;
    // An ad's click ID, from the platform linking to it if known, else the ad's.
    expect(sourceOf('https://zari.pk/?fbclid=x', 'https://l.instagram.com/')).toBe('instagram');
    expect(sourceOf('https://zari.pk/?fbclid=x')).toBe('facebook');
    expect(sourceOf('https://zari.pk/?gclid=x', 'https://example.com/')).toBe('google');
    expect(sourceOf('https://zari.pk/?ttclid=x')).toBe('tiktok');
    // Another site: a platform's by name, any other by its domain.
    expect(sourceOf('https://zari.pk/', 'https://m.youtube.com/watch')).toBe('youtube');
    expect(sourceOf('https://zari.pk/', 'https://t.co/abc')).toBe('x');
    expect(sourceOf('https://zari.pk/', 'https://www.fashionblog.pk/eid')).toBe('fashionblog.pk');
    // Tagged by the shop, whatever links to it.
    expect(sourceOf('https://zari.pk/?utm_source=WhatsApp', 'https://zari.pk/')).toBe('whatsapp');
    expect(sourceOf('https://zari.pk/')).toBe('direct');
    // A page of the shop's own is no other site.
    expect(attributionOf([visit('https://zari.pk/a', 'https://zari.pk/b')], NOW)).toEqual({
      first: expect.not.objectContaining({ referrer: expect.anything() }),
      last: expect.not.objectContaining({ referrer: expect.anything() }),
    });
  });

  it('knows platforms by their domains, and no look-alike', () => {
    expect(platformOf('www.google.co.uk')).toBe('google');
    expect(platformOf('google.com')).toBe('google');
    expect(platformOf('google.example.com')).toBeNull();
    expect(platformOf('lm.facebook.com')).toBe('facebook');
    expect(platformOf('notfacebook.com')).toBeNull();
    expect(platformOf('WA.ME')).toBe('whatsapp');
  });

  it('is one visit for both when one is given, and none when none checks out', () => {
    const only = attributionOf([visit('https://zari.pk/?utm_campaign=eid')], NOW)!;
    expect(only.last).toEqual(only.first);
    expect(only.first.utm).toEqual({
      source: null,
      medium: null,
      campaign: 'eid',
      term: null,
      content: null,
    });
    expect(attributionOf(undefined, NOW)).toBeNull();
    expect(attributionOf([], NOW)).toBeNull();
    expect(attributionOf({ visits: [] }, NOW)).toBeNull();
    const old = new Date(NOW.getTime() - 31 * 24 * 60 * 60_000);
    const ahead = new Date(NOW.getTime() + 10 * 60_000);
    for (const bad of [
      null,
      'https://zari.pk/',
      visit('javascript:alert(1)'),
      visit('zari.pk/products'),
      visit('https://zari.pk/', null, old),
      visit('https://zari.pk/', null, ahead),
      { ...visit('https://zari.pk/'), occurredAt: 'yesterday' },
      { ...visit('https://zari.pk/'), landingPage: 42 },
    ]) {
      expect(attributionOf([bad], NOW)).toBeNull();
    }
    // A visit that does not check out leaves the one that does; a clock a little ahead is now.
    const slightly = new Date(NOW.getTime() + 60_000);
    expect(
      attributionOf([visit('ftp://zari.pk/'), visit('https://zari.pk/x', null, slightly)], NOW),
    ).toEqual({
      first: expect.objectContaining({ at: NOW.toISOString(), landingPage: 'https://zari.pk/x' }),
      last: expect.objectContaining({ at: NOW.toISOString(), landingPage: 'https://zari.pk/x' }),
    });
  });

  it('takes the first and the last given, in the order they were, within limits', () => {
    const at = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60_000);
    const visits = [
      visit('https://zari.pk/c', null, at(1)),
      visit('https://zari.pk/b', null, at(2)),
      visit('https://zari.pk/a', null, at(3)),
    ];
    const kept = attributionOf(visits, NOW)!;
    expect([kept.first.landingPage, kept.last.landingPage]).toEqual([
      'https://zari.pk/a',
      'https://zari.pk/c',
    ]);
    const long = 'x'.repeat(3000);
    const huge = attributionOf(
      [visit(`https://zari.pk/?utm_campaign=${long}&p=${long}`, `https://site.pk/${long}`)],
      NOW,
    )!;
    expect(huge.first.landingPage).toHaveLength(ATTRIBUTION_LIMITS.landingPage);
    expect(huge.first.referrer).toHaveLength(ATTRIBUTION_LIMITS.referrer);
    expect(huge.first.utm?.campaign).toHaveLength(ATTRIBUTION_LIMITS.utm);
    // Letters no report should show are dropped.
    const control = String.fromCharCode(7);
    const tagged = attributionOf([visit(`https://zari.pk/?utm_term=lawn${control}%0Asuits`)], NOW);
    expect(tagged?.first.utm?.term).toBe('lawnsuits');
  });

  it('reads as the Admin API gives it, with the whole days it took', () => {
    const first = visit('https://zari.pk/', null, new Date('2026-09-29T13:00:00.000Z'));
    const attribution = attributionOf([first], NOW)!;
    expect(daysToConversion(attribution, NOW)).toBe(2);
    expect(toAttributionRecord('o1', attribution, NOW)).toEqual({
      orderId: 'o1',
      firstVisit: {
        occurredAt: new Date('2026-09-29T13:00:00.000Z'),
        source: 'direct',
        utm: null,
        landingPage: 'https://zari.pk/',
        referrerUrl: null,
      },
      lastVisit: expect.objectContaining({ source: 'direct' }),
      daysToConversion: 2,
    });
    // Erased, the pages are gone.
    const erased = { first: { ...attribution.first }, last: { ...attribution.last } };
    delete erased.first.landingPage;
    expect(toAttributionRecord('o1', erased, NOW).firstVisit.landingPage).toBeNull();
  });
});
