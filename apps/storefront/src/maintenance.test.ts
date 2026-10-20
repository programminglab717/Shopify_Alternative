import { describe, expect, it } from 'vitest';
import { sampleStore } from './fixtures.js';
import { RETRY_AFTER, checkoutPausedBar, maintenancePage, retryAfterOf } from './maintenance.js';
import { checkoutPausedAt } from '@hatti/storefront-data';
import { shopObject } from './objects.js';

describe('A paused shop (ADR-252)', () => {
  const now = new Date('2026-10-07T10:00:00Z');
  const opensIn = (ms: number) => ({
    message: '',
    until: new Date(now.getTime() + ms).toISOString(),
  });

  it('asks to be asked again when it opens, between a minute and a day; in an hour without a time', () => {
    expect(retryAfterOf({ message: '', until: null }, now)).toBe(RETRY_AFTER.unknown);
    expect(retryAfterOf(opensIn(90 * 60_000), now)).toBe(5_400);
    expect(retryAfterOf(opensIn(5_000), now)).toBe(RETRY_AFTER.min);
    expect(retryAfterOf(opensIn(3 * 86_400_000), now)).toBe(RETRY_AFTER.max);
  });

  it("says when it opens in the shop's time zone, under its logo, with what it typed as typed", () => {
    const shop = {
      ...sampleStore().shop,
      timezone: 'Asia/Karachi',
      whatsapp: null,
      brand: { logo: 'https://cdn.hatti.test/zari/logo.png?v=2', squareLogo: null },
    };
    const page = maintenancePage(
      shop,
      { message: 'Stock-take <today>.\nBack soon.', until: '2026-10-12T04:00:00.000Z' },
      { urdu: true },
    );
    expect(page.html).toContain('It takes orders again from 12 October 2026 at 9:00 am.');
    expect(page.html).toContain('<bdi dir="ltr">12 October 2026 at 9:00 am</bdi>');
    expect(page.html).toContain('<img class="logo" src="https://cdn.hatti.test/zari/logo.png?v=2"');
    expect(page.contentSecurityPolicy).toContain('img-src https://cdn.hatti.test/zari/logo.png');
    expect(page.html).toContain('Stock-take &lt;today&gt;.<br />Back soon.');
    expect(page.html).toContain('href="/ur/track"');
    expect(page.html).not.toContain('wa.me');
  });
});

describe('A shop whose checkout alone is paused (ADR-603, ADR-604)', () => {
  const shop = { ...sampleStore().shop, timezone: 'Asia/Karachi' };
  const pause = {
    message: 'Eid break <3>:\n couriers are off.',
    until: '2026-10-12T04:00:00.000Z',
    checkoutOnly: true as const,
  };

  it("bars its pages with what it typed and when it takes orders, in the page's language", () => {
    const bar = checkoutPausedBar(shop, pause, 'en');
    expect(bar).toContain('<strong>Orders are paused for a while.</strong>');
    expect(bar).toContain('<span dir="auto">Eid break &lt;3&gt;: couriers are off.</span>');
    expect(bar).toContain('We take orders again from 12 October 2026 at 9:00 am.');
    // Gone by itself once the time comes, from a page kept in a cache, with the theme's own
    // notice; standing aside for that notice before (ADR-620).
    expect(bar).toContain(
      `if(Date.now()>=${Date.parse(pause.until)}){document.querySelectorAll("[data-checkout-paused]")` +
        '.forEach(function(own){own.remove()});return}',
    );
    expect(bar).toContain('if(document.querySelector("[data-checkout-paused]"))return;');
    const urdu = checkoutPausedBar(shop, { ...pause, message: '', until: null }, 'ur');
    expect(urdu).toContain('dir="rtl"');
    expect(urdu).toContain('آرڈر کچھ دیر کے لیے بند ہیں۔');
    expect(urdu).toContain('ہم جلد دوبارہ آرڈر لیں گے۔');
    expect(urdu).not.toContain('Date.now()');
  });

  it('gives themes what it paused as shop.checkout_paused, while it is (ADR-620)', () => {
    const before = new Date('2026-10-12T03:59:00Z');
    const paused = { ...shop, maintenance: pause };
    const at = (doc: typeof shop, now: Date) => shopObject(doc, undefined, undefined, now);
    expect(at(paused, before).checkout_paused).toEqual({
      message: 'Eid break <3>:\n couriers are off.',
      until: '2026-10-12T04:00:00.000Z',
    });
    expect(at(paused, new Date('2026-10-12T04:00:00Z')).checkout_paused).toBeNull();
    // Not while the whole storefront is paused, whose page is the platform's; nor while open.
    expect(
      at({ ...shop, maintenance: { message: '', until: null } }, before).checkout_paused,
    ).toBeNull();
    expect(at(shop, before).checkout_paused).toBeNull();
  });

  it("is paused until the time it set, and only where the pause is checkout's alone", () => {
    const before = new Date('2026-10-12T03:59:00Z');
    const after = new Date('2026-10-12T04:00:00Z');
    expect(checkoutPausedAt(pause, before)).toBe(true);
    expect(checkoutPausedAt(pause, after)).toBe(false);
    expect(checkoutPausedAt({ ...pause, until: null }, after)).toBe(true);
    expect(checkoutPausedAt({ message: '', until: null }, before)).toBe(false);
    expect(checkoutPausedAt(undefined, before)).toBe(false);
  });
});
