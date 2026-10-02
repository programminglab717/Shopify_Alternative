import { shopProfile } from '@hatti/api';
import {
  CatalogEvents,
  CollectionService,
  ProductService,
  VariantService,
  type CollectionRecord,
  type ProductUpdatedPayload,
} from '@hatti/catalog/public';
import { CheckoutEvents, DeliveryService } from '@hatti/checkout/public';
import type { Database, Tx } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import {
  InventoryEvents,
  InventoryService,
  type LocationUpdatedPayload,
} from '@hatti/inventory/public';
import { ShopEvents } from '@hatti/identity/public';
import {
  MarketingEvents,
  metaPixelIdIn,
  type MetaConversionsUpdatedPayload,
} from '@hatti/marketing/public';
import {
  MenuService,
  OnlineStoreEvents,
  PageService,
  ThemeService,
  shopDomainsOf,
  shopPoliciesOf,
  shopPreferencesOf,
  shopRedirectsOf,
  type DomainRecord,
  type PageRecord,
  type PageUpdatedPayload,
  type PreferencesRecord,
  type ThemeUpdatedPayload,
} from '@hatti/online-store/public';
import {
  BuildQueue,
  DOCUMENTS_VERSION,
  ShopDirectory,
  StorefrontKeys,
  handleTag,
  pathTag,
  shopTag,
  type Batch,
  type HandledKind,
  type ShopDoc,
} from '@hatti/storefront-data';
import type { Redis } from 'ioredis';
import {
  ALL_PRODUCTS,
  allProductsDoc,
  collectionDoc,
  menuDoc,
  pageDoc,
  productDoc,
  shopDoc,
  themeDoc,
} from './documents.js';
import { NO_EDGE_CACHE, type EdgeCache } from './edge-cache.js';

/**
 * What the publisher builds, as items of a shop's build queue. The first ones stand for many
 * others, found when they are taken; the queue holds each item once, however often it is asked.
 */
export const Items = {
  everything: 'everything',
  everyProduct: 'every-product',
  everyCollection: 'every-collection',
  everyPage: 'every-page',
  smartCollections: 'smart-collections',
  /** The collections a product is in now. */
  collectionsWith: (productId: string) => `collections-with:${productId}`,
  /**
   * The shop's settings, preferences and delivery charges, its Meta pixel, and its main theme,
   * the theme written first.
   */
  shop: 'shop',
  product: (id: string) => `product:${id}`,
  collection: (id: string) => `collection:${id}`,
  page: (id: string) => `page:${id}`,
  allProducts: 'all-products',
  menus: 'menus',
  /** The shop's URL redirects, written together. */
  redirects: 'redirects',
  /** The shop's policies' bodies, written together; the shop's document lists them. */
  policies: 'policies',
} as const;

/**
 * Taken in this order: what stands for many first, then products and the shop, then listings,
 * so a listing seldom names a product whose document is not written yet; menus and redirects
 * last.
 */
function priority(item: string): number {
  if (item.startsWith('product:') || item.startsWith('page:')) return 1;
  if (item.startsWith('collection:') || item === Items.allProducts) return 2;
  if (item === Items.menus || item === Items.redirects || item === Items.policies) return 3;
  return 0;
}

/**
 * Product fields no listing depends on: changing only these rebuilds the product alone, and the
 * menus for a new handle.
 */
const OWN_FIELDS = new Set(['description', 'handle', 'media']);

/** Page fields menus' links follow: where they lead, and whether they show. */
const LINKED_PAGE_FIELDS = new Set(['handle', 'isPublished']);

/** Location fields that decide whether its stock is sold online. */
const SELLING_FIELDS = new Set(['isActive', 'fulfillsOnlineOrders']);

/** The storefront documents an event makes stale (03 §8). */
export function itemsFor(event: DomainEvent): string[] {
  const id = event.aggregateId;
  switch (event.type) {
    case CatalogEvents.ProductCreated:
      return [Items.product(id), Items.collectionsWith(id), Items.allProducts, Items.menus];
    case CatalogEvents.ProductUpdated: {
      const { changed } = event.payload as unknown as ProductUpdatedPayload;
      if (changed.every((name) => OWN_FIELDS.has(name))) {
        // A menu may link to it, by its handle.
        return changed.includes('handle') ? [Items.product(id), Items.menus] : [Items.product(id)];
      }
      // Its listings may change order or drop it: smart collections it left no longer hold it.
      return [
        Items.product(id),
        Items.collectionsWith(id),
        Items.smartCollections,
        Items.allProducts,
        Items.menus,
      ];
    }
    case CatalogEvents.ProductDeleted:
      // Its memberships went with it, so which listings named it is not known: all are rebuilt.
      return [Items.product(id), Items.everyCollection, Items.allProducts, Items.menus];
    case CatalogEvents.CollectionCreated:
    case CatalogEvents.CollectionUpdated:
    case CatalogEvents.CollectionDeleted:
      // A collection may take or give back the handle "all".
      return [Items.collection(id), Items.allProducts, Items.menus];
    case InventoryEvents.InventoryItemUpdated:
    case InventoryEvents.InventoryLevelUpdated:
      return [Items.product((event.payload as { productId: string }).productId)];
    case InventoryEvents.LocationUpdated: {
      // Whether a location sells online, or at all, changes what every product has to sell. A
      // location with stock history cannot be deleted, so deleting one changes nothing.
      const { changed } = event.payload as unknown as LocationUpdatedPayload;
      return changed.some((name) => SELLING_FIELDS.has(name)) ? [Items.everyProduct] : [];
    }
    case OnlineStoreEvents.ThemeUpdated:
      // Only the main theme shows; the others are being prepared.
      return (event.payload as unknown as ThemeUpdatedPayload).role === 'main' ? [Items.shop] : [];
    case OnlineStoreEvents.ThemePublished:
    case OnlineStoreEvents.PreferencesUpdated:
    case CheckoutEvents.DeliverySettingsUpdated:
      return [Items.shop];
    case OnlineStoreEvents.DomainCreated:
    case OnlineStoreEvents.DomainUpdated:
    case OnlineStoreEvents.DomainDeleted:
      // The directory follows the shop's own domains, and its document names the primary one.
      return [Items.shop];
    case OnlineStoreEvents.MenuCreated:
    case OnlineStoreEvents.MenuUpdated:
    case OnlineStoreEvents.MenuDeleted:
      return [Items.menus];
    case OnlineStoreEvents.PageCreated:
      // No menu links to it yet.
      return [Items.page(id)];
    case OnlineStoreEvents.PageUpdated: {
      const { changed } = event.payload as unknown as PageUpdatedPayload;
      return changed.some((name) => LINKED_PAGE_FIELDS.has(name))
        ? [Items.page(id), Items.menus]
        : [Items.page(id)];
    }
    case OnlineStoreEvents.PageDeleted:
      return [Items.page(id), Items.menus];
    case OnlineStoreEvents.UrlRedirectCreated:
    case OnlineStoreEvents.UrlRedirectUpdated:
    case OnlineStoreEvents.UrlRedirectDeleted:
    case OnlineStoreEvents.UrlRedirectsImported:
      return [Items.redirects];
    case OnlineStoreEvents.PolicyUpdated:
      // Its page, and the footers that list the shop's policies.
      return [Items.policies, Items.shop];
    case MarketingEvents.MetaConversionsUpdated:
      // Its pages load the pixel the shop's document names (ADR-144).
      return (event.payload as unknown as MetaConversionsUpdatedPayload).changed.includes('pixelId')
        ? [Items.shop]
        : [];
    case MarketingEvents.MetaConversionsDeleted:
      return [Items.shop];
    case ShopEvents.ShopOpened:
      // Its storefront, at its handle's subdomain: a shop without documents gets all of them.
      return [Items.everything];
    default:
      return [];
  }
}

/** The events {@link itemsFor} reads. */
export const PUBLISHED_EVENTS = [
  ...Object.values(CatalogEvents),
  InventoryEvents.InventoryItemUpdated,
  InventoryEvents.InventoryLevelUpdated,
  InventoryEvents.LocationUpdated,
  OnlineStoreEvents.ThemeUpdated,
  OnlineStoreEvents.ThemePublished,
  OnlineStoreEvents.MenuCreated,
  OnlineStoreEvents.MenuUpdated,
  OnlineStoreEvents.MenuDeleted,
  OnlineStoreEvents.PageCreated,
  OnlineStoreEvents.PageUpdated,
  OnlineStoreEvents.PageDeleted,
  OnlineStoreEvents.PreferencesUpdated,
  OnlineStoreEvents.DomainCreated,
  OnlineStoreEvents.DomainUpdated,
  OnlineStoreEvents.DomainDeleted,
  OnlineStoreEvents.UrlRedirectCreated,
  OnlineStoreEvents.UrlRedirectUpdated,
  OnlineStoreEvents.UrlRedirectDeleted,
  OnlineStoreEvents.UrlRedirectsImported,
  OnlineStoreEvents.PolicyUpdated,
  CheckoutEvents.DeliverySettingsUpdated,
  MarketingEvents.MetaConversionsUpdated,
  MarketingEvents.MetaConversionsDeleted,
  ShopEvents.ShopOpened,
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The most paths whose pages are forgotten by their own tags when their redirects change. */
const REDIRECT_PURGE_LIMIT = 25;

export interface PublisherServices {
  products: ProductService;
  collections: CollectionService;
  inventory: InventoryService;
  themes: ThemeService;
  menus: MenuService;
  pages: PageService;
  preferences: { preferencesOf(tx: Tx, shopId: string): Promise<PreferencesRecord> };
  delivery: DeliveryService;
  domains: { domainsOf(tx: Tx, shopId: string): Promise<DomainRecord[]> };
  redirects: { redirectsOf(tx: Tx, shopId: string): Promise<{ path: string; target: string }[]> };
  policies: { policiesOf(tx: Tx, shopId: string): Promise<{ type: string; body: string }[]> };
  /** The shop's Meta pixel, while it has Meta connected (ADR-144). */
  pixels: { metaPixelIdOf(tx: Tx, shopId: string): Promise<string | null> };
}

export interface PublisherLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

/**
 * Keeps each shop's storefront documents in Valkey up to date with its catalog and stock:
 * events mark what they make stale, and whichever worker holds the shop's lock builds it, a
 * batch at a time, from the database as it is then. A burst of edits is built once.
 */
export class StorefrontPublisher {
  readonly queue: BuildQueue;
  readonly directory: ShopDirectory;
  readonly #keys: StorefrontKeys;

  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly services: PublisherServices,
    private readonly options: {
      keys?: StorefrontKeys;
      logger?: PublisherLogger;
      /** Told to forget the pages of what changed (ADR-047); nothing by default. */
      edge?: EdgeCache;
    } = {},
  ) {
    this.#keys = options.keys ?? new StorefrontKeys();
    this.queue = new BuildQueue(redis, { keys: this.#keys, priority });
    this.directory = new ShopDirectory(redis, this.#keys);
  }

  /** An event handler: marks what the event makes stale, then builds it unless another is. */
  async handle(event: DomainEvent): Promise<void> {
    const items = itemsFor(event);
    if (items.length === 0) return;
    await this.queue.add(event.shopId, items);
    await this.publish(event.shopId);
  }

  /** Builds everything, as for a new shop. */
  async publishAll(shopId: string): Promise<number> {
    await this.queue.add(shopId, [Items.everything]);
    return this.publish(shopId);
  }

  /**
   * Builds what is pending for the shop. A shop without documents, new or lost, or with documents
   * of an older shape, gets all of them. Returns how many items this call built.
   */
  async publish(shopId: string): Promise<number> {
    const stored = await this.redis.get(this.#keys.shop(shopId));
    const version = stored ? ((JSON.parse(stored) as Partial<ShopDoc>).version ?? 1) : 0;
    if (version < DOCUMENTS_VERSION) await this.queue.add(shopId, [Items.everything]);
    const built = await this.queue.drain(shopId, (batch) => this.#build(batch));
    if (built > 0) this.options.logger?.info({ shopId, built }, 'storefront published');
    return built;
  }

  async #build(batch: Batch): Promise<void> {
    const { shopId, writer } = batch;
    const products = new Set<string>();
    const collections = new Set<string>();
    const pages = new Set<string>();
    const containing: string[] = [];
    const wanted = new Set<string>();
    for (const item of batch.items) {
      const [kind, id = ''] = splitItem(item);
      if (
        kind === 'product' ||
        kind === 'collection' ||
        kind === 'page' ||
        kind === 'collections-with'
      ) {
        if (!UUID.test(id)) {
          this.options.logger?.warn({ shopId, item }, 'storefront item not understood');
        } else if (kind === 'product') products.add(id);
        else if (kind === 'collection') collections.add(id);
        else if (kind === 'page') pages.add(id);
        else containing.push(id);
      } else {
        wanted.add(kind);
      }
    }

    // The cache tags of the pages what this batch changes is on.
    const changed = new Set<string>();
    await this.db.tenant(shopId, async (tx) => {
      const more = await this.#expand(tx, shopId, wanted, containing);
      await batch.add(more);
      if (products.size > 0) await this.#products(tx, batch, [...products], changed);
      if (collections.size > 0) await this.#collections(tx, batch, [...collections], changed);
      if (pages.size > 0) await this.#pages(tx, batch, [...pages], changed);
      if (wanted.has(Items.allProducts)) {
        const all = await this.services.collections.recordsOf(tx, shopId);
        await this.#allProducts(tx, batch, all, changed);
      }
      if (wanted.has(Items.menus)) {
        const docs = (await this.services.menus.menusOf(tx, shopId)).map(menuDoc);
        const stored = await this.redis.hgetall(this.#keys.menus(shopId));
        await writer.putMenus(docs);
        // Menus are on every page.
        const same =
          docs.length === Object.keys(stored).length &&
          docs.every((doc) => stored[doc.handle] === JSON.stringify(doc));
        if (!same) changed.add(shopTag(shopId));
      }
      if (wanted.has(Items.redirects)) {
        const redirects = await this.services.redirects.redirectsOf(tx, shopId);
        const paths = await writer.putRedirects(
          new Map(redirects.map(({ path, target }) => [path, target])),
        );
        // What is answered at each path whose redirect came, changed or went: all of the shop's
        // pages instead when there are many, as when it moves its old store's addresses, so the
        // edge is told once.
        if (paths.length > REDIRECT_PURGE_LIMIT) changed.add(shopTag(shopId));
        else for (const path of paths) changed.add(pathTag(shopId, path));
      }
      if (wanted.has(Items.policies)) {
        const policies = await this.services.policies.policiesOf(tx, shopId);
        const bodies = Object.fromEntries(policies.map(({ type, body }) => [type, body]));
        const stored = await this.redis.hgetall(this.#keys.policies(shopId));
        await writer.putPolicies(bodies);
        // Rarely changed: all the shop's pages, as the edge keeps policies' pages by the shop.
        const same =
          policies.length === Object.keys(stored).length &&
          policies.every(({ type, body }) => stored[type] === body);
        if (!same) changed.add(shopTag(shopId));
      }
      if (wanted.has(Items.shop) && (await this.#shop(tx, batch))) changed.add(shopTag(shopId));
    });
    await this.#purge(shopId, changed);
  }

  /** Tells the edge to forget the pages tagged `tags`: all the shop's when its own tag is there. */
  async #purge(shopId: string, tags: ReadonlySet<string>): Promise<void> {
    if (tags.size === 0) return;
    const shop = shopTag(shopId);
    try {
      await (this.options.edge ?? NO_EDGE_CACHE).purge(tags.has(shop) ? [shop] : [...tags]);
    } catch (error) {
      // The pages are kept a few minutes at most: they go stale, not wrong for long.
      this.options.logger?.warn({ shopId, err: error }, 'edge cache not purged');
    }
  }

  /** The documents of `kind` stored now, by ID, as their JSON. */
  async #stored(
    shopId: string,
    kind: HandledKind,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const values = await this.redis.mget(ids.map((id) => this.#keys.doc(shopId, kind, id)));
    return new Map(ids.flatMap((id, index) => (values[index] ? [[id, values[index]]] : [])));
  }

  /**
   * Adds to `changed` the tags of the documents of `kind` written with other content than
   * `stored`, or dropped: by their handles before and after. Returns their IDs.
   */
  #changed(
    shopId: string,
    kind: HandledKind,
    stored: ReadonlyMap<string, string>,
    written: readonly { id: string; handle: string }[],
    dropped: readonly string[],
    changed: Set<string>,
  ): string[] {
    const ids: string[] = [];
    const before = (id: string) => {
      const json = stored.get(id);
      if (json)
        changed.add(handleTag(shopId, kind, (JSON.parse(json) as { handle: string }).handle));
    };
    for (const doc of written) {
      if (stored.get(doc.id) === JSON.stringify(doc)) continue;
      changed.add(handleTag(shopId, kind, doc.handle));
      before(doc.id);
      ids.push(doc.id);
    }
    for (const id of dropped) {
      if (!stored.has(id)) continue;
      before(id);
      ids.push(id);
    }
    return ids;
  }

  /**
   * The shop's settings, preferences, delivery charges and main theme, and its handle in the
   * directory while it is open. The theme is written first, so the shop's document never names a
   * version not yet there.
   */
  async #shop(tx: Tx, { shopId, writer }: Batch): Promise<boolean> {
    const profile = await shopProfile(tx, shopId);
    const main = await this.services.themes.mainOf(tx, shopId);
    const theme = main ? themeDoc(main) : null;
    if (theme) await writer.putTheme(theme);
    else await writer.dropTheme();
    const stored = await this.redis.get(this.#keys.shop(shopId));
    const before = stored ? (JSON.parse(stored) as ShopDoc) : null;
    const previous = before?.handle ?? null;
    const preferences = await this.services.preferences.preferencesOf(tx, shopId);
    const delivery = await this.services.delivery.settingsOf(tx, shopId);
    // Its own domains are served once DNS pointed them at the platform.
    const domains = (await this.services.domains.domainsOf(tx, shopId)).filter(
      (domain) => domain.verifiedAt !== null,
    );
    const policies = (await this.services.policies.policiesOf(tx, shopId)).map(
      (policy) => policy.type,
    );
    const metaPixelId = await this.services.pixels.metaPixelIdOf(tx, shopId);
    const doc = shopDoc(profile, theme, preferences, delivery, domains, policies, metaPixelId);
    await writer.putShop(doc);
    const hosts = doc.domains ?? [];
    if (profile.status === 'active') {
      await this.directory.set(shopId, profile.handle, previous);
      await this.directory.setDomains(shopId, hosts, before?.domains);
    } else {
      await this.directory.remove(shopId, profile.handle);
      if (previous) await this.directory.remove(shopId, previous);
      await this.directory.removeDomains(shopId, [...hosts, ...(before?.domains ?? [])]);
    }
    // Its theme's version is in it: a new theme changes it too.
    return stored !== JSON.stringify(doc);
  }

  /** The items that those standing for many stand for. */
  async #expand(
    tx: Tx,
    shopId: string,
    wanted: ReadonlySet<string>,
    containing: string[],
  ): Promise<string[]> {
    const more: string[] = [];
    const { products, collections } = this.services;
    if (wanted.has(Items.everything)) {
      more.push(
        Items.shop,
        Items.everyProduct,
        Items.everyCollection,
        Items.everyPage,
        Items.allProducts,
        Items.menus,
        Items.redirects,
        Items.policies,
      );
    }
    if (wanted.has(Items.everyPage)) {
      // Those gone from the database while no event said so are taken off too.
      const ids = new Set([
        ...(await this.services.pages.idsOf(tx, shopId)),
        ...(await this.redis.hkeys(this.#keys.handles(shopId, 'page'))),
      ]);
      more.push(...[...ids].map(Items.page));
    }
    if (wanted.has(Items.everyProduct)) {
      // Those gone from the database while no event said so are taken off too.
      const ids = new Set([
        ...(await products.idsOf(tx, shopId)),
        ...(await this.redis.hkeys(this.#keys.handles(shopId, 'product'))),
      ]);
      more.push(...[...ids].map(Items.product));
    }
    const listings: CollectionRecord[] = [];
    if (wanted.has(Items.everyCollection)) {
      const published = await this.redis.hkeys(this.#keys.handles(shopId, 'collection'));
      more.push(...published.filter((id) => id !== ALL_PRODUCTS).map(Items.collection));
      listings.push(...(await collections.recordsOf(tx, shopId)));
    } else {
      if (wanted.has(Items.smartCollections)) {
        listings.push(...(await collections.recordsOf(tx, shopId, { smart: true })));
      }
      if (containing.length > 0) {
        listings.push(...(await collections.recordsOf(tx, shopId, { containing })));
      }
    }
    more.push(...listings.map((collection) => Items.collection(collection.id)));
    return [...new Set(more)];
  }

  async #products(
    tx: Tx,
    { shopId, writer }: Batch,
    ids: string[],
    changed: Set<string>,
  ): Promise<void> {
    const records = await this.services.products.recordsOf(tx, shopId, ids);
    const active = records.filter((record) => record.status === 'active');
    const available = await this.services.inventory.availableOf(
      tx,
      shopId,
      active.flatMap((record) => record.variants.map((variant) => variant.id)),
    );
    const stored = await this.#stored(shopId, 'product', ids);
    const docs = active.map((record) => productDoc(record, available));
    await writer.putProducts(docs);
    const shown = new Set(active.map((record) => record.id));
    const dropped = ids.filter((id) => !shown.has(id));
    await writer.dropProducts(dropped);
    const different = this.#changed(shopId, 'product', stored, docs, dropped, changed);
    if (different.length === 0) return;
    // Listings show products' cards, which their own documents do not hold.
    const listings = await this.services.collections.recordsOf(tx, shopId, {
      containing: different,
    });
    for (const listing of listings) changed.add(handleTag(shopId, 'collection', listing.handle));
    changed.add(handleTag(shopId, 'collection', ALL_PRODUCTS));
  }

  async #collections(
    tx: Tx,
    { shopId, writer }: Batch,
    ids: string[],
    changed: Set<string>,
  ): Promise<void> {
    const records = await this.services.collections.recordsOf(tx, shopId, { ids });
    const docs = [];
    for (const record of records) {
      const productIds = await this.services.collections.activeProductIdsOf(tx, shopId, record);
      docs.push(collectionDoc(record, productIds));
    }
    const stored = await this.#stored(shopId, 'collection', ids);
    await writer.putCollections(docs);
    const found = new Set(records.map((record) => record.id));
    const dropped = ids.filter((id) => !found.has(id));
    await writer.dropCollections(dropped);
    this.#changed(shopId, 'collection', stored, docs, dropped, changed);
  }

  /** Pages published go on the storefront; others come off. */
  async #pages(
    tx: Tx,
    { shopId, writer }: Batch,
    ids: string[],
    changed: Set<string>,
  ): Promise<void> {
    const records = await this.services.pages.pagesOf(tx, shopId, { ids });
    const published = records.filter(
      (record): record is PageRecord & { publishedAt: Date } => record.publishedAt !== null,
    );
    const stored = await this.#stored(shopId, 'page', ids);
    const docs = published.map(pageDoc);
    await writer.putPages(docs);
    const shown = new Set(published.map((record) => record.id));
    const dropped = ids.filter((id) => !shown.has(id));
    await writer.dropPages(dropped);
    this.#changed(shopId, 'page', stored, docs, dropped, changed);
  }

  async #allProducts(
    tx: Tx,
    { shopId, writer }: Batch,
    all: CollectionRecord[],
    changed: Set<string>,
  ): Promise<void> {
    const stored = await this.#stored(shopId, 'collection', [ALL_PRODUCTS]);
    // A collection of the shop's own with the handle "all" takes its place.
    if (all.some((collection) => collection.handle === ALL_PRODUCTS)) {
      await writer.dropCollections([ALL_PRODUCTS]);
      this.#changed(shopId, 'collection', stored, [], [ALL_PRODUCTS], changed);
    } else {
      const ids = await this.services.products.idsOf(tx, shopId, { status: 'active' });
      const doc = allProductsDoc(ids);
      await writer.putCollections([doc]);
      this.#changed(shopId, 'collection', stored, [doc], [], changed);
    }
  }
}

/** A publisher with the modules' services, for the worker and the seed. */
export function createStorefrontPublisher(
  database: Database,
  redis: Redis,
  logger?: PublisherLogger,
  edge?: EdgeCache,
): StorefrontPublisher {
  const [products, collections] = [new ProductService(database), new CollectionService(database)];
  return new StorefrontPublisher(
    database,
    redis,
    {
      products,
      collections,
      inventory: new InventoryService(database, new VariantService(database)),
      themes: new ThemeService(database),
      menus: new MenuService(database, collections, products),
      pages: new PageService(database),
      preferences: { preferencesOf: shopPreferencesOf },
      delivery: new DeliveryService(database),
      domains: { domainsOf: shopDomainsOf },
      redirects: { redirectsOf: shopRedirectsOf },
      policies: { policiesOf: shopPoliciesOf },
      pixels: { metaPixelIdOf: metaPixelIdIn },
    },
    { logger, edge },
  );
}

function splitItem(item: string): [string, string?] {
  const colon = item.indexOf(':');
  return colon === -1 ? [item] : [item.slice(0, colon), item.slice(colon + 1)];
}
