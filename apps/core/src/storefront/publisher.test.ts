import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { MutationResult, TenantContext } from '@hatti/api';
import {
  CollectionService,
  MediaService,
  ProductService,
  VariantService,
} from '@hatti/catalog/public';
import { DeliveryService } from '@hatti/checkout/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import {
  MenuService,
  PageService,
  PreferencesService,
  ThemeService,
} from '@hatti/online-store/public';
import {
  DOCUMENTS_VERSION,
  RedisStore,
  StorefrontKeys,
  StoreMissingError,
  handleTag,
  shopTag,
  type HandledKind,
  type MenuLinkDoc,
  type ShopDoc,
} from '@hatti/storefront-data';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { itemsFor, StorefrontPublisher } from './publisher.js';

const server = testDatabaseServer();
const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

interface OutboxRow {
  id: string;
  shop_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

describe('What storefront documents an event makes stale', () => {
  const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent => ({
    id: newId(),
    type,
    shopId: newId(),
    aggregateType: type.split('.')[0]!,
    aggregateId: 'a1',
    payload,
    occurredAt: new Date().toISOString(),
  });

  it('rebuilds listings only when a change can move a product in or out of them, or reorder them', () => {
    expect(itemsFor(event('product.updated', { changed: ['description', 'media'] }))).toEqual([
      'product:a1',
    ]);
    // Menus link to it by its handle.
    expect(itemsFor(event('product.updated', { changed: ['handle'] }))).toEqual([
      'product:a1',
      'menus',
    ]);
    expect(itemsFor(event('product.updated', { changed: ['handle', 'tags'] }))).toEqual([
      'product:a1',
      'collections-with:a1',
      'smart-collections',
      'all-products',
      'menus',
    ]);
    expect(itemsFor(event('product.deleted'))).toContain('every-collection');
    expect(itemsFor(event('collection.updated', { changed: ['title'] }))).toEqual([
      'collection:a1',
      'all-products',
      'menus',
    ]);
  });

  it("rebuilds a product when its stock changes, and all of them when a location's selling does", () => {
    expect(itemsFor(event('inventory_level.updated', { productId: 'p1' }))).toEqual(['product:p1']);
    expect(itemsFor(event('location.updated', { changed: ['name'] }))).toEqual([]);
    expect(itemsFor(event('location.updated', { changed: ['isActive'] }))).toEqual([
      'every-product',
    ]);
    expect(itemsFor(event('order.created'))).toEqual([]);
  });

  it('rebuilds the shop when its main theme changes, or another takes its place', () => {
    const updated = (role: string) =>
      event('theme.updated', { changed: ['templates/index.json'], role, version: 2 });
    expect(itemsFor(updated('main'))).toEqual(['shop']);
    expect(itemsFor(updated('unpublished'))).toEqual([]);
    expect(itemsFor(event('theme.published', { previousId: 'a0', version: 3 }))).toEqual(['shop']);
    // Made unpublished, or without files of the shop's own; only unpublished ones are deleted.
    expect(itemsFor(event('theme.created', { name: 'Winter', base: 'hatti-base' }))).toEqual([]);
    expect(itemsFor(event('theme.deleted', { name: 'Winter' }))).toEqual([]);
  });

  it('rebuilds the menus when one is made, changed or deleted', () => {
    for (const type of ['menu.created', 'menu.updated', 'menu.deleted']) {
      expect(itemsFor(event(type, { handle: 'sale' })), type).toEqual(['menus']);
    }
  });

  it('rebuilds a page when it changes, and the menus when it moves, shows or hides', () => {
    expect(itemsFor(event('page.created', { handle: 'about', isPublished: true }))).toEqual([
      'page:a1',
    ]);
    const updated = (changed: string[]) =>
      itemsFor(event('page.updated', { handle: 'about', isPublished: true, changed }));
    expect(updated(['title', 'body', 'templateSuffix'])).toEqual(['page:a1']);
    expect(updated(['handle'])).toEqual(['page:a1', 'menus']);
    expect(updated(['isPublished'])).toEqual(['page:a1', 'menus']);
    expect(itemsFor(event('page.deleted', { handle: 'about', isPublished: false }))).toEqual([
      'page:a1',
      'menus',
    ]);
  });

  it("rebuilds the shop when its storefront's preferences change", () => {
    expect(
      itemsFor(event('online_store_preferences.updated', { changed: ['whatsappNumber'] })),
    ).toEqual(['shop']);
  });

  it('rebuilds the shop when its delivery charges change', () => {
    expect(itemsFor(event('delivery_settings.updated', { changed: ['charge'] }))).toEqual(['shop']);
  });
});

describe.skipIf(!server || !redisUrl)('Storefront publisher', () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const keys = new StorefrontKeys(`test-sfp-${randomBytes(4).toString('hex')}`);
  let publisher: StorefrontPublisher;
  let products: ProductService;
  let collections: CollectionService;
  let inventory: InventoryService;
  let locations: LocationService;
  let media: MediaService;
  let themes: ThemeService;
  let menus: MenuService;
  let pages: PageService;
  let preferences: PreferencesService;
  let delivery: DeliveryService;
  /** What the edge was told to forget, a purge at a time; and whether it refuses. */
  const forgotten: string[][] = [];
  let edgeDown = false;
  const shopId = newId();
  const tenant: TenantContext = {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products', 'write_inventory', 'write_locations', 'write_settings']),
  };
  const store = () => new RedisStore(redis, shopId, keys);
  const handles = async (...wanted: string[]) => {
    const data = store();
    const docs = await Promise.all(wanted.map((handle) => data.productByHandle(handle)));
    return docs.map((doc) => doc?.title ?? null);
  };
  const listing = async (handle: string) => {
    const collection = await store().collectionByHandle(handle);
    if (!collection) return null;
    const docs = await store().products(collection.productIds);
    return docs.map((doc) => doc?.title ?? '(missing)');
  };

  /** Hands the publisher the events recorded since the last call, as the worker does. */
  const deliver = async (): Promise<string[]> => {
    const { rows } = await admin.query<OutboxRow>(`
      UPDATE platform.outbox_events SET published_at = now() WHERE published_at IS NULL
      RETURNING id, shop_id, aggregate_type, aggregate_id, event_type, payload, occurred_at`);
    rows.sort(
      (a, b) => a.occurred_at.getTime() - b.occurred_at.getTime() || (a.id < b.id ? -1 : 1),
    );
    for (const row of rows) {
      const event: DomainEvent = {
        id: row.id,
        type: row.event_type,
        shopId: row.shop_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        occurredAt: row.occurred_at.toISOString(),
      };
      await publisher.handle(event);
    }
    return [...new Set(rows.map((row) => row.event_type))];
  };

  let lawn: { id: string; variants: { id: string; title: string }[] };
  let khussa: { id: string };
  let primary: string;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({ appUrl: testDb.appUrl, applicationName: 'publisher-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari Fashions', 'zari-fashions')`,
      [shopId],
    );
    const variants = new VariantService(database);
    products = new ProductService(database);
    collections = new CollectionService(database);
    inventory = new InventoryService(database, variants);
    locations = new LocationService(database);
    media = new MediaService(database);
    themes = new ThemeService(database);
    menus = new MenuService(database, collections, products);
    pages = new PageService(database);
    preferences = new PreferencesService(database);
    delivery = new DeliveryService(database);
    publisher = new StorefrontPublisher(
      database,
      redis,
      { products, collections, inventory, themes, menus, pages, preferences, delivery },
      {
        keys,
        edge: {
          purge: async (tags) => {
            if (edgeDown) throw new Error('The edge is down');
            forgotten.push([...tags]);
          },
        },
      },
    );

    lawn = unwrap(
      await products.create(tenant, {
        title: 'Lawn Suit',
        status: 'active',
        description: 'Soft printed lawn.\n\nStitched in <Lahore> & Multan.\nHand wash.',
        productType: 'Unstitched',
        tags: ['eid'],
        options: [{ name: 'Colour', values: ['Mint', 'Rose'] }],
        variants: [
          { optionValues: ['Mint'], price: '4,990', compareAtPrice: '6,500' },
          { optionValues: ['Rose'], price: '5,190' },
        ],
      }),
    );
    khussa = unwrap(
      await products.create(tenant, {
        title: 'Multani Khussa',
        status: 'active',
        productType: 'Footwear',
        variants: [{ price: '2,250' }],
      }),
    );
    const shawl = unwrap(
      await products.create(tenant, { title: 'Pashmina Shawl', variants: [{ price: '12,500' }] }),
    );
    const photos = unwrap(
      await media.create(tenant, lawn.id, [
        { originalSource: 'https://cdn.example.pk/lawn-mint.jpg', alt: 'Mint lawn suit' },
      ]),
    );
    unwrap(
      await variants.bulkUpdate(tenant, lawn.id, [
        { id: lawn.variants[0]!.id, mediaId: photos.mediaIds[0]! },
      ]),
    );
    primary = (await database.tenant(shopId, (tx) => locations.primaryOf(tx, shopId))).id;
    unwrap(
      await inventory.setQuantities(tenant, {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: lawn.variants[1]!.id, locationId: primary, quantity: 0 }],
      }),
    );
    unwrap(
      await collections.create(tenant, {
        title: 'Eid Edit',
        productIds: [khussa.id, shawl.id, lawn.id],
      }),
    );
    unwrap(
      await collections.create(tenant, {
        title: 'Footwear',
        ruleSet: {
          appliedDisjunctively: false,
          rules: [{ column: 'type', relation: 'equals', condition: 'Footwear' }],
        },
      }),
    );
  });

  afterAll(async () => {
    await publisher?.queue.clear(shopId);
    redis.disconnect();
    await admin?.end();
    await database?.close();
    await testDb?.drop();
  });

  it("publishes a new shop's active products, listings, menus and settings", async () => {
    await expect(store().shop()).rejects.toThrow(StoreMissingError);
    await admin.query('UPDATE platform.outbox_events SET published_at = now()');
    expect(await publisher.publishAll(shopId)).toBeGreaterThan(5);

    expect(await store().shop()).toEqual({
      version: DOCUMENTS_VERSION,
      name: 'Zari Fashions',
      handle: 'zari-fashions',
      domain: '',
      whatsapp: null,
      cod: { available: true, fee: 0, limit: null },
      // It set no charges: delivery is free.
      delivery: { charge: 0, freeAbove: null, zones: [] },
      // It never touched its themes: the storefront shows the platform theme as it is.
      theme: null,
    });
    expect(await store().theme()).toBeNull();
    // Its storefront answers at zari-fashions.hatti.pk.
    expect(await publisher.directory.find('zari-fashions')).toBe(shopId);
    const doc = await store().productByHandle('lawn-suit');
    expect(doc).toMatchObject({
      title: 'Lawn Suit',
      descriptionHtml:
        '<p>Soft printed lawn.</p><p>Stitched in &#60;Lahore&#62; &#38; Multan.<br>Hand wash.</p>',
      productType: 'Unstitched',
      tags: ['eid'],
      options: [{ name: 'Colour', values: ['Mint', 'Rose'] }],
      variants: [
        { title: 'Mint', price: 499_000, compareAtPrice: 650_000, available: true, image: 0 },
        { title: 'Rose', price: 519_000, compareAtPrice: null, available: false, image: null },
      ],
      images: [
        { src: 'https://cdn.example.pk/lawn-mint.jpg', width: 0, height: 0, alt: 'Mint lawn suit' },
      ],
    });
    expect(doc?.variants.map((variant) => variant.options)).toEqual([['Mint'], ['Rose']]);
    // No costs or stock counts reach the storefront.
    expect(Object.keys(doc!.variants[0]!).sort()).toEqual(
      ['available', 'compareAtPrice', 'id', 'image', 'options', 'price', 'sku', 'title'].sort(),
    );
    expect((await store().productByHandle('multani-khussa'))?.options).toEqual([
      { name: 'Title', values: ['Default Title'] },
    ]);
    // Drafts stay off the storefront, and out of its listings.
    expect(await handles('pashmina-shawl')).toEqual([null]);
    expect(await listing('eid-edit')).toEqual(['Multani Khussa', 'Lawn Suit']);
    expect(await listing('footwear')).toEqual(['Multani Khussa']);
    expect(await listing('all')).toEqual(['Multani Khussa', 'Lawn Suit']);
    // Until the shop makes its own, menus lead to its collections with products.
    expect((await store().menu('main-menu'))?.links).toEqual([
      { title: 'Eid Edit', url: '/collections/eid-edit', type: 'collection_link', links: [] },
      { title: 'Footwear', url: '/collections/footwear', type: 'collection_link', links: [] },
      { title: 'All products', url: '/collections/all', type: 'catalog_link', links: [] },
    ]);
    expect((await store().menu('footer'))?.links).toEqual([]);
  });

  it('follows edits, stock and locations through their events', async () => {
    unwrap(await products.update(tenant, { id: lawn.id, handle: 'eid-lawn-suit' }));
    expect(await deliver()).toEqual(['product.updated']);
    expect(await handles('lawn-suit', 'eid-lawn-suit')).toEqual([null, 'Lawn Suit']);

    // Stock at a shop that does not sell online is not for sale, until it does.
    const counter = unwrap(
      await locations.add(tenant, { name: 'Lahore store', fulfillsOnlineOrders: false }),
    );
    unwrap(
      await inventory.setQuantities(tenant, {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [
          { inventoryItemId: lawn.variants[1]!.id, locationId: counter.id, quantity: 3 },
        ],
      }),
    );
    expect(await deliver()).toEqual(['location.created', 'inventory_level.updated']);
    const rose = async () => (await store().productByHandle('eid-lawn-suit'))?.variants[1];
    expect((await rose())?.available).toBe(false);
    unwrap(await locations.edit(tenant, counter.id, { fulfillsOnlineOrders: true }));
    expect(await deliver()).toEqual(['location.updated']);
    expect((await rose())?.available).toBe(true);

    // Listings follow their sort order, and products leaving them.
    const eid = (await store().collectionByHandle('eid-edit'))!;
    unwrap(await collections.update(tenant, { id: eid.id, sortOrder: 'alpha_asc' }));
    await deliver();
    expect(await listing('eid-edit')).toEqual(['Lawn Suit', 'Multani Khussa']);
    unwrap(await products.update(tenant, { id: khussa.id, productType: 'Shoes' }));
    await deliver();
    expect(await listing('footwear')).toEqual([]);
    unwrap(await products.update(tenant, { id: khussa.id, status: 'draft' }));
    await deliver();
    expect(await handles('multani-khussa')).toEqual([null]);
    expect(await listing('eid-edit')).toEqual(['Lawn Suit']);
    expect(await listing('all')).toEqual(['Lawn Suit']);

    unwrap(await products.delete(tenant, lawn.id));
    expect(await deliver()).toEqual(['product.deleted']);
    expect(await handles('eid-lawn-suit')).toEqual([null]);
    expect(await listing('eid-edit')).toEqual([]);
    expect(await listing('all')).toEqual([]);
  });

  it('gives /collections/all to a collection with that handle, and back when it goes', async () => {
    unwrap(await products.update(tenant, { id: khussa.id, status: 'active' }));
    const mine = unwrap(
      await collections.create(tenant, { title: 'Everything', handle: 'all', productIds: [] }),
    );
    await deliver();
    expect((await store().collectionByHandle('all'))?.title).toBe('Everything');
    unwrap(await collections.delete(tenant, mine.id));
    unwrap(await collections.delete(tenant, (await store().collectionByHandle('eid-edit'))!.id));
    await deliver();
    expect(await store().collectionByHandle('eid-edit')).toBeNull();
    expect((await store().collectionByHandle('all'))?.title).toBe('All products');
    expect(await listing('all')).toEqual(['Multani Khussa']);
    expect((await store().menu('main-menu'))?.links.map((link) => link.title)).toEqual([
      'All products',
    ]);
  });

  it('rebuilds a shop whose documents were lost, and takes off what no longer exists', async () => {
    await publisher.queue.clear(shopId);
    // A product the database no longer has, whose deletion was never heard of.
    await publisher.queue.add(shopId, ['stray']);
    await publisher.queue.drain(shopId, async ({ writer }) => {
      await writer.putProducts([
        {
          id: newId(),
          handle: 'stray',
          title: 'Stray',
          descriptionHtml: '',
          vendor: '',
          productType: '',
          tags: [],
          options: [],
          variants: [],
          images: [],
        },
      ]);
    });
    expect(await handles('stray')).toEqual(['Stray']);

    // The next event finds the shop's documents gone, and publishes all of them.
    unwrap(await products.update(tenant, { id: khussa.id, title: 'Multani Khussa, Gold' }));
    await deliver();
    expect((await store().shop()).name).toBe('Zari Fashions');
    expect(await handles('multani-khussa', 'stray')).toEqual(['Multani Khussa, Gold', null]);
    expect(await listing('all')).toEqual(['Multani Khussa, Gold']);
    expect(await publisher.queue.size(shopId)).toBe(0);
  });

  it('publishes the main theme before the shop that names it, and follows it', async () => {
    const home = JSON.stringify({
      sections: { banner: { type: 'image-banner', settings: {} } },
      order: ['banner'],
    });
    const main = await themes.main(tenant);
    unwrap(
      await themes.upsertFiles(tenant, main.id, [{ filename: 'templates/index.json', body: home }]),
    );
    expect(await deliver()).toEqual(['theme.created', 'theme.updated']);
    expect(await store().theme()).toEqual({
      id: main.id,
      version: 2,
      base: 'hatti-base',
      files: { 'templates/index.json': home },
    });
    expect((await store().shop()).theme).toEqual({ id: main.id, version: 2 });

    // One being prepared shows once it is published in the main one's place.
    const winter = unwrap(await themes.create(tenant, { name: 'Winter', copyFrom: main.id }));
    const settings = JSON.stringify({ current: { color_accent: '#B91C1C' } });
    unwrap(
      await themes.upsertFiles(tenant, winter.id, [
        { filename: 'config/settings_data.json', body: settings },
      ]),
    );
    expect(await deliver()).toEqual(['theme.created', 'theme.updated']);
    expect((await store().shop()).theme).toEqual({ id: main.id, version: 2 });
    const published = unwrap(await themes.publish(tenant, winter.id));
    await deliver();
    expect(await store().theme()).toEqual({
      id: winter.id,
      version: published.version,
      base: 'hatti-base',
      files: { 'config/settings_data.json': settings, 'templates/index.json': home },
    });
    expect((await store().shop()).theme).toEqual({ id: winter.id, version: published.version });
  });

  it("takes a suspended shop's handle out of the directory, and gives it back", async () => {
    const status = (value: string) =>
      admin.query('UPDATE control.shops SET status = $2 WHERE id = $1', [shopId, value]);
    await status('suspended');
    await publisher.publishAll(shopId);
    expect(await publisher.directory.find('zari-fashions')).toBeNull();
    await status('active');
    await publisher.publishAll(shopId);
    expect(await publisher.directory.find('zari-fashions')).toBe(shopId);
  });

  it('publishes a shop again when its documents are of an older shape', async () => {
    // As written before documents had a version, a handle or a theme.
    await publisher.queue.add(shopId, ['old']);
    await publisher.queue.drain(shopId, ({ writer }) => writer.putShop(SHOP_V1 as ShopDoc));
    await redis.hdel(keys.directory(), 'zari-fashions');

    unwrap(await products.update(tenant, { id: khussa.id, title: 'Multani Khussa' }));
    await deliver();
    expect((await store().shop()).version).toBe(DOCUMENTS_VERSION);
    expect(await publisher.directory.find('zari-fashions')).toBe(shopId);
  });

  it("publishes the shop's own menus, their links following what they lead to", async () => {
    /** A menu's links as titles and addresses, the links under each after it. */
    const outline = (links: readonly MenuLinkDoc[], depth = 0): string[] =>
      links.flatMap((link) => [
        `${'  '.repeat(depth)}${link.title} ${link.url}`,
        ...outline(link.links, depth + 1),
      ]);
    const published = async (handle: string) => {
      const menu = await store().menu(handle);
      return menu && outline(menu.links);
    };
    const chappal = unwrap(
      await products.create(tenant, {
        title: 'Peshawari Chappal',
        status: 'active',
        productType: 'Footwear',
        variants: [{ price: '3,499' }],
      }),
    );
    const footwear = (await store().collectionByHandle('footwear'))!;
    const main = (await menus.list(tenant, { first: 50 })).items.find(
      (menu) => menu.handle === 'main-menu',
    )!;
    unwrap(
      await menus.update(tenant, main.id, {
        title: 'Main menu',
        items: [
          { title: 'Home', type: 'frontpage' },
          {
            title: 'Footwear',
            type: 'collection',
            resourceId: footwear.id,
            items: [
              { title: 'Chappals', type: 'product', resourceId: chappal.id },
              { title: 'Khussas', type: 'product', resourceId: khussa.id },
            ],
          },
        ],
      }),
    );
    const sale = unwrap(
      await menus.create(tenant, {
        title: 'Sale',
        handle: 'sale',
        items: [{ title: 'Everything', type: 'catalog' }],
      }),
    );
    await deliver();
    expect(await published('main-menu')).toEqual([
      'Home /',
      'Footwear /collections/footwear',
      '  Chappals /products/peshawari-chappal',
      '  Khussas /products/multani-khussa',
    ]);
    expect(await published('sale')).toEqual(['Everything /collections/all']);

    // A new handle, a product taken off the storefront, and a menu deleted.
    unwrap(await products.update(tenant, { id: khussa.id, handle: 'gold-khussa' }));
    unwrap(await products.update(tenant, { id: chappal.id, status: 'draft' }));
    unwrap(await menus.delete(tenant, sale.id));
    await deliver();
    expect(await published('main-menu')).toEqual([
      'Home /',
      'Footwear /collections/footwear',
      '  Khussas /products/gold-khussa',
    ]);
    expect(await published('sale')).toBeNull();
  });

  it("publishes the shop's pages while they are published, and menus' links to them", async () => {
    const about = unwrap(
      await pages.create(tenant, {
        title: 'About us',
        body: '<h2>Since 1998</h2><p>Hand-made in Multan.</p>',
      }),
    );
    const returns = unwrap(
      await pages.create(tenant, { title: 'Returns', body: '<p>7 days</p>', isPublished: false }),
    );
    const footer = (await menus.list(tenant, { first: 50 })).items.find(
      (menu) => menu.handle === 'footer',
    )!;
    unwrap(
      await menus.update(tenant, footer.id, {
        title: 'Footer menu',
        items: [
          { title: 'About', type: 'page', resourceId: about.id },
          { title: 'Returns', type: 'page', resourceId: returns.id },
        ],
      }),
    );
    await deliver();
    expect(await store().pageByHandle('about-us')).toEqual({
      id: about.id,
      handle: 'about-us',
      title: 'About us',
      bodyHtml: '<h2>Since 1998</h2><p>Hand-made in Multan.</p>',
      templateSuffix: null,
      publishedAt: about.publishedAt!.toISOString(),
    });
    expect(await store().pageByHandle('returns')).toBeNull();
    const links = async () =>
      (await store().menu('footer'))!.links.map((link) => `${link.title} ${link.url} ${link.type}`);
    expect(await links()).toEqual(['About /pages/about-us page_link']);

    // A new handle, a page published, and one deleted.
    unwrap(await pages.update(tenant, about.id, { handle: 'our-story' }));
    unwrap(await pages.update(tenant, returns.id, { isPublished: true }));
    await deliver();
    expect((await store().pageByHandle('our-story'))?.id).toBe(about.id);
    expect(await store().pageByHandle('about-us')).toBeNull();
    expect((await store().pageByHandle('returns'))?.bodyHtml).toBe('<p>7 days</p>');
    expect(await links()).toEqual([
      'About /pages/our-story page_link',
      'Returns /pages/returns page_link',
    ]);
    unwrap(await pages.delete(tenant, returns.id));
    await deliver();
    expect(await store().pageByHandle('returns')).toBeNull();
    expect(await links()).toEqual(['About /pages/our-story page_link']);
  });

  it("publishes the shop's WhatsApp number, and takes it off when the shop does", async () => {
    unwrap(await preferences.update(tenant, { whatsappNumber: '0300 1234567' }));
    expect(await deliver()).toEqual(['online_store_preferences.updated']);
    expect((await store().shop()).whatsapp).toBe('+923001234567');
    unwrap(await preferences.update(tenant, { whatsappNumber: null }));
    await deliver();
    expect((await store().shop()).whatsapp).toBeNull();
  });

  it('publishes what the shop charges for delivery', async () => {
    unwrap(
      await delivery.update(tenant, {
        charge: '250',
        freeAbove: '5,000',
        zones: [{ name: 'Karachi', cities: ['khi'], charge: '150' }],
      }),
    );
    expect(await deliver()).toEqual(['delivery_settings.updated']);
    expect((await store().shop()).delivery).toEqual({
      charge: 25_000,
      freeAbove: 500_000,
      zones: [{ name: 'Karachi', cities: ['Karachi'], charge: 15_000 }],
    });
    unwrap(await delivery.update(tenant, { freeAbove: null, zones: [] }));
    await deliver();
    expect((await store().shop()).delivery).toEqual({ charge: 25_000, freeAbove: null, zones: [] });
  });

  it('tells the edge to forget the pages of what changed, and only those', async () => {
    const tag = (kind: HandledKind, handle: string) => handleTag(shopId, kind, handle);
    /** Delivers what happened: what the edge was told to forget. */
    const forget = async (): Promise<string[]> => {
      forgotten.length = 0;
      await deliver();
      return forgotten.flat().sort();
    };
    const chunri = unwrap(
      await products.create(tenant, {
        title: 'Chunri Dupatta',
        status: 'active',
        variants: [{ price: '1,800' }],
      }),
    );
    unwrap(await collections.create(tenant, { title: 'Dupattas', productIds: [chunri.id] }));
    const stock = async (quantity: number) =>
      unwrap(
        await inventory.setQuantities(tenant, {
          name: 'available',
          reason: 'cycle_count_available',
          quantities: [{ inventoryItemId: chunri.variants[0]!.id, locationId: primary, quantity }],
        }),
      );
    await stock(5);
    expect(await forget()).toContain(tag('product', 'chunri-dupatta'));

    // More of it in stock changes nothing a page shows: nothing is forgotten.
    await stock(6);
    expect(await forget()).toEqual([]);
    // Sold out: its page, and the listings that show its card.
    await stock(0);
    expect(await forget()).toEqual(
      [
        tag('collection', 'all'),
        tag('collection', 'dupattas'),
        tag('product', 'chunri-dupatta'),
      ].sort(),
    );
    // A new handle: the pages at the old one and the new one.
    unwrap(await products.update(tenant, { id: chunri.id, handle: 'red-chunri' }));
    expect(await forget()).toEqual(
      [
        tag('collection', 'all'),
        tag('collection', 'dupattas'),
        tag('product', 'chunri-dupatta'),
        tag('product', 'red-chunri'),
      ].sort(),
    );

    // A page's body: that page.
    const story = (await store().pageByHandle('our-story'))!;
    unwrap(await pages.update(tenant, story.id, { body: '<p>Since 1998, in Multan.</p>' }));
    expect(await forget()).toEqual([tag('page', 'our-story')]);
    // The shop's settings are on every page: all of them.
    unwrap(await preferences.update(tenant, { whatsappNumber: '0300 7654321' }));
    expect(await forget()).toEqual([shopTag(shopId)]);

    // An edge that cannot be reached leaves the documents written.
    edgeDown = true;
    unwrap(await pages.update(tenant, story.id, { body: '<p>Since 1998.</p>' }));
    await deliver();
    expect((await store().pageByHandle('our-story'))?.bodyHtml).toBe('<p>Since 1998.</p>');
    edgeDown = false;
  });
});

const SHOP_V1: Omit<ShopDoc, 'version' | 'handle' | 'theme'> = {
  name: 'Zari Fashions',
  domain: '',
  whatsapp: null,
  cod: { available: true, fee: 0, limit: null },
};
