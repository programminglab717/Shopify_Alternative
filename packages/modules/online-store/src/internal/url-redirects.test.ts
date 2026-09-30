import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REDIRECT_LIMIT, redirectPath, redirectTarget } from './redirect-paths.js';
import { urlRedirects } from './schema.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';
import { UrlRedirectService, shopRedirectsOf } from './url-redirect.service.js';

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
  });
});
