import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { MutationResult, TenantContext } from '@hatti/api';
import {
  CollectionService,
  MediaService,
  ProductService,
  VariantService,
} from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import {
  DOCUMENTS_VERSION,
  RedisStore,
  StorefrontKeys,
  StoreMissingError,
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
  const shopId = newId();
  const tenant: TenantContext = {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products', 'write_inventory', 'write_locations']),
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
    publisher = new StorefrontPublisher(
      database,
      redis,
      { products, collections, inventory },
      { keys },
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
    });
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
    expect((await store().menu('main-menu'))?.links).toEqual([
      { title: 'Eid Edit', url: '/collections/eid-edit' },
      { title: 'Footwear', url: '/collections/footwear' },
      { title: 'All products', url: '/collections/all' },
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
    // As written before documents had a version, or a handle.
    await publisher.queue.add(shopId, ['old']);
    await publisher.queue.drain(shopId, ({ writer }) => writer.putShop(SHOP_V1 as ShopDoc));
    await redis.hdel(keys.directory(), 'zari-fashions');

    unwrap(await products.update(tenant, { id: khussa.id, title: 'Multani Khussa' }));
    await deliver();
    expect((await store().shop()).version).toBe(DOCUMENTS_VERSION);
    expect(await publisher.directory.find('zari-fashions')).toBe(shopId);
  });
});

const SHOP_V1: Omit<ShopDoc, 'version' | 'handle'> = {
  name: 'Zari Fashions',
  domain: '',
  whatsapp: null,
  cod: { available: true, fee: 0, limit: null },
};
