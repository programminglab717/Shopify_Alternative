import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { searchContentIn } from './content-search.js';
import type { PageRecord } from './records.js';
import { pages } from './schema.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';
import { shopRedirectsOf } from './url-redirect.service.js';

const server = testDatabaseServer();

describe.skipIf(!server)('PageService', () => {
  let f: OnlineStoreFixture;

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  const events = async () =>
    (await f.outbox()).map((event) => [event.event_type, event.payload] as const);

  it('matches the migrated table', async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(pages).limit(1));
  });

  it('keeps a page with a handle from its title, and a body cleaned of anything that runs', async () => {
    const about = unwrap(
      await f.pages.create(f.a, {
        title: 'About Us & Our Story',
        body: '<h2>Since 1998</h2><p onclick="x()">Hand-made in Multan.<script>x()</script></p>',
      }),
    );
    expect(about).toMatchObject({
      handle: 'about-us-and-our-story',
      title: 'About Us & Our Story',
      body: '<h2>Since 1998</h2><p>Hand-made in Multan.</p>',
      isPublished: true,
      templateSuffix: null,
    });
    expect(about.publishedAt).toBeInstanceOf(Date);
    expect(await f.pages.get(f.a, about.id)).toEqual(about);

    // Titles alike take the next handle; one without Latin letters, "page".
    const again = unwrap(await f.pages.create(f.a, { title: 'About us & our story!' }));
    expect(again.handle).toBe('about-us-and-our-story-2');
    const urdu = unwrap(await f.pages.create(f.a, { title: 'ہمارے بارے میں' }));
    expect(urdu.handle).toBe('page');
    // A handle given is made one as the catalog makes them, and kept to the page.
    const contact = unwrap(
      await f.pages.create(f.a, {
        title: 'Contact',
        handle: 'Contact Us',
        isPublished: false,
        templateSuffix: 'contact',
      }),
    );
    expect(contact).toMatchObject({
      handle: 'contact-us',
      isPublished: false,
      publishedAt: null,
      templateSuffix: 'contact',
    });
    expect(
      errorsOf(await f.pages.create(f.a, { title: 'Reach us', handle: 'contact-us' })),
    ).toEqual([['handle', 'TAKEN', 'Handle "contact-us" is another page\'s']]);
    expect(await events()).toEqual([
      ['page.created', { handle: 'about-us-and-our-story', isPublished: true }],
      ['page.created', { handle: 'about-us-and-our-story-2', isPublished: true }],
      ['page.created', { handle: 'page', isPublished: true }],
      ['page.created', { handle: 'contact-us', isPublished: false }],
    ]);
  });

  it('says what is wrong with a page, and keeps none of it', async () => {
    expect(
      errorsOf(
        await f.pages.create(f.a, {
          title: ' ',
          handle: '---',
          body: `<p>${'x'.repeat(530_000)}</p>`,
          templateSuffix: 'Contact Page',
        }),
      ),
    ).toEqual([
      ['title', 'BLANK', "Title can't be blank"],
      ['handle', 'INVALID', 'Handle must contain letters or digits'],
      ['body', 'TOO_LONG', 'Body is too long (maximum is 512 KB)'],
      [
        'templateSuffix',
        'INVALID',
        expect.stringContaining('may have only lower-case letters, digits, hyphens'),
      ],
    ]);
    expect((await f.pages.list(f.a, { first: 50 })).items).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it('changes the fields given, saying which, and nothing when nothing changes', async () => {
    const page = unwrap(await f.pages.create(f.a, { title: 'Returns', body: '<p>7 days</p>' }));
    const firstPublished = page.publishedAt!;
    const hidden = unwrap(
      await f.pages.update(f.a, page.id, { body: '<p>14 days</p>', isPublished: false }),
    );
    expect(hidden).toMatchObject({
      title: 'Returns',
      handle: 'returns',
      body: '<p>14 days</p>',
      isPublished: false,
      publishedAt: null,
    });
    unwrap(await f.pages.update(f.a, page.id, { body: '<p>14 days</p>' }));
    const shown = unwrap(
      await f.pages.update(f.a, page.id, {
        title: 'Returns and exchanges',
        handle: 'Returns & Exchanges',
        isPublished: true,
        templateSuffix: '',
      }),
    );
    expect(shown).toMatchObject({ handle: 'returns-and-exchanges', isPublished: true });
    expect(shown.publishedAt!.getTime()).toBeGreaterThanOrEqual(firstPublished.getTime());
    expect(shown.updatedAt.getTime()).toBeGreaterThanOrEqual(hidden.updatedAt.getTime());
    expect((await events()).slice(1)).toEqual([
      ['page.updated', { handle: 'returns', isPublished: false, changed: ['body', 'isPublished'] }],
      [
        'page.updated',
        {
          handle: 'returns-and-exchanges',
          isPublished: true,
          changed: ['title', 'handle', 'isPublished'],
        },
      ],
    ]);

    const other = unwrap(await f.pages.create(f.a, { title: 'Delivery' }));
    expect(
      errorsOf(await f.pages.update(f.a, other.id, { handle: 'returns-and-exchanges' })),
    ).toEqual([['handle', 'TAKEN', 'Handle "returns-and-exchanges" is another page\'s']]);
    expect(errorsOf(await f.pages.update(f.a, other.id, { title: '' }))).toEqual([
      ['title', 'BLANK', "Title can't be blank"],
    ]);
    expect(errorsOf(await f.pages.update(f.a, newId(), { title: 'Gone' }))).toEqual([
      ['id', 'NOT_FOUND', 'Page not found'],
    ]);
  });

  it("sends shoppers from a page's old address to its new one when asked, with the change", async () => {
    const page = unwrap(await f.pages.create(f.a, { title: 'Returns' }));
    unwrap(await f.pages.update(f.a, page.id, { handle: 'returns-policy' }));
    unwrap(await f.pages.update(f.a, page.id, { handle: 'refunds', redirectNewHandle: true }));
    // Not asked the first time: only the second address is sent on.
    const redirects = () => f.db.tenant(f.a.shopId, (tx) => shopRedirectsOf(tx, f.a.shopId));
    expect(await redirects()).toEqual([
      { path: '/pages/returns-policy', target: '/pages/refunds' },
    ]);
    unwrap(await f.pages.update(f.a, page.id, { handle: 'returns', redirectNewHandle: true }));
    expect(await redirects()).toEqual([
      { path: '/pages/refunds', target: '/pages/returns' },
      { path: '/pages/returns-policy', target: '/pages/returns' },
    ]);
    // A handle taken refuses the change, and writes no redirect.
    unwrap(await f.pages.create(f.a, { title: 'Delivery' }));
    expect(
      errorsOf(
        await f.pages.update(f.a, page.id, { handle: 'delivery', redirectNewHandle: true }),
      )[0]?.[1],
    ).toBe('TAKEN');
    expect(await redirects()).toHaveLength(2);
    expect((await events()).filter(([type]) => type.startsWith('url_redirect.'))).toEqual([
      ['url_redirect.created', { path: '/pages/returns-policy', target: '/pages/refunds' }],
      ['url_redirect.updated', { path: '/pages/returns-policy', target: '/pages/returns' }],
      ['url_redirect.created', { path: '/pages/refunds', target: '/pages/returns' }],
    ]);
  });

  it('publishes a page at a time ahead, hidden until then and shown once by the worker (ADR-217)', async () => {
    const tomorrow = new Date(Math.ceil(Date.now() / 1000) * 1000 + 86_400_000);
    const sale = unwrap(
      await f.pages.create(f.a, {
        title: 'Eid sale',
        body: '<p>Lawn at half price.</p>',
        publishDate: tomorrow,
      }),
    );
    expect(sale).toMatchObject({ isPublished: false, publishedAt: tomorrow });
    const found = () =>
      f.db.tenant(
        f.a.shopId,
        async (tx) => (await searchContentIn(tx, f.a.shopId, 'lawn', { limit: 10 })).pageIds,
      );
    expect(await found()).toEqual([]);
    expect(await f.pages.shopsWithPagesDue()).not.toContain(f.a.shopId);
    expect(await f.pages.showDue(f.a.shopId)).toBe(0);

    // Its time come: shown, the worker saying so once.
    await f.admin.query(
      "UPDATE online_store.pages SET published_at = now() - interval '1 minute' WHERE id = $1",
      [sale.id],
    );
    expect((await f.pages.get(f.a, sale.id))?.isPublished).toBe(true);
    expect(await f.pages.shopsWithPagesDue()).toContain(f.a.shopId);
    expect(await f.pages.showDue(f.a.shopId)).toBe(1);
    expect(await f.pages.showDue(f.a.shopId)).toBe(0);
    expect(await found()).toEqual([sale.id]);
    const said = (await events()).filter(([type]) => type.startsWith('page.'));
    expect(said).toEqual([
      ['page.created', { handle: 'eid-sale', isPublished: false }],
      ['page.updated', { handle: 'eid-sale', isPublished: true, changed: ['isPublished'] }],
    ]);

    // Moved ahead again, and a date gone by, as one written before: shown now.
    const moved = unwrap(await f.pages.update(f.a, sale.id, { publishDate: tomorrow }));
    expect(moved.isPublished).toBe(false);
    const back = unwrap(
      await f.pages.update(f.a, sale.id, { publishDate: new Date('2026-01-01T00:00:00Z') }),
    );
    expect(back).toMatchObject({
      isPublished: true,
      publishedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(
      (await events()).slice(-2).map(([, payload]) => (payload as { changed: string[] }).changed),
    ).toEqual([
      ['isPublished', 'publishedAt'],
      ['isPublished', 'publishedAt'],
    ]);
    expect(
      errorsOf(
        await f.pages.create(f.a, {
          title: 'Later',
          publishDate: new Date(Date.now() + 400 * 86_400_000),
        }),
      ),
    ).toEqual([['publishDate', 'INVALID', "Publish date can't be more than a year ahead"]]);
  });

  it('deletes a page, saying so for the storefront and menus', async () => {
    const page = unwrap(await f.pages.create(f.a, { title: 'Size guide' }));
    expect(unwrap(await f.pages.delete(f.a, page.id))).toEqual({ id: page.id });
    expect(await f.pages.get(f.a, page.id)).toBeNull();
    expect(errorsOf(await f.pages.delete(f.a, page.id))).toEqual([
      ['id', 'NOT_FOUND', 'Page not found'],
    ]);
    expect((await events()).at(-1)).toEqual([
      'page.deleted',
      { handle: 'size-guide', isPublished: true },
    ]);
  });

  it('lists pages oldest first, a page at a time, and gives read models them by ID', async () => {
    const made: PageRecord[] = [];
    for (const title of ['About', 'Contact', 'Delivery', 'Returns', 'Size guide']) {
      made.push(unwrap(await f.pages.create(f.a, { title })));
    }
    const first = await f.pages.list(f.a, { first: 2 });
    expect([first.items.map((page) => page.title), first.hasNextPage]).toEqual([
      ['About', 'Contact'],
      true,
    ]);
    const rest = await f.pages.list(f.a, { first: 5, after: first.items[1]!.id });
    expect([rest.items.map((page) => page.title), rest.hasNextPage]).toEqual([
      ['Delivery', 'Returns', 'Size guide'],
      false,
    ]);
    const read = await f.db.tenant(f.a.shopId, async (tx) => ({
      some: await f.pages.pagesOf(tx, f.a.shopId, { ids: [made[3]!.id, made[0]!.id, newId()] }),
      none: await f.pages.pagesOf(tx, f.a.shopId, { ids: [] }),
      ids: await f.pages.idsOf(tx, f.a.shopId),
    }));
    expect(read.some.map((page) => page.title)).toEqual(['About', 'Returns']);
    expect(read.none).toEqual([]);
    expect(read.ids.sort()).toEqual(made.map((page) => page.id).sort());
  });

  it("keeps each shop's pages to itself", async () => {
    const theirs = unwrap(await f.pages.create(f.b, { title: 'About' }));
    // Handles are the shop's own: another shop has its own "about".
    expect(unwrap(await f.pages.create(f.a, { title: 'About' })).handle).toBe('about');
    expect(await f.pages.get(f.a, theirs.id)).toBeNull();
    expect(errorsOf(await f.pages.update(f.a, theirs.id, { title: 'Mine' }))).toEqual([
      ['id', 'NOT_FOUND', 'Page not found'],
    ]);
    expect(errorsOf(await f.pages.delete(f.a, theirs.id))).toEqual([
      ['id', 'NOT_FOUND', 'Page not found'],
    ]);
    expect((await f.pages.list(f.a, { first: 50 })).items).toHaveLength(1);
  });
});
