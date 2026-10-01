import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REDIRECT_LIMIT, redirectPath, redirectTarget } from './redirect-paths.js';
import { urlRedirects } from './schema.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';
import { UrlRedirectService, redirectMoved, shopRedirectsOf } from './url-redirect.service.js';

const server = testDatabaseServer();

describe('Redirect paths', () => {
  it('keeps a path as the storefront compares addresses, however it is typed or pasted', () => {
    expect(redirectPath('/Products/Old-Lawn/')).toBe('/products/old-lawn');
    expect(redirectPath(' https://zari.myshopify.com/collections/Eid?page=2#top ')).toBe(
      '/collections/eid',
    );
    // Both languages' pages go: the Urdu prefix is dropped.
    expect(redirectPath('/ur/pages/about')).toBe('/pages/about');
    expect(redirectPath('/pages//about')).toBe('/pages/about');
    // Decoded, as an Urdu handle is typed.
    expect(redirectPath('/pages/%D8%B1%D8%A7%D8%A8%D8%B7%DB%81')).toBe('/pages/رابطہ');
    // Nothing Postgres or a header would refuse: control characters, halves of characters.
    const [nul, half] = [String.fromCharCode(0), String.fromCharCode(0xd800)];
    for (const input of [
      '',
      '/',
      '/ur',
      '/ur/',
      'products/x',
      '//evil.pk/x',
      '/a b',
      'ftp://x/y',
      `/a${nul}b`,
      `/a${half}`,
      '/%ED%A0%80',
    ]) {
      expect(redirectPath(input), input).toBeNull();
    }
  });

  it('takes a path on the shop or an address elsewhere as a target', () => {
    expect(redirectTarget(' /collections/lawn?sort_by=price ')).toBe(
      '/collections/lawn?sort_by=price',
    );
    expect(redirectTarget('https://instagram.com/zari')).toBe('https://instagram.com/zari');
    const half = String.fromCharCode(0xdc00);
    for (const input of [
      '',
      'lawn',
      '//evil.pk',
      'javascript:alert(1)',
      'ftp://x.pk/y',
      `/pages/a${half}`,
    ]) {
      expect(redirectTarget(input), input).toBeNull();
    }
  });
});

describe.skipIf(!server)('UrlRedirectService', () => {
  let f: OnlineStoreFixture;
  let service: UrlRedirectService;

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
    service = new UrlRedirectService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  it('matches the migrated table', async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(urlRedirects).limit(1));
  });

  it("keeps a redirect for each path of a shop's, as the storefront will look it up", async () => {
    const lawn = unwrap(
      await service.create(f.a, {
        path: 'https://zari.pk/Products/Old-Lawn/',
        target: '/products/lawn',
      }),
    );
    expect(lawn).toMatchObject({ path: '/products/old-lawn', target: '/products/lawn' });
    expect(
      errorsOf(await service.create(f.a, { path: '/products/old-lawn', target: '/' })),
    ).toEqual([['path', 'TAKEN', '/products/old-lawn has a redirect already']]);
    // Another shop has its own paths.
    unwrap(await service.create(f.b, { path: '/products/old-lawn', target: '/collections/all' }));
    expect(
      errorsOf(await service.create(f.a, { path: '/', target: '/products/lawn' }))[0]?.[0],
    ).toBe('path');
    expect(errorsOf(await service.create(f.a, { path: '/x', target: 'lawn' }))[0]?.[0]).toBe(
      'target',
    );
    expect(errorsOf(await service.create(f.a, { path: '/pages/a', target: '/Pages/A/' }))).toEqual([
      ['target', 'INVALID', '/Pages/A/ would send shoppers back to /pages/a'],
    ]);
    expect(errorsOf(await service.create(f.a, {})).map((error) => error[0])).toEqual([
      'path',
      'target',
    ]);
    expect((await f.outbox()).map((row) => [row.event_type, row.payload])).toEqual([
      ['url_redirect.created', { path: '/products/old-lawn', target: '/products/lawn' }],
      ['url_redirect.created', { path: '/products/old-lawn', target: '/collections/all' }],
    ]);
  });

  it('changes and deletes redirects, lists them, and gives read models all of them', async () => {
    const one = unwrap(await service.create(f.a, { path: '/old-1', target: '/products/a' }));
    const two = unwrap(await service.create(f.a, { path: '/old-2', target: 'https://zari.pk/b' }));
    await f.admin.query('DELETE FROM platform.outbox_events');

    expect(unwrap(await service.update(f.a, one.id, { target: '/products/c' }))).toMatchObject({
      path: '/old-1',
      target: '/products/c',
    });
    // Nothing given changes nothing, and records nothing.
    unwrap(await service.update(f.a, one.id, {}));
    expect(errorsOf(await service.update(f.a, one.id, { path: '/OLD-2' }))).toEqual([
      ['path', 'TAKEN', '/old-2 has a redirect already'],
    ]);
    expect(errorsOf(await service.update(f.a, one.id, { path: '/products/c' }))[0]?.[1]).toBe(
      'INVALID',
    );
    expect(errorsOf(await service.update(f.b, one.id, { target: '/x' }))[0]?.[1]).toBe('NOT_FOUND');

    const page = await service.list(f.a, { first: 1 });
    expect([page.items.map((r) => r.path), page.hasNextPage]).toEqual([['/old-1'], true]);
    const next = await service.list(f.a, { first: 1, after: page.items[0]!.id });
    expect(next.items.map((r) => r.path)).toEqual(['/old-2']);
    expect(
      (await service.list(f.a, { first: 10, query: 'ZARI.pk' })).items.map((r) => r.id),
    ).toEqual([two.id]);
    expect((await service.list(f.a, { first: 10, query: '%' })).items).toEqual([]);
    const nul = String.fromCharCode(0);
    expect((await service.list(f.a, { first: 10, query: `old-2${nul}` })).items).toHaveLength(1);

    unwrap(await service.delete(f.a, two.id));
    expect(errorsOf(await service.delete(f.a, two.id))[0]?.[1]).toBe('NOT_FOUND');
    expect(await f.db.tenant(f.a.shopId, (tx) => shopRedirectsOf(tx, f.a.shopId))).toEqual([
      { path: '/old-1', target: '/products/c' },
    ]);
    expect((await f.outbox()).map((row) => row.event_type)).toEqual([
      'url_redirect.updated',
      'url_redirect.deleted',
    ]);
  });

  it("sends a moved page's old address to its new one, the long way round never", async () => {
    const moved = (from: string, to: string, shop = f.a) =>
      f.db.tenant(shop.shopId, (tx) => redirectMoved(tx, shop.shopId, from, to));
    const redirects = () => f.db.tenant(f.a.shopId, (tx) => shopRedirectsOf(tx, f.a.shopId));
    unwrap(await service.create(f.a, { path: '/eid', target: '/products/lawn?variant=2' }));
    unwrap(await service.create(f.a, { path: '/products/lawn-2025', target: '/pages/other' }));
    unwrap(await service.create(f.a, { path: '/products/lawn-2026', target: '/' }));
    await f.admin.query('DELETE FROM platform.outbox_events');

    expect(await moved('/products/lawn', '/products/lawn-2026')).toBe(true);
    expect(await redirects()).toEqual([
      // Those that sent shoppers to the old address go straight to the new one.
      { path: '/eid', target: '/products/lawn-2026?variant=2' },
      { path: '/products/lawn', target: '/products/lawn-2026' },
      { path: '/products/lawn-2025', target: '/pages/other' },
      // The one from the new address went: the page is there.
    ]);
    // Moved again: every old address goes to the newest.
    await moved('/products/lawn-2026', '/products/lawn-suit');
    // And back: the address it is at sends nobody away.
    await moved('/products/lawn-suit', '/products/lawn');
    expect(await redirects()).toEqual([
      { path: '/eid', target: '/products/lawn?variant=2' },
      { path: '/products/lawn-2025', target: '/pages/other' },
      { path: '/products/lawn-2026', target: '/products/lawn' },
      { path: '/products/lawn-suit', target: '/products/lawn' },
    ]);
    // A page back where it was only lets go of a redirect from there.
    await moved('/products/lawn-2025', '/products/lawn-2025');
    expect((await redirects()).map((r) => r.path)).not.toContain('/products/lawn-2025');
    // Each change is said, for the storefront.
    expect((await f.outbox()).map((row) => row.event_type)).toContain('url_redirect.deleted');
    // Another shop's redirects stay as they were.
    await moved('/eid', '/pages/eid', f.b);
    expect((await redirects())[0]).toEqual({ path: '/eid', target: '/products/lawn?variant=2' });
  });

  it(`keeps ${REDIRECT_LIMIT} redirects a shop at most`, async () => {
    await f.admin.query(
      `INSERT INTO online_store.url_redirects (shop_id, path, target)
       SELECT $1, '/old-' || n, '/products/new' FROM generate_series(1, $2) AS n`,
      [f.a.shopId, REDIRECT_LIMIT],
    );
    expect(errorsOf(await service.create(f.a, { path: '/one-more', target: '/' }))).toEqual([
      ['', 'TOO_MANY', `A shop can keep at most ${REDIRECT_LIMIT} redirects`],
    ]);
    unwrap(await service.create(f.b, { path: '/one-more', target: '/' }));
    // A page that moves gets no redirect either, but changes those it has.
    const moved = (from: string, to: string) =>
      f.db.tenant(f.a.shopId, (tx) => redirectMoved(tx, f.a.shopId, from, to));
    expect(await moved('/pages/a', '/pages/b')).toBe(false);
    expect(await moved('/old-1', '/products/newer')).toBe(true);
  });

  it("takes redirects from a file as Shopify's export has them, and gives them back the same way", async () => {
    unwrap(await service.create(f.a, { path: '/pages/about', target: '/pages/about-us' }));
    const before = (await f.outbox()).length;
    const csv = [
      'Redirect from,Redirect to',
      '/products/Old-Lawn/,/products/lawn',
      'https://zari.myshopify.com/collections/sale?page=2,/collections/all',
      '/pages/about,/pages/our-story',
      '/,/products/lawn',
      '/blogs/news/eid,lawn',
      '/products/old-lawn,/products/kurta',
      '/pages/a,/Pages/A/',
    ].join('\r\n');
    const rowErrors = [
      {
        row: 5,
        column: 'Redirect from',
        message: 'Enter a path on the shop other than its home page, such as /products/old-lawn',
      },
      {
        row: 6,
        column: 'Redirect to',
        message: 'Enter a path on the shop, such as /collections/lawn, or an https:// address',
      },
      { row: 7, column: 'Redirect from', message: 'The same path as row 2' },
      { row: 8, column: 'Redirect to', message: '/Pages/A/ would send shoppers back to /pages/a' },
    ];
    // A dry run counts, and changes nothing.
    expect(unwrap(await service.import(f.a, csv, { dryRun: true }))).toEqual({
      rows: 7,
      created: 2,
      skipped: 1,
      rowErrors,
      rowErrorCount: 4,
      dryRun: true,
    });
    expect(await f.outbox()).toHaveLength(before);

    expect(unwrap(await service.import(f.a, csv))).toEqual({
      rows: 7,
      created: 2,
      skipped: 1,
      rowErrors,
      rowErrorCount: 4,
      dryRun: false,
    });
    // The path the shop had keeps its target; one event for the lot.
    expect(await f.db.tenant(f.a.shopId, (tx) => shopRedirectsOf(tx, f.a.shopId))).toEqual([
      { path: '/collections/sale', target: '/collections/all' },
      { path: '/pages/about', target: '/pages/about-us' },
      { path: '/products/old-lawn', target: '/products/lawn' },
    ]);
    expect((await f.outbox()).slice(before).map((row) => [row.event_type, row.payload])).toEqual([
      ['url_redirects.imported', { created: 2 }],
    ]);
    // The same file again makes nothing.
    expect(unwrap(await service.import(f.a, csv))).toMatchObject({ created: 0, skipped: 3 });

    // The export, which the import takes back, into another shop.
    const exported = await service.export(f.a);
    expect(exported).toEqual({
      csv:
        String.fromCharCode(0xfeff) +
        'Redirect from,Redirect to\r\n/collections/sale,/collections/all\r\n' +
        '/pages/about,/pages/about-us\r\n/products/old-lawn,/products/lawn\r\n',
      count: 3,
    });
    expect(unwrap(await service.import(f.b, exported.csv))).toMatchObject({
      created: 3,
      rowErrorCount: 0,
    });

    // Files that are not redirects, or too many for a shop.
    expect(errorsOf(await service.import(f.a, 'Handle,Title\nlawn,Lawn'))[0]?.slice(0, 2)).toEqual([
      'csv',
      'INVALID',
    ]);
    expect(errorsOf(await service.import(f.a, ''))[0]?.slice(0, 2)).toEqual(['csv', 'BLANK']);
    const tooMany = ['Redirect from,Redirect to']
      .concat(Array.from({ length: 20_001 }, (_, n) => `/old-${n},/`))
      .join('\n');
    expect(errorsOf(await service.import(f.a, tooMany))[0]?.slice(0, 2)).toEqual([
      'csv',
      'TOO_MANY',
    ]);
  });
});
