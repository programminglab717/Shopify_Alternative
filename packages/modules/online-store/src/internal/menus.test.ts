import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MenuItemInput } from './menu-items.js';
import type { MenuItemRecord, MenuRecord } from './records.js';
import { menus } from './schema.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

const server = testDatabaseServer();

/** A menu's items as titles, types and addresses, the items under each after it. */
function outline(items: readonly MenuItemRecord[], depth = 0): string[] {
  return items.flatMap((item) => [
    `${'  '.repeat(depth)}${item.title} ${item.type} ${item.url ?? '(gone)'}${item.shown ? '' : ' (not shown)'}`,
    ...outline(item.items, depth + 1),
  ]);
}

describe.skipIf(!server)('MenuService', () => {
  let f: OnlineStoreFixture;
  let lawn: { id: string };
  let shawl: { id: string };
  let eid: { id: string };
  let otherShops: { id: string };

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
    lawn = unwrap(
      await f.products.create(f.a, {
        title: 'Lawn Suit',
        status: 'active',
        variants: [{ price: '4,990' }],
      }),
    );
    shawl = unwrap(await f.products.create(f.a, { title: 'Pashmina Shawl' }));
    eid = unwrap(await f.collections.create(f.a, { title: 'Eid Edit', productIds: [lawn.id] }));
    // Without products, so the storefront showed no link to it.
    unwrap(await f.collections.create(f.a, { title: 'Winter' }));
    otherShops = unwrap(await f.collections.create(f.b, { title: 'Theirs' }));
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  const events = async () =>
    (await f.outbox()).map((event) => [event.event_type, event.payload.handle] as const);
  const byHandle = async (handle: string): Promise<MenuRecord> =>
    (await f.menus.list(f.a, { first: 50 })).items.find((menu) => menu.handle === handle)!;

  it('matches the migrated table', async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(menus).limit(1));
  });

  it('makes the main and footer menus on first use, once, as the storefront showed them', async () => {
    // Before, read models get the same menus, made as they read them.
    const before = await f.db.tenant(f.a.shopId, (tx) => f.menus.menusOf(tx, f.a.shopId));
    const [first, second] = await Promise.all([
      f.menus.list(f.a, { first: 50 }),
      f.menus.list(f.a, { first: 50 }),
    ]);
    expect(first.items.map((menu) => [menu.handle, menu.title, menu.isDefault])).toEqual([
      ['main-menu', 'Main menu', true],
      ['footer', 'Footer menu', true],
    ]);
    expect(second.items.map((menu) => menu.id)).toEqual(first.items.map((menu) => menu.id));
    expect(outline(first.items[0]!.items)).toEqual([
      'Eid Edit collection /collections/eid-edit',
      'All products catalog /collections/all',
    ]);
    expect(first.items[1]!.items).toEqual([]);
    expect(before.map((menu) => [menu.handle, outline(menu.items)])).toEqual([
      ['main-menu', outline(first.items[0]!.items)],
      ['footer', []],
    ]);
    expect(await events()).toEqual([
      ['menu.created', 'main-menu'],
      ['menu.created', 'footer'],
    ]);
  });

  it('keeps menus three levels deep, of links to collections, products and addresses', async () => {
    const made = unwrap(
      await f.menus.create(f.a, {
        title: 'Shop by',
        handle: 'shop-by',
        items: [
          { title: 'Home', type: 'frontpage' },
          {
            title: 'Eid',
            type: 'collection',
            resourceId: eid.id,
            items: [
              {
                title: 'Lawn',
                type: 'product',
                resourceId: lawn.id,
                items: [
                  {
                    title: 'Cheapest first',
                    type: 'http',
                    url: '/collections/eid-edit?sort_by=price-ascending',
                  },
                ],
              },
              { title: 'Shawls', type: 'product', resourceId: shawl.id },
            ],
          },
          { title: 'Ask us', type: 'http', url: 'https://wa.me/923001234567' },
        ],
      }),
    );
    expect(made).toMatchObject({ handle: 'shop-by', title: 'Shop by', isDefault: false });
    expect(outline(made.items)).toEqual([
      'Home frontpage /',
      'Eid collection /collections/eid-edit',
      '  Lawn product /products/lawn-suit',
      '    Cheapest first http /collections/eid-edit?sort_by=price-ascending',
      // A draft: the Admin API names it, the storefront leaves it out.
      '  Shawls product /products/pashmina-shawl (not shown)',
      'Ask us http https://wa.me/923001234567',
    ]);
    expect(made.items[1]).toMatchObject({ resourceId: eid.id, id: expect.any(String) });
    expect((await f.menus.get(f.a, made.id))?.items).toEqual(made.items);
    expect(await events()).toEqual([
      ['menu.created', 'main-menu'],
      ['menu.created', 'footer'],
      ['menu.created', 'shop-by'],
    ]);
  });

  it('says what is wrong with a menu, and saves none of it', async () => {
    const refused = async (
      items: MenuItemInput[],
      menu: { title?: string; handle?: string } = {},
    ) =>
      errorsOf(
        await f.menus.create(f.a, {
          title: menu.title ?? 'Sale',
          handle: menu.handle ?? 'sale',
          items,
        }),
      );
    const deep = (levels: number): MenuItemInput[] =>
      levels === 0
        ? []
        : [{ title: `Level ${levels}`, type: 'frontpage', items: deep(levels - 1) }];

    expect(await refused([], { title: ' ', handle: 'Big Sale' })).toEqual([
      ['title', 'BLANK', "Title can't be blank"],
      ['handle', 'INVALID', expect.stringContaining('may have only lower-case letters')],
    ]);
    expect(await refused([], { handle: 'main-menu' })).toEqual([
      ['handle', 'TAKEN', 'Handle "main-menu" is another menu\'s'],
    ]);
    const cases: [MenuItemInput, [string, string, string]][] = [
      [
        { title: 'News', type: 'blog' },
        [
          'items.0.type',
          'INVALID',
          "Menus can't link to blog yet: use an http link to its address",
        ],
      ],
      [
        { title: 'About', type: 'page' },
        ['items.0.resourceId', 'BLANK', 'A page link needs its page'],
      ],
      [
        { title: 'Eid', type: 'collection' },
        ['items.0.resourceId', 'BLANK', 'A collection link needs its collection'],
      ],
      [
        { title: 'Home', type: 'frontpage', resourceId: eid.id },
        [
          'items.0.resourceId',
          'INVALID',
          'Only collection, product and page links take a resource ID',
        ],
      ],
      [
        { title: 'Somewhere', type: 'http', url: ' ' },
        ['items.0.url', 'BLANK', 'An http link needs a URL'],
      ],
      [
        { title: 'Tags', type: 'catalog', tags: ['eid'] },
        ['items.0.tags', 'INVALID', "Tags on menu items aren't available yet"],
      ],
      [
        { title: 'Theirs', type: 'collection', resourceId: otherShops.id },
        ['items.0.resourceId', 'NOT_FOUND', 'Collection not found'],
      ],
      [
        { title: 'Gone', type: 'product', resourceId: newId() },
        ['items.0.resourceId', 'NOT_FOUND', 'Product not found'],
      ],
      [
        { title: 'No such page', type: 'page', resourceId: newId() },
        ['items.0.resourceId', 'NOT_FOUND', 'Page not found'],
      ],
    ];
    for (const [item, error] of cases) {
      expect(await refused([item]), item.title).toEqual([error]);
    }
    // Addresses that could end the attribute a theme prints them in.
    for (const url of ['javascript:alert(1)', '//evil.example', '/a" onmouseover="x', '/a b']) {
      expect(await refused([{ title: 'Link', type: 'http', url }]), url).toEqual([
        ['items.0.url', 'INVALID', expect.stringContaining('URL must be a path on the storefront')],
      ]);
    }
    expect(await refused(deep(4))).toEqual([
      ['items.0.items.0.items.0.items', 'INVALID', 'Menus go 3 levels deep at most'],
    ]);
    const many = Array.from({ length: 251 }, (_, i) => ({ title: `${i}`, type: 'catalog' }));
    expect(await refused(many)).toEqual([['items', 'TOO_MANY', 'A menu holds 250 items at most']]);
    const long = Array.from({ length: 120 }, (_, i) => ({
      title: `${i}`,
      type: 'http',
      url: `/collections/all?q=${'x'.repeat(2000)}`,
    }));
    expect(await refused(long)).toEqual([
      ['items', 'TOO_LONG', "A menu's items take 200 KB at most"],
    ]);
    expect((await f.menus.list(f.a, { first: 50 })).items.map((menu) => menu.handle)).toEqual([
      'main-menu',
      'footer',
    ]);
  });

  it('changes a menu whole, keeping the IDs of items given again', async () => {
    const main = await byHandle('main-menu');
    const [collection, all] = main.items;
    const changed = unwrap(
      await f.menus.update(f.a, main.id, {
        title: 'Top menu',
        items: [
          { id: all!.id, title: 'Everything', type: 'catalog' },
          { title: 'Lawn', type: 'product', resourceId: lawn.id },
        ],
      }),
    );
    expect(changed.title).toBe('Top menu');
    expect(changed.handle).toBe('main-menu');
    expect(changed.items.map((item) => [item.id === all!.id, item.title])).toEqual([
      [true, 'Everything'],
      [false, 'Lawn'],
    ]);
    // Items not given again went; their IDs are no longer this menu's.
    expect(
      errorsOf(
        await f.menus.update(f.a, main.id, {
          title: 'Top menu',
          items: [{ id: collection!.id, title: 'Eid', type: 'collection', resourceId: eid.id }],
        }),
      ),
    ).toEqual([['items.0.id', 'NOT_FOUND', 'This menu has no item with this ID']]);
    expect(
      errorsOf(await f.menus.update(f.a, main.id, { title: 'Top', handle: 'top', items: [] })),
    ).toEqual([['handle', 'INVALID', 'This menu keeps its handle, main-menu']]);

    const sale = unwrap(await f.menus.create(f.a, { title: 'Sale', handle: 'sale', items: [] }));
    expect(
      errorsOf(await f.menus.update(f.a, sale.id, { title: 'Sale', handle: 'footer', items: [] })),
    ).toEqual([['handle', 'TAKEN', 'Handle "footer" is another menu\'s']]);
    const renamed = unwrap(
      await f.menus.update(f.a, sale.id, { title: 'Eid sale', handle: 'eid-sale', items: [] }),
    );
    expect(renamed).toMatchObject({ handle: 'eid-sale', title: 'Eid sale' });
    expect((await events()).slice(2)).toEqual([
      ['menu.updated', 'main-menu'],
      ['menu.created', 'sale'],
      ['menu.updated', 'eid-sale'],
    ]);
  });

  it('deletes menus other than the main and footer menus', async () => {
    const footer = await byHandle('footer');
    expect(errorsOf(await f.menus.delete(f.a, footer.id))).toEqual([
      ['id', 'INVALID', "Every shop has a footer menu: it can't be deleted"],
    ]);
    const sale = unwrap(await f.menus.create(f.a, { title: 'Sale', handle: 'sale', items: [] }));
    expect(unwrap(await f.menus.delete(f.a, sale.id))).toEqual({ id: sale.id });
    expect(await f.menus.get(f.a, sale.id)).toBeNull();
    expect(errorsOf(await f.menus.delete(f.a, sale.id))).toEqual([
      ['id', 'NOT_FOUND', 'Menu not found'],
    ]);
    expect((await events()).at(-1)).toEqual(['menu.deleted', 'sale']);
  });

  it("gives read models where each link leads now, and what the storefront can't show", async () => {
    const gone = unwrap(await f.collections.create(f.a, { title: 'Clearance' }));
    const main = await byHandle('main-menu');
    unwrap(
      await f.menus.update(f.a, main.id, {
        title: 'Main menu',
        items: [
          { title: 'Clearance', type: 'collection', resourceId: gone.id },
          { title: 'Shawls', type: 'product', resourceId: shawl.id },
        ],
      }),
    );
    unwrap(await f.collections.delete(f.a, gone.id));
    const read = await f.db.tenant(f.a.shopId, (tx) => f.menus.menusOf(tx, f.a.shopId));
    expect(read.map((menu) => menu.handle)).toEqual(['footer', 'main-menu']);
    expect(outline(read[1]!.items)).toEqual([
      'Clearance collection (gone) (not shown)',
      'Shawls product /products/pashmina-shawl (not shown)',
    ]);
  });

  it('links to pages by ID, following their handles, and shows only those published', async () => {
    const about = unwrap(await f.pages.create(f.a, { title: 'About us' }));
    const draft = unwrap(await f.pages.create(f.a, { title: 'Returns', isPublished: false }));
    const footer = await byHandle('footer');
    unwrap(
      await f.menus.update(f.a, footer.id, {
        title: 'Footer menu',
        items: [
          { title: 'About', type: 'page', resourceId: about.id },
          { title: 'Returns', type: 'page', resourceId: draft.id },
        ],
      }),
    );
    unwrap(await f.pages.update(f.a, about.id, { handle: 'our-story' }));
    const read = async () =>
      (await f.db.tenant(f.a.shopId, (tx) => f.menus.menusOf(tx, f.a.shopId))).find(
        (menu) => menu.handle === 'footer',
      )!;
    expect(outline((await read()).items)).toEqual([
      'About page /pages/our-story',
      'Returns page /pages/returns (not shown)',
    ]);
    unwrap(await f.pages.delete(f.a, about.id));
    expect(outline((await read()).items)).toEqual([
      'About page (gone) (not shown)',
      'Returns page /pages/returns (not shown)',
    ]);
  });

  it("keeps each shop's menus to itself", async () => {
    const theirs = unwrap(await f.menus.create(f.b, { title: 'Sale', handle: 'sale', items: [] }));
    expect(await f.menus.get(f.a, theirs.id)).toBeNull();
    expect(errorsOf(await f.menus.update(f.a, theirs.id, { title: 'Mine', items: [] }))).toEqual([
      ['id', 'NOT_FOUND', 'Menu not found'],
    ]);
    expect(errorsOf(await f.menus.delete(f.a, theirs.id))).toEqual([
      ['id', 'NOT_FOUND', 'Menu not found'],
    ]);
    expect((await f.menus.list(f.a, { first: 50 })).items.map((menu) => menu.handle)).toEqual([
      'main-menu',
      'footer',
    ]);
  });
});
