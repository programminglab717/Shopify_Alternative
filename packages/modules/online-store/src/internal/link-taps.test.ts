import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LinkTapsService, linkHash } from './link-taps.service.js';
import { linkTaps } from './schema.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Taps on the link page's links (ADR-204)", () => {
  let f: OnlineStoreFixture;
  let taps: LinkTapsService;
  const instagram = 'https://www.instagram.com/zari.pk';
  const sale = '/collections/eid-lawn';
  const chat = 'https://wa.me/923001234567';
  /** 4 and 5 October in Karachi, from midnight to midnight. */
  const period = {
    from: new Date('2026-10-03T19:00:00Z'),
    before: new Date('2026-10-05T19:00:00Z'),
  };

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
    taps = new LinkTapsService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM online_store.link_taps');
  });

  it('matches the migrated table', async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(linkTaps).limit(1));
  });

  it("keeps each day's taps by where each link goes, the latest in place of the last", async () => {
    const long = `https://example.pk/${'سیل'.repeat(1_000)}`;
    await taps.keep(f.a.shopId, '2026-10-04', { [instagram]: 5, [sale]: 2 });
    await taps.keep(f.a.shopId, '2026-10-05', { [instagram]: 1 });
    await taps.keep(f.a.shopId, '2026-10-05', { [instagram]: 4, [chat]: 3, [long]: 1 });
    // Nothing to keep: no taps, or none counted.
    await taps.keep(f.a.shopId, '2026-10-05', {});
    await taps.keep(f.a.shopId, '2026-10-05', { '/pages/about': 0 });
    const { rows } = await f.admin.query<{ day: string; link: string; url: string; taps: number }>(
      `SELECT day::text, link, url, taps FROM online_store.link_taps WHERE shop_id = $1
        ORDER BY day, taps DESC`,
      [f.a.shopId],
    );
    expect(rows.map((row) => [row.day, row.url, row.taps])).toEqual([
      ['2026-10-04', instagram, 5],
      ['2026-10-04', sale, 2],
      ['2026-10-05', instagram, 4],
      ['2026-10-05', chat, 3],
      ['2026-10-05', long, 1],
    ]);
    // Each by its address's SHA-256, however long the address.
    expect(rows.map((row) => row.link)).toEqual(rows.map((row) => linkHash(row.url)));
    expect(linkHash(instagram)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports the page's links by their taps, its chat on WhatsApp and links taken off among them", async () => {
    unwrap(
      await f.preferences.update(f.a, {
        whatsappNumber: '0300 1234567',
        linkPage: {
          links: [
            { title: 'Eid sale', url: sale },
            { title: 'Instagram', url: instagram },
            { title: 'Our story', url: '/pages/about' },
            // On the page twice: counted once, as the first.
            { title: 'Insta again', url: instagram },
          ],
        },
      }),
    );
    await taps.keep(f.a.shopId, '2026-10-04', { [instagram]: 5, [sale]: 3, '/collections/old': 4 });
    await taps.keep(f.a.shopId, '2026-10-05', { [instagram]: 4, [chat]: 3 });
    // The day after the period, and another shop's.
    await taps.keep(f.a.shopId, '2026-10-06', { [sale]: 50 });
    await taps.keep(f.b.shopId, '2026-10-05', { [sale]: 99 });
    expect(unwrap(await taps.report(f.a, period))).toEqual({
      total: 19,
      // The most tapped first, then in the page's order: its links, its chat, those taken off.
      links: [
        { url: instagram, title: 'Instagram', source: 'link', taps: 9 },
        { url: '/collections/old', title: null, source: 'removed', taps: 4 },
        { url: sale, title: 'Eid sale', source: 'link', taps: 3 },
        { url: chat, title: null, source: 'whatsapp', taps: 3 },
        { url: '/pages/about', title: 'Our story', source: 'link', taps: 0 },
      ],
    });
    // Another shop's are its own: with no link page, its taps are of links taken off.
    expect(unwrap(await taps.report(f.b, period))).toEqual({
      total: 99,
      links: [{ url: sale, title: null, source: 'removed', taps: 99 }],
    });
  });

  it('refuses a period that ends before it begins, or longer than a year', async () => {
    const from = new Date('2026-10-05T00:00:00Z');
    expect(errorsOf(await taps.report(f.a, { from, before: from }))).toEqual([
      ['before', 'INVALID', 'Before must be later than from'],
    ]);
    const long = new Date(from.getTime() + 367 * 86_400_000);
    expect(errorsOf(await taps.report(f.a, { from, before: long }))).toEqual([
      ['before', 'INVALID', 'A report covers at most 366 days at a time'],
    ]);
  });
});
