import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { StorefrontSite, type MutationResult, type TenantContext } from '@hatti/api';
import {
  CollectionService,
  MediaService,
  ProductService,
  VariantService,
} from '@hatti/catalog/public';
import { DeliveryService } from '@hatti/checkout/public';
import { SecretBox, checkPassword } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { BrandService, FileService, readyImagesIn, shopLogoOf } from '@hatti/files/public';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import { MetaConversionsService, metaPixelIdIn } from '@hatti/marketing/public';
import {
  ArticleService,
  BlogService,
  CommentService,
  DomainService,
  MenuService,
  PageService,
  PolicyService,
  PreferencesService,
  ThemeService,
  TranslationService,
  UrlRedirectService,
  shopDomainsOf,
  shopPoliciesOf,
  shopRedirectsOf,
  digestOf,
  shopTranslationsOf,
  type TranslatableKind,
} from '@hatti/online-store/public';
import type { ObjectStorage } from '@hatti/storage';
import {
  DOCUMENTS_VERSION,
  RedisStore,
  StorefrontKeys,
  StoreMissingError,
  TranslatedStore,
  handleTag,
  pathTag,
  shopTag,
  type HandledKind,
  type MenuLinkDoc,
  type ShopDoc,
} from '@hatti/storefront-data';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDns } from '../testing/api.js';
import { StorefrontSweep } from '../worker/storefront-sweep.js';
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
    // What search engines are told is the product's own page's (ADR-231).
    expect(itemsFor(event('product.updated', { changed: ['seoTitle', 'seoDescription'] }))).toEqual(
      ['product:a1'],
    );
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

  it("rebuilds an article and its blog's listing, its articles when a blog moves, and menus' links (ADR-177)", () => {
    expect(itemsFor(event('blog.created', { handle: 'news' }))).toEqual(['blog:a1']);
    expect(itemsFor(event('blog.updated', { handle: 'news', changed: ['title'] }))).toEqual([
      'blog:a1',
    ]);
    expect(itemsFor(event('blog.updated', { handle: 'journal', changed: ['handle'] }))).toEqual([
      'blog:a1',
      'articles-in:a1',
      'menus',
    ]);
    expect(itemsFor(event('blog.deleted', { handle: 'news' }))).toEqual(['blog:a1', 'menus']);
    const article = { blogId: 'b1', handle: 'eid', isPublished: true };
    expect(itemsFor(event('article.created', article))).toEqual(['article:a1', 'blog:b1']);
    const updated = (changed: string[], previousBlogId: string | null = null) =>
      itemsFor(event('article.updated', { ...article, changed, previousBlogId }));
    expect(updated(['body', 'tags'])).toEqual(['article:a1', 'blog:b1']);
    expect(updated(['isPublished'])).toEqual(['article:a1', 'blog:b1', 'menus']);
    expect(updated(['blogId'], 'b0')).toEqual(['article:a1', 'blog:b1', 'blog:b0', 'menus']);
    expect(itemsFor(event('article.deleted', article))).toEqual(['article:a1', 'blog:b1', 'menus']);
  });

  it("rebuilds an article when a comment it shows changes, and a blog's articles with its policy (ADR-220)", () => {
    expect(
      itemsFor(event('blog.updated', { handle: 'news', changed: ['title', 'commentPolicy'] })),
    ).toEqual(['blog:a1', 'articles-in:a1']);
    for (const type of ['comment.created', 'comment.updated', 'comment.deleted']) {
      expect(itemsFor(event(type, { articleId: 'x1', status: 'published', shown: true }))).toEqual([
        'article:x1',
      ]);
      // One held for the shop, or spam all along, changes nothing shown.
      expect(itemsFor(event(type, { articleId: 'x1', status: 'pending', shown: false }))).toEqual(
        [],
      );
    }
  });

  it("rebuilds the shop when its storefront's preferences change", () => {
    expect(
      itemsFor(event('online_store_preferences.updated', { changed: ['whatsappNumber'] })),
    ).toEqual(['shop']);
  });

  it('rebuilds the shop when its delivery charges change', () => {
    expect(itemsFor(event('delivery_settings.updated', { changed: ['charge'] }))).toEqual(['shop']);
  });

  it('rebuilds the shop when its own domains change, which its document and the directory name', () => {
    for (const type of ['domain.created', 'domain.updated', 'domain.deleted']) {
      expect(itemsFor(event(type, { host: 'www.zari.pk' })), type).toEqual(['shop']);
    }
  });

  it("rebuilds the shop's policies when one changes, and the shop, whose document lists them", () => {
    expect(
      itemsFor(event('shop_policy.updated', { type: 'refund_policy', removed: false })),
    ).toEqual(['policies', 'shop']);
  });

  it('rebuilds the shop when its Meta pixel changes, whose document names it, and not otherwise', () => {
    const updated = (changed: string[]) =>
      itemsFor(event('meta_conversions.updated', { changed, actorKind: 'staff', actorId: 's1' }));
    expect(updated(['pixelId', 'accessToken'])).toEqual(['shop']);
    expect(updated(['testEventCode', 'purchaseAt'])).toEqual([]);
    expect(
      itemsFor(event('meta_conversions.deleted', { pixelId: '1234567890', actorKind: 'staff' })),
    ).toEqual(['shop']);
  });

  it('rebuilds the shop when its brand changes, or a file goes that may have been a logo (ADR-205)', () => {
    expect(itemsFor(event('shop_brand.updated', { changed: ['squareLogo'] }))).toEqual(['shop']);
    // A file deleted may have been an article's image too (ADR-213).
    expect(itemsFor(event('file.deleted', {}))).toEqual(['shop', 'every-article']);
  });

  it('publishes a shop whole once it is opened (ADR-145)', () => {
    expect(itemsFor(event('shop.opened', { handle: 'zari' }))).toEqual(['everything']);
  });

  it('rebuilds the redirects when one is made, changed or deleted', () => {
    for (const type of [
      'url_redirect.created',
      'url_redirect.updated',
      'url_redirect.deleted',
      'url_redirects.imported',
      'url_redirects.moved',
    ]) {
      const payload = { path: '/products/old-lawn', target: '/products/lawn' };
      expect(itemsFor(event(type, payload)), type).toEqual(['redirects']);
    }
  });

  it("rebuilds what a translation is of, and the menus for a menu's or its item's (ADR-238)", () => {
    const translated = (kind: string) =>
      itemsFor(event('translations.updated', { kind, locales: ['ur'], keys: ['title'] }));
    expect(
      ['product', 'collection', 'page', 'blog', 'article', 'menu', 'menuItem'].map(translated),
    ).toEqual([
      ['product:a1'],
      ['collection:a1'],
      ['page:a1'],
      ['blog:a1'],
      ['article:a1'],
      ['menus'],
      ['menus'],
    ]);
    // An option's or value's, its product's (ADR-241); without one, nothing.
    const option = (payload: Record<string, unknown>) =>
      itemsFor(event('translations.updated', { locales: ['ur'], keys: ['name'], ...payload }));
    expect(option({ kind: 'productOptionValue', productId: 'p1' })).toEqual(['product:p1']);
    expect(option({ kind: 'productOption', productId: 'p1' })).toEqual(['product:p1']);
    expect(option({ kind: 'productOption' })).toEqual([]);
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
  let blogs: BlogService;
  let articles: ArticleService;
  let preferences: PreferencesService;
  let delivery: DeliveryService;
  let domains: DomainService;
  let redirects: UrlRedirectService;
  let policies: PolicyService;
  let meta: MetaConversionsService;
  const dns = new TestDns();
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
    blogs = new BlogService(database);
    articles = new ArticleService(database);
    preferences = new PreferencesService(
      database,
      new SecretBox([{ id: 'test', key: Buffer.alloc(32, 3) }]),
      products,
    );
    delivery = new DeliveryService(database);
    domains = new DomainService(database, new StorefrontSite('https://hatti.pk'), dns);
    redirects = new UrlRedirectService(database);
    policies = new PolicyService(database, new StorefrontSite('https://hatti.pk'), domains);
    meta = new MetaConversionsService(
      database,
      new SecretBox([{ id: 'test', key: Buffer.alloc(32, 4) }]),
    );
    publisher = new StorefrontPublisher(
      database,
      redis,
      {
        products,
        collections,
        inventory,
        themes,
        menus,
        pages,
        blogs,
        articles,
        comments: new CommentService(database),
        preferences,
        delivery,
        domains: { domainsOf: shopDomainsOf },
        redirects: { redirectsOf: shopRedirectsOf },
        policies: { policiesOf: shopPoliciesOf },
        pixels: { metaPixelIdOf: metaPixelIdIn },
        brand: { logoOf: shopLogoOf },
        files: { readyImagesIn },
        translations: { translationsOf: shopTranslationsOf },
      },
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
      // No domains of its own: its handle's subdomain is its address.
      domain: '',
      domains: [],
      // The days its sessions are counted in (ADR-180).
      timezone: 'Asia/Karachi',
      whatsapp: null,
      cod: { available: true, fee: 0, limit: null },
      // It set no charges: delivery is free.
      delivery: { charge: 0, freeAbove: null, days: null, zones: [] },
      // It never touched its themes: the storefront shows the platform theme as it is.
      theme: null,
      // Open, as a shop is until it closes its storefront behind a password.
      password: null,
      // Crawlers read the platform's robots.txt alone.
      robotsRules: '',
      // No policies of its own yet.
      policies: [],
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
      updatedAt: about.updatedAt.toISOString(),
      seo: { title: null, description: null },
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

  it("publishes the shop's blogs, their published articles the latest first, and follows them (ADR-177)", async () => {
    const news = unwrap(await blogs.create(tenant, { title: 'News' }));
    const eid = unwrap(
      await articles.create(tenant, {
        blogId: news.id,
        title: 'Eid collection',
        body: '<p>Hand-block printed lawn.</p>',
        summary: '<p>Out now.</p>',
        author: 'Ayesha',
        tags: ['Eid', 'lawn'],
        publishDate: new Date('2026-09-01T09:00:00Z'),
      }),
    );
    const sizes = unwrap(await articles.create(tenant, { blogId: news.id, title: 'Sizes' }));
    unwrap(await articles.create(tenant, { blogId: news.id, title: 'Draft', isPublished: false }));
    await deliver();
    expect(await store().blogByHandle('news')).toEqual({
      id: news.id,
      handle: 'news',
      title: 'News',
      templateSuffix: null,
      articles: [
        { id: sizes.id, tags: [] },
        { id: eid.id, tags: ['Eid', 'lawn'] },
      ],
      commentPolicy: 'closed',
      updatedAt: news.updatedAt.toISOString(),
      seo: { title: null, description: null },
    });
    expect(await store().articleByHandle('news/eid-collection')).toEqual({
      id: eid.id,
      handle: 'eid-collection',
      blogHandle: 'news',
      title: 'Eid collection',
      bodyHtml: '<p>Hand-block printed lawn.</p>',
      summaryHtml: '<p>Out now.</p>',
      author: 'Ayesha',
      tags: ['Eid', 'lawn'],
      publishedAt: '2026-09-01T09:00:00.000Z',
      templateSuffix: null,
      // When it last changed, as its blog's feed says (ADR-209).
      updatedAt: eid.updatedAt.toISOString(),
      image: null,
      // Comments, none while its blog takes none (ADR-220).
      commentPolicy: 'closed',
      comments: [],
      commentsCount: 0,
      seo: { title: null, description: null },
    });
    expect(await store().articleByHandle('news/draft')).toBeNull();

    // The blog's new handle moves its articles' addresses.
    unwrap(await blogs.update(tenant, news.id, { handle: 'journal' }));
    await deliver();
    expect(await store().blogByHandle('news')).toBeNull();
    expect((await store().articleByHandle('journal/sizes'))?.id).toBe(sizes.id);
    expect(await store().articleByHandle('news/sizes')).toBeNull();

    // An article changed is forgotten at the edge, with its blog's page, which lists it.
    forgotten.length = 0;
    unwrap(await articles.update(tenant, sizes.id, { body: '<p>Measure twice.</p>' }));
    await deliver();
    expect(forgotten.flat()).toEqual(
      expect.arrayContaining([
        handleTag(shopId, 'article', 'journal/sizes'),
        handleTag(shopId, 'blog', 'journal'),
      ]),
    );

    // Moved to another blog, it leaves the one listing; hidden, it leaves the storefront.
    const guides = unwrap(await blogs.create(tenant, { title: 'Guides' }));
    unwrap(await articles.update(tenant, sizes.id, { blogId: guides.id }));
    unwrap(await articles.update(tenant, eid.id, { isPublished: false }));
    await deliver();
    expect((await store().blogByHandle('guides'))?.articles).toEqual([{ id: sizes.id, tags: [] }]);
    expect((await store().blogByHandle('journal'))?.articles).toEqual([]);
    expect((await store().articleByHandle('guides/sizes'))?.blogHandle).toBe('guides');
    expect(await store().articleByHandle('journal/eid-collection')).toBeNull();

    // A blog deleted takes its articles off with it.
    unwrap(await blogs.delete(tenant, guides.id));
    await deliver();
    expect(await store().blogByHandle('guides')).toBeNull();
    expect(await store().articleByHandle('guides/sizes')).toBeNull();
    expect(await store().handles('article')).toEqual([]);
  });

  it("names an article's image where the API serves it, and drops it when its file goes (ADR-213)", async () => {
    const [photo, plain] = [newId(), newId()];
    await admin.query(
      `INSERT INTO files.files (shop_id, id, key, filename, content_type, size, status, alt)
       VALUES ($1, $2, $3, 'lawn.webp', 'image/webp', 100, 'ready', 'Lawn'),
              ($1, $4, $5, 'plain.png', 'image/png', 100, 'ready', '')`,
      [
        shopId,
        photo,
        `shops/${shopId}/files/${photo}/lawn.webp`,
        plain,
        `shops/${shopId}/files/${plain}/plain.png`,
      ],
    );
    const lookbook = unwrap(await blogs.create(tenant, { title: 'Lookbook' }));
    const eid = unwrap(
      await articles.create(tenant, {
        blogId: lookbook.id,
        title: 'Eid lawn',
        image: { fileId: photo, altText: 'Lawn, folded' },
      }),
    );
    const sizes = unwrap(
      await articles.create(tenant, {
        blogId: lookbook.id,
        title: 'Sizes',
        image: { fileId: photo },
      }),
    );
    await deliver();
    const imageOf = async (handle: string) => (await store().articleByHandle(handle))?.image;
    expect(await imageOf('lookbook/eid-lawn')).toEqual({
      src: `http://localhost:4000/article-images/${shopId}/${eid.id}?v=${photo.slice(0, 8)}`,
      width: 0,
      height: 0,
      alt: 'Lawn, folded',
    });
    // Without alt text of its own, its file's.
    expect((await imageOf('lookbook/sizes'))?.alt).toBe('Lawn');

    // Another image is at another address, which pages and caches ask for anew.
    unwrap(await articles.update(tenant, sizes.id, { image: { fileId: plain } }));
    await deliver();
    const plainImage = {
      src: `http://localhost:4000/article-images/${shopId}/${sizes.id}?v=${plain.slice(0, 8)}`,
      width: 0,
      height: 0,
      alt: null,
    };
    expect(await imageOf('lookbook/sizes')).toEqual(plainImage);

    // Its file deleted, the article is shown without one.
    const files = new FileService(database, {
      delete: () => Promise.resolve(),
    } as unknown as ObjectStorage);
    unwrap(await files.delete(tenant, [photo]));
    expect(await deliver()).toEqual(['file.deleted']);
    expect(await imageOf('lookbook/eid-lawn')).toBeNull();
    expect(await imageOf('lookbook/sizes')).toEqual(plainImage);
    unwrap(await blogs.delete(tenant, lookbook.id));
    await deliver();
  });

  it("publishes an article's comments as its blog's policy says, and follows them (ADR-220)", async () => {
    const comments = new CommentService(database);
    const diary = unwrap(await blogs.create(tenant, { title: 'Diary' }));
    const eid = unwrap(await articles.create(tenant, { blogId: diary.id, title: 'Eid' }));
    await deliver();
    expect(await store().articleByHandle('diary/eid')).toMatchObject({
      commentPolicy: 'closed',
      comments: [],
      commentsCount: 0,
    });
    // Taking them changes the blog and its articles' pages.
    unwrap(await blogs.update(tenant, diary.id, { commentPolicy: 'moderated' }));
    await deliver();
    expect((await store().blogByHandle('diary'))?.commentPolicy).toBe('moderated');
    expect((await store().articleByHandle('diary/eid'))?.commentPolicy).toBe('moderated');

    // One held for the shop is not shown; approved, it is, escaped as text.
    const post = { blog: 'diary', article: 'eid', email: 'a@example.pk' };
    const held = unwrap(
      await comments.post(shopId, {
        ...post,
        author: 'Ayesha',
        body: 'Lovely <b>lawn</b>\nThanks',
      }),
    );
    expect(await deliver()).toEqual(['comment.created']);
    expect((await store().articleByHandle('diary/eid'))?.comments).toEqual([]);
    forgotten.length = 0;
    unwrap(await comments.approve(tenant, held.id));
    await deliver();
    expect(await store().articleByHandle('diary/eid')).toMatchObject({
      comments: [
        {
          id: held.id,
          author: 'Ayesha',
          bodyHtml: '<p>Lovely &lt;b&gt;lawn&lt;/b&gt;<br>Thanks</p>',
          createdAt: expect.any(String),
        },
      ],
      commentsCount: 1,
    });
    // The edge forgets the article's page.
    expect(forgotten.flat()).toContain(handleTag(shopId, 'article', 'diary/eid'));
    unwrap(await comments.markSpam(tenant, held.id));
    await deliver();
    expect((await store().articleByHandle('diary/eid'))?.commentsCount).toBe(0);
    unwrap(await blogs.delete(tenant, diary.id));
    await deliver();
    expect(eid.id).toBeTruthy();
  });

  it('publishes an article published at a time ahead once the worker shows it (ADR-215)', async () => {
    const diary = unwrap(await blogs.create(tenant, { title: 'Diary' }));
    const sale = unwrap(
      await articles.create(tenant, {
        blogId: diary.id,
        title: 'Sale',
        publishDate: new Date(Date.now() + 86_400_000),
      }),
    );
    await deliver();
    expect(await store().articleByHandle('diary/sale')).toBeNull();
    expect((await store().blogByHandle('diary'))?.articles).toEqual([]);

    // Its time come, the worker shows it, and the storefront follows.
    await admin.query(
      "UPDATE online_store.articles SET published_at = now() - interval '1 minute' WHERE id = $1",
      [sale.id],
    );
    expect(await articles.showDue(shopId)).toBe(1);
    expect(await deliver()).toEqual(['article.updated']);
    expect((await store().articleByHandle('diary/sale'))?.id).toBe(sale.id);
    expect((await store().blogByHandle('diary'))?.articles).toEqual([{ id: sale.id, tags: [] }]);
    unwrap(await blogs.delete(tenant, diary.id));
    await deliver();
  });

  it('publishes a page published at a time ahead once the worker shows it (ADR-217)', async () => {
    const sale = unwrap(
      await pages.create(tenant, {
        title: 'Eid sale',
        publishDate: new Date(Date.now() + 86_400_000),
      }),
    );
    await deliver();
    expect(await store().pageByHandle('eid-sale')).toBeNull();
    await admin.query(
      "UPDATE online_store.pages SET published_at = now() - interval '1 minute' WHERE id = $1",
      [sale.id],
    );
    expect(await pages.showDue(shopId)).toBe(1);
    expect(await deliver()).toEqual(['page.updated']);
    expect((await store().pageByHandle('eid-sale'))?.id).toBe(sale.id);
    unwrap(await pages.delete(tenant, sale.id));
    await deliver();
  });

  it("publishes menus' links to blogs and articles, following their handles and showing (ADR-178)", async () => {
    const stories = unwrap(await blogs.create(tenant, { title: 'Stories' }));
    const lawn = unwrap(
      await articles.create(tenant, { blogId: stories.id, title: 'Lawn in the making' }),
    );
    const footer = (await menus.list(tenant, { first: 50 })).items.find(
      (menu) => menu.handle === 'footer',
    )!;
    unwrap(
      await menus.update(tenant, footer.id, {
        title: 'Footer menu',
        items: [
          { title: 'Stories', type: 'blog', resourceId: stories.id },
          { title: 'Lawn', type: 'article', resourceId: lawn.id },
        ],
      }),
    );
    await deliver();
    const links = async () =>
      (await store().menu('footer'))!.links.map((link) => `${link.title} ${link.url} ${link.type}`);
    expect(await links()).toEqual([
      'Stories /blogs/stories blog_link',
      'Lawn /blogs/stories/lawn-in-the-making article_link',
    ]);
    unwrap(await blogs.update(tenant, stories.id, { handle: 'making' }));
    await deliver();
    expect(await links()).toEqual([
      'Stories /blogs/making blog_link',
      'Lawn /blogs/making/lawn-in-the-making article_link',
    ]);
    // An article hidden is no link.
    unwrap(await articles.update(tenant, lawn.id, { isPublished: false }));
    await deliver();
    expect(await links()).toEqual(['Stories /blogs/making blog_link']);
  });

  it('publishes what the shop wrote in Urdu beside its own words, and follows it (ADR-238)', async () => {
    const translations = new TranslationService(
      database,
      products,
      collections,
      pages,
      blogs,
      articles,
      menus,
    );
    const kurta = unwrap(
      await products.create(tenant, {
        title: 'Cotton Kurta',
        status: 'active',
        description: 'Soft cotton.\nHand wash.',
        variants: [{ price: '2,500' }],
      }),
    );
    const guide = unwrap(
      await pages.create(tenant, {
        title: 'Size guide',
        body: '<p>Measure twice.</p>',
        seo: { title: 'Sizes', description: null },
      }),
    );
    const care = unwrap(
      await menus.create(tenant, {
        title: 'Customer care',
        handle: 'customer-care',
        items: [
          { title: 'Track your order', type: 'http', url: '/pages/track' },
          { title: 'Home', type: 'frontpage' },
        ],
      }),
    );
    const translate = async (kind: TranslatableKind, id: string, words: Record<string, string>) => {
      const { content } = (await translations.resource(tenant, kind, id))!;
      unwrap(
        await translations.register(
          tenant,
          kind,
          id,
          Object.entries(words).map(([key, value]) => ({
            locale: 'ur',
            key,
            value,
            translatableContentDigest: content.find((field) => field.key === key)!.digest,
          })),
        ),
      );
    };
    await translate('product', kurta.id, {
      title: 'سوتی کرتا',
      body_html: '<p>نرم سوتی۔<br>ہاتھ سے دھوئیں۔</p>',
    });
    await translate('page', guide.id, { title: 'سائز گائیڈ', meta_title: 'سائز' });
    await translate('menuItem', care.items[0]!.id, { title: 'آرڈر ٹریک کریں' });
    await deliver();

    // Each document has the shop's own words, and its Urdu beside them, a description shown as
    // the product's own is.
    const [kurtaDoc] = await store().products([kurta.id]);
    expect([kurtaDoc!.title, kurtaDoc!.translations]).toEqual([
      'Cotton Kurta',
      { ur: { title: 'سوتی کرتا', descriptionHtml: '<p>نرم سوتی۔<br>ہاتھ سے دھوئیں۔</p>' } },
    ]);
    expect((await store().pageByHandle('size-guide'))!.translations).toEqual({
      ur: { title: 'سائز گائیڈ', seo: { title: 'سائز' } },
    });
    // A menu's links in Urdu, those not translated in the shop's own words.
    expect((await store().menu('customer-care'))!.translations).toEqual({
      ur: {
        links: [
          { title: 'آرڈر ٹریک کریں', url: '/pages/track', type: 'http_link', links: [] },
          { title: 'Home', url: '/', type: 'frontpage_link', links: [] },
        ],
      },
    });

    // Removed, the shop's own words are all there is again.
    unwrap(await translations.remove(tenant, 'product', kurta.id, ['title', 'body_html'], ['ur']));
    unwrap(await translations.remove(tenant, 'menuItem', care.items[0]!.id, ['title'], ['ur']));
    await deliver();
    expect((await store().products([kurta.id]))[0]!.translations).toBeUndefined();
    expect((await store().menu('customer-care'))!.translations).toBeUndefined();
    expect((await store().pageByHandle('size-guide'))!.translations?.ur?.title).toBe('سائز گائیڈ');
  });

  it("publishes a product's options in Urdu beside its own, its variants shown in them (ADR-241)", async () => {
    const translations = new TranslationService(
      database,
      products,
      collections,
      pages,
      blogs,
      articles,
      menus,
    );
    const suit = unwrap(
      await products.create(tenant, {
        title: 'Lawn Suit',
        status: 'active',
        options: [
          { name: 'Size', values: ['Small', 'Large', 'XL'] },
          { name: 'Colour', values: ['Red', 'Blue'] },
        ],
        variants: [
          { optionValues: ['Small', 'Red'], price: '4,990' },
          { optionValues: ['Large', 'Red'], price: '5,190' },
          { optionValues: ['Large', 'Blue'], price: '5,190' },
        ],
      }),
    );
    const [size, colour] = [suit.options[0]!, suit.options[1]!];
    const name = (kind: TranslatableKind, id: string, own: string, value: string) =>
      translations.register(tenant, kind, id, [
        { locale: 'ur', key: 'name', value, translatableContentDigest: digestOf(own) },
      ]);
    unwrap(await name('productOption', size.id, 'Size', 'سائز'));
    // XL, which no variant has; Red and Blue alike, which a shopper could not tell apart.
    const words = ['چھوٹا', 'بڑا', 'بہت بڑا', 'لال', 'لال'];
    for (const [index, value] of [...size.values, ...colour.values].entries()) {
      unwrap(await name('productOptionValue', value.id, value.name, words[index]!));
    }
    await deliver();

    const [doc] = await store().products([suit.id]);
    expect(doc!.options).toEqual([
      { name: 'Size', values: ['Small', 'Large'] },
      { name: 'Colour', values: ['Red', 'Blue'] },
    ]);
    expect(doc!.translations).toEqual({
      ur: {
        options: [
          { name: 'سائز', values: ['چھوٹا', 'بڑا'] },
          { name: 'Colour', values: ['Red', 'Blue'] },
        ],
      },
    });
    // As an Urdu page shows it: each variant's values and title in them, its ID its own.
    const shown = await new TranslatedStore(store(), 'ur').productByHandle(doc!.handle);
    expect(shown!.options).toEqual(doc!.translations!.ur!.options);
    expect(shown!.variants.map((variant) => [variant.id, variant.title, variant.options])).toEqual([
      [doc!.variants[0]!.id, 'چھوٹا / Red', ['چھوٹا', 'Red']],
      [doc!.variants[1]!.id, 'بڑا / Red', ['بڑا', 'Red']],
      [doc!.variants[2]!.id, 'بڑا / Blue', ['بڑا', 'Blue']],
    ]);

    // Removed, but for words that change nothing shown, its own words alone.
    unwrap(await translations.remove(tenant, 'productOption', size.id, ['name'], ['ur']));
    for (const value of size.values) {
      unwrap(await translations.remove(tenant, 'productOptionValue', value.id, ['name'], ['ur']));
    }
    await deliver();
    expect((await store().products([suit.id]))[0]!.translations).toBeUndefined();
  });

  it("publishes the shop's WhatsApp number, and takes it off when the shop does", async () => {
    unwrap(await preferences.update(tenant, { whatsappNumber: '0300 1234567' }));
    expect(await deliver()).toEqual(['online_store_preferences.updated']);
    expect((await store().shop()).whatsapp).toBe('+923001234567');
    unwrap(await preferences.update(tenant, { whatsappNumber: null }));
    await deliver();
    expect((await store().shop()).whatsapp).toBeNull();
  });

  it("closes the shop's storefront behind its password, with what shoppers are told, and opens it", async () => {
    forgotten.length = 0;
    unwrap(
      await preferences.update(tenant, {
        passwordEnabled: true,
        password: 'eid-2026',
        passwordMessage: 'Opening on Chand Raat <soon>.',
      }),
    );
    await deliver();
    const closed = (await store().shop()).password!;
    expect(closed.message).toBe('<p>Opening on Chand Raat &#60;soon&#62;.</p>');
    // A verifier of the password, never the password.
    expect(closed.verifier).not.toContain('eid-2026');
    expect(await checkPassword('eid-2026', closed.verifier)).toBe(true);
    // Every page changes: none may be kept for shoppers without it.
    expect(forgotten.flat()).toContain(shopTag(shopId));
    unwrap(await preferences.update(tenant, { passwordEnabled: false }));
    await deliver();
    expect((await store().shop()).password).toBeNull();
  });

  it("publishes the shop's storefront paused, what shoppers are told and when it opens, and opens it (ADR-252)", async () => {
    forgotten.length = 0;
    const until = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    unwrap(
      await preferences.update(tenant, {
        maintenanceEnabled: true,
        maintenanceMessage: 'Back after Eid <soon>.',
        maintenanceUntil: until,
      }),
    );
    await deliver();
    // As typed: the storefront's page escapes it.
    expect((await store().shop()).maintenance).toEqual({
      message: 'Back after Eid <soon>.',
      until: until.toISOString(),
    });
    // Every page changes: none may be kept while it is paused.
    expect(forgotten.flat()).toContain(shopTag(shopId));
    unwrap(await preferences.update(tenant, { maintenanceEnabled: false }));
    await deliver();
    expect((await store().shop()).maintenance).toBeUndefined();
  });

  it("publishes the shop's own robots.txt rules, as the online store checked them", async () => {
    unwrap(await preferences.update(tenant, { robotsTxtRules: 'disallow: /collections/sale' }));
    await deliver();
    expect((await store().shop()).robotsRules).toBe('Disallow: /collections/sale');
    unwrap(await preferences.update(tenant, { robotsTxtRules: '' }));
    await deliver();
    expect((await store().shop()).robotsRules).toBe('');
  });

  it("publishes the shop's link page while it has one, for /links (ADR-161)", async () => {
    forgotten.length = 0;
    const page = {
      bio: 'Lawn and khussas.',
      links: [{ title: 'Eid Edit', url: '/collections/eid-edit' }],
      // A draft now: the storefront leaves it out while it is.
      productIds: [khussa.id],
    };
    unwrap(await preferences.update(tenant, { linkPage: page }));
    await deliver();
    expect((await store().shop()).linkPage).toEqual(page);
    // The shop's document changed, and the pages with it.
    expect(forgotten.flat()).toContain(shopTag(shopId));
    // The variants chosen, by their products' places, while any is (ADR-206).
    const suit = unwrap(
      await products.create(tenant, {
        title: 'Eid Suit',
        status: 'active',
        options: [{ name: 'Size', values: ['M', 'L'] }],
        variants: [
          { optionValues: ['M'], price: '6,500' },
          { optionValues: ['L'], price: '6,900' },
        ],
      }),
    );
    unwrap(
      await preferences.update(tenant, {
        linkPage: {
          products: [
            { productId: suit.id, variantId: suit.variants[1]!.id },
            { productId: khussa.id },
          ],
        },
      }),
    );
    await deliver();
    expect((await store().shop()).linkPage).toMatchObject({
      productIds: [suit.id, khussa.id],
      variantIds: [suit.variants[1]!.id, null],
    });
    unwrap(await preferences.update(tenant, { linkPage: { bio: '', links: [], productIds: [] } }));
    await deliver();
    expect((await store().shop()).linkPage).toBeUndefined();
  });

  it("publishes the shop's policies, their bodies apart, and lists them in its document", async () => {
    forgotten.length = 0;
    unwrap(await policies.update(tenant, { type: 'shipping_policy', body: '<p>Rs 250.</p>' }));
    unwrap(await policies.update(tenant, { type: 'refund_policy', body: '<p>7 days.</p>' }));
    await deliver();
    expect((await store().shop()).policies).toEqual(['refund_policy', 'shipping_policy']);
    expect(await store().policy('refund_policy')).toBe('<p>7 days.</p>');
    expect(forgotten.flat()).toContain(shopTag(shopId));
    unwrap(await policies.update(tenant, { type: 'refund_policy', body: '' }));
    unwrap(await policies.update(tenant, { type: 'shipping_policy', body: '' }));
    await deliver();
    expect((await store().shop()).policies).toEqual([]);
    expect(await store().policy('refund_policy')).toBeNull();
  });

  it("publishes a policy's Urdu beside it while it translates the policy as it is (ADR-239)", async () => {
    const translations = new TranslationService(
      database,
      products,
      collections,
      pages,
      blogs,
      articles,
      menus,
    );
    unwrap(await policies.update(tenant, { type: 'refund_policy', body: '<p>7 days.</p>' }));
    const [refund] = (await translations.resources(tenant, 'shopPolicy', { first: 10 })).items;
    unwrap(
      await translations.register(tenant, 'shopPolicy', refund!.id, [
        {
          locale: 'ur',
          key: 'body',
          value: '<p>سات دن۔</p>',
          translatableContentDigest: refund!.content[0]!.digest,
        },
      ]),
    );
    forgotten.length = 0;
    await deliver();
    // On an Urdu page, its Urdu; on others, and where it has none, its own words.
    expect(await store().policy('refund_policy', 'ur')).toBe('<p>سات دن۔</p>');
    expect(await store().policy('refund_policy')).toBe('<p>7 days.</p>');
    expect(await store().policy('shipping_policy', 'ur')).toBeNull();
    expect(forgotten.flat()).toContain(shopTag(shopId));

    // The policy changes: until its Urdu is written again, Urdu pages show its own words.
    unwrap(await policies.update(tenant, { type: 'refund_policy', body: '<p>14 days.</p>' }));
    await deliver();
    expect(await store().policy('refund_policy', 'ur')).toBe('<p>14 days.</p>');
    unwrap(await policies.update(tenant, { type: 'refund_policy', body: '' }));
    await deliver();
    expect(await store().policy('refund_policy', 'ur')).toBeNull();
  });

  it("publishes the shop's Meta pixel while it has Meta connected, for its pages to load", async () => {
    // A shop without one keeps its document as it was.
    expect(Object.keys(await store().shop())).not.toContain('metaPixelId');
    forgotten.length = 0;
    unwrap(
      await meta.update(tenant, { pixelId: '1234567890', accessToken: 'EAAG'.padEnd(40, 'x') }),
    );
    expect(await deliver()).toEqual(['meta_conversions.updated']);
    expect((await store().shop()).metaPixelId).toBe('1234567890');
    // Every page loads it: none kept without it may be shown.
    expect(forgotten.flat()).toContain(shopTag(shopId));
    // What its pages do not show changes nothing of theirs.
    forgotten.length = 0;
    unwrap(await meta.update(tenant, { testEventCode: 'TEST4242' }));
    await deliver();
    expect(forgotten).toEqual([]);
    unwrap(await meta.update(tenant, { pixelId: '9876543210' }));
    await deliver();
    expect((await store().shop()).metaPixelId).toBe('9876543210');
    expect(await meta.delete(tenant)).toBe('9876543210');
    expect(await deliver()).toEqual(['meta_conversions.deleted']);
    expect(Object.keys(await store().shop())).not.toContain('metaPixelId');
    expect(forgotten.flat()).toContain(shopTag(shopId));
  });

  it("publishes where the shop's logos are served, each address naming its image (ADR-205)", async () => {
    // A shop without one keeps its document as it was.
    expect(Object.keys(await store().shop())).not.toContain('brand');
    const brands = new BrandService(database);
    const [logo, square] = [newId(), newId()];
    await admin.query(
      `INSERT INTO files.files (shop_id, id, key, filename, content_type, size, status)
       VALUES ($1, $2, $3, 'logo.png', 'image/png', 100, 'ready'),
              ($1, $4, $5, 'square.png', 'image/png', 100, 'ready')`,
      [
        shopId,
        logo,
        `shops/${shopId}/files/${logo}/logo.png`,
        square,
        `shops/${shopId}/files/${square}/square.png`,
      ],
    );
    forgotten.length = 0;
    unwrap(await brands.update(tenant, { logo, squareLogo: square }));
    expect(await deliver()).toEqual(['shop_brand.updated']);
    expect((await store().shop()).brand).toEqual({
      logo: `http://localhost:4000/logos/${shopId}?v=${logo.slice(0, 8)}`,
      squareLogo: `http://localhost:4000/logos/${shopId}/square?v=${square.slice(0, 8)}`,
    });
    expect(forgotten.flat()).toContain(shopTag(shopId));
    unwrap(await brands.update(tenant, { squareLogo: null }));
    await deliver();
    expect((await store().shop()).brand).toEqual({
      logo: `http://localhost:4000/logos/${shopId}?v=${logo.slice(0, 8)}`,
      squareLogo: null,
    });
    unwrap(await brands.update(tenant, { logo: null }));
    await deliver();
    expect(Object.keys(await store().shop())).not.toContain('brand');
  });

  it("publishes its home page's title and description, and where its sharing image is (ADR-243)", async () => {
    // A shop that set neither keeps its document as it was.
    expect(Object.keys(await store().shop())).not.toContain('seo');
    const image = newId();
    await admin.query(
      `INSERT INTO files.files (shop_id, id, key, filename, content_type, size, status)
       VALUES ($1, $2, $3, 'share.jpg', 'image/jpeg', 100, 'ready')`,
      [shopId, image, `shops/${shopId}/files/${image}/share.jpg`],
    );
    unwrap(
      await preferences.update(tenant, {
        seo: { title: 'Zari | Lawn in Lahore', description: 'Lawn and bridal, delivered.' },
        sharingImage: { fileId: image, altText: 'Three lawn suits' },
      }),
    );
    expect(await deliver()).toEqual(['online_store_preferences.updated']);
    const shop = await store().shop();
    expect([shop.seo, shop.sharingImage]).toEqual([
      { title: 'Zari | Lawn in Lahore', description: 'Lawn and bridal, delivered.' },
      {
        src: `http://localhost:4000/sharing-images/${shopId}?v=${image.slice(0, 8)}`,
        width: 0,
        height: 0,
        alt: 'Three lawn suits',
      },
    ]);

    // Its file deleted, it has none; taken away, nor the title and description.
    const files = new FileService(database, {
      delete: () => Promise.resolve(),
    } as unknown as ObjectStorage);
    unwrap(await files.delete(tenant, [image]));
    expect(await deliver()).toEqual(['file.deleted']);
    expect(Object.keys(await store().shop())).not.toContain('sharingImage');
    unwrap(await preferences.update(tenant, { seo: null, sharingImage: null }));
    await deliver();
    expect(Object.keys(await store().shop())).not.toContain('seo');
  });

  it("publishes a blog's own title and description for search engines, and in Urdu (ADR-244)", async () => {
    const translations = new TranslationService(
      database,
      products,
      collections,
      pages,
      blogs,
      articles,
      menus,
    );
    const notes = unwrap(
      await blogs.create(tenant, {
        title: 'Style notes',
        seo: { title: 'How to wear lawn', description: 'Notes on lawn, from Lahore.' },
      }),
    );
    const { content } = (await translations.resource(tenant, 'blog', notes.id))!;
    expect(content.map((field) => field.key)).toEqual(['title', 'meta_title', 'meta_description']);
    unwrap(
      await translations.register(tenant, 'blog', notes.id, [
        {
          locale: 'ur',
          key: 'meta_title',
          value: 'لان کیسے پہنیں',
          translatableContentDigest: content.find((field) => field.key === 'meta_title')!.digest,
        },
      ]),
    );
    await deliver();
    const doc = await store().blogByHandle('style-notes');
    expect([doc!.seo, doc!.translations]).toEqual([
      { title: 'How to wear lawn', description: 'Notes on lawn, from Lahore.' },
      { ur: { seo: { title: 'لان کیسے پہنیں' } } },
    ]);

    // Changed, the storefront has it as it is now.
    unwrap(await blogs.update(tenant, notes.id, { seo: { description: null } }));
    await deliver();
    expect((await store().blogByHandle('style-notes'))!.seo).toEqual({
      title: 'How to wear lawn',
      description: null,
    });
  });

  it("publishes its home page's words in Urdu beside its own, and forgets all its pages (ADR-245)", async () => {
    const translations = new TranslationService(
      database,
      products,
      collections,
      pages,
      blogs,
      articles,
      menus,
    );
    unwrap(
      await preferences.update(tenant, {
        seo: { title: 'Zari | Lawn in Lahore', description: 'Lawn and bridal, delivered.' },
      }),
    );
    await deliver();
    const { content } = (await translations.resource(tenant, 'shop', shopId))!;
    unwrap(
      await translations.register(tenant, 'shop', shopId, [
        {
          locale: 'ur',
          key: 'meta_description',
          value: 'لان اور عروسی جوڑے، گھر تک۔',
          translatableContentDigest: content.find((field) => field.key === 'meta_description')!
            .digest,
        },
      ]),
    );
    forgotten.length = 0;
    expect(await deliver()).toEqual(['translations.updated']);
    const shop = await store().shop();
    expect([shop.seo, shop.translations]).toEqual([
      { title: 'Zari | Lawn in Lahore', description: 'Lawn and bridal, delivered.' },
      { ur: { seo: { description: 'لان اور عروسی جوڑے، گھر تک۔' } } },
    ]);
    // Its description is on every page of its: they are all forgotten at the edge.
    expect(forgotten.flat()).toEqual([shopTag(shopId)]);

    // Removed, its own words alone again.
    unwrap(await translations.remove(tenant, 'shop', shopId, ['meta_description'], ['ur']));
    unwrap(await preferences.update(tenant, { seo: null }));
    await deliver();
    expect(Object.keys(await store().shop())).not.toContain('translations');
  });

  it('publishes what the shop charges for delivery, and how many working days it takes', async () => {
    unwrap(
      await delivery.update(tenant, {
        charge: '250',
        freeAbove: '5,000',
        days: { min: 2, max: 4 },
        zones: [{ name: 'Karachi', cities: ['khi'], charge: '150', days: { min: 1, max: 1 } }],
      }),
    );
    expect(await deliver()).toEqual(['delivery_settings.updated']);
    expect((await store().shop()).delivery).toEqual({
      charge: 25_000,
      freeAbove: 500_000,
      days: { min: 2, max: 4 },
      zones: [{ name: 'Karachi', cities: ['Karachi'], charge: 15_000, days: { min: 1, max: 1 } }],
    });
    unwrap(await delivery.update(tenant, { freeAbove: null, days: null, zones: [] }));
    await deliver();
    expect((await store().shop()).delivery).toEqual({
      charge: 25_000,
      freeAbove: null,
      days: null,
      zones: [],
    });
  });

  it("points the directory at the shop's own domains once DNS does, and names its primary one", async () => {
    const www = unwrap(await domains.create(tenant, { host: 'www.zari.pk' }));
    const apex = unwrap(await domains.create(tenant, { host: 'zari.pk' }));
    await deliver();
    // Not served until they point at the platform.
    expect(await publisher.directory.findDomain('www.zari.pk')).toBeNull();
    dns.records.set('www.zari.pk', { cnames: ['shops.hatti.pk'] });
    dns.records.set('zari.pk', { addresses: ['104.16.1.1'] });
    dns.records.set('shops.hatti.pk', { addresses: ['104.16.1.1', '104.16.2.2'] });
    unwrap(await domains.verify(tenant, www.id));
    unwrap(await domains.verify(tenant, apex.id));
    unwrap(await domains.update(tenant, www.id, { isPrimary: true }));
    await deliver();
    expect(await publisher.directory.findDomain('www.zari.pk')).toBe(shopId);
    expect(await publisher.directory.findDomain('zari.pk')).toBe(shopId);
    expect(await store().shop()).toMatchObject({
      domain: 'www.zari.pk',
      domains: ['www.zari.pk', 'zari.pk'],
    });

    // Let go, a domain is no longer the shop's; primary no more, the handle's subdomain is.
    unwrap(await domains.delete(tenant, apex.id));
    unwrap(await domains.update(tenant, www.id, { isPrimary: false }));
    await deliver();
    expect(await publisher.directory.findDomain('zari.pk')).toBeNull();
    expect(await store().shop()).toMatchObject({ domain: '', domains: ['www.zari.pk'] });
    unwrap(await domains.delete(tenant, www.id));
    await deliver();
    expect(await publisher.directory.findDomain('www.zari.pk')).toBeNull();
  });

  it("publishes the shop's URL redirects, and has the edge forget what was answered at their paths", async () => {
    /** Delivers what happened: what the edge was told to forget. */
    const forget = async (): Promise<string[]> => {
      forgotten.length = 0;
      await deliver();
      return forgotten.flat().sort();
    };
    const target = (path: string) => store().redirect(path);
    const lawnSuit = unwrap(
      await redirects.create(tenant, { path: '/products/Old-Lawn', target: '/products/lawn-suit' }),
    );
    const about = unwrap(
      await redirects.create(tenant, { path: '/pages/about-us', target: '/pages/our-story' }),
    );
    expect(await forget()).toEqual(
      [pathTag(shopId, '/pages/about-us'), pathTag(shopId, '/products/old-lawn')].sort(),
    );
    expect(await target('/products/old-lawn')).toBe('/products/lawn-suit');
    expect(await target('/pages/about-us')).toBe('/pages/our-story');

    unwrap(await redirects.update(tenant, lawnSuit.id, { path: '/products/lawn-2024' }));
    unwrap(await redirects.delete(tenant, about.id));
    expect(await forget()).toEqual(
      [
        pathTag(shopId, '/pages/about-us'),
        pathTag(shopId, '/products/lawn-2024'),
        pathTag(shopId, '/products/old-lawn'),
      ].sort(),
    );
    expect(await target('/products/old-lawn')).toBeNull();
    expect(await target('/products/lawn-2024')).toBe('/products/lawn-suit');
    expect(await target('/pages/about-us')).toBeNull();

    // Many at once, as from an old store: all of the shop's pages, in one call.
    for (let n = 0; n < 30; n += 1) {
      unwrap(await redirects.create(tenant, { path: `/blogs/news/${n}`, target: '/blogs/news' }));
    }
    expect(await forget()).toEqual([shopTag(shopId)]);
    expect(await target('/blogs/news/29')).toBe('/blogs/news');
    // Built whole, as a shop is when its documents are lost, they stay; those gone from the
    // database while no event said so go.
    expect(await publisher.publishAll(shopId)).toBeGreaterThan(0);
    expect(await target('/blogs/news/29')).toBe('/blogs/news');
    await admin.query('DELETE FROM online_store.url_redirects WHERE shop_id = $1', [shopId]);
    await publisher.publishAll(shopId);
    expect(await target('/products/lawn-2024')).toBeNull();
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

  it("builds what an event's publisher gave up on once the shop is quiet, as the worker sweeps (ADR-225)", async () => {
    const ajrak = unwrap(
      await products.create(tenant, {
        title: 'Ajrak Shawl',
        status: 'active',
        variants: [{ price: '3,500' }],
      }),
    );
    // Its event's tries ran out: its item waits, and the shop is listed.
    await admin.query('UPDATE platform.outbox_events SET published_at = now()');
    await publisher.queue.add(shopId, [`product:${ajrak.id}`]);
    expect(await handles('ajrak-shawl')).toEqual([null]);
    const sweep = new StorefrontSweep(publisher, undefined, 0);
    expect(await sweep.sweep()).toBeGreaterThan(0);
    expect(await handles('ajrak-shawl')).toEqual(['Ajrak Shawl']);
    // Nothing left: off the list, and the next sweep builds nothing.
    expect(await redis.zscore(keys.waiting(), shopId)).toBeNull();
    expect(await sweep.sweep()).toBe(0);
  });
});

const SHOP_V1: Omit<ShopDoc, 'version' | 'handle' | 'theme'> = {
  name: 'Zari Fashions',
  domain: '',
  whatsapp: null,
  cod: { available: true, fee: 0, limit: null },
};
