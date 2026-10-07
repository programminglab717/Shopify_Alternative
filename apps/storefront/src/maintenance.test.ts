import { describe, expect, it } from 'vitest';
import { sampleStore } from './fixtures.js';
import { RETRY_AFTER, maintenancePage, retryAfterOf } from './maintenance.js';

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
