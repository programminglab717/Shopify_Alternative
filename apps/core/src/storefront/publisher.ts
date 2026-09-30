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
import {
  MenuService,
  OnlineStoreEvents,
  PreferencesService,
  ThemeService,
  type ThemeUpdatedPayload,
} from '@hatti/online-store/public';
import {
  BuildQueue,
  DOCUMENTS_VERSION,
  ShopDirectory,
  StorefrontKeys,
  type Batch,
  type ShopDoc,
} from '@hatti/storefront-data';
import type { Redis } from 'ioredis';
import {
  ALL_PRODUCTS,
  allProductsDoc,
  collectionDoc,
  menuDoc,
  productDoc,
  shopDoc,
  themeDoc,
} from './documents.js';

/**
 * What the publisher builds, as items of a shop's build queue. The first ones stand for many
 * others, found when they are taken; the queue holds each item once, however often it is asked.
 */
export const Items = {
  everything: 'everything',
  everyProduct: 'every-product',
  everyCollection: 'every-collection',
  smartCollections: 'smart-collections',
  /** The collections a product is in now. */
  collectionsWith: (productId: string) => `collections-with:${productId}`,
  /**
   * The shop's settings, preferences and delivery charges, and its main theme, the theme written
   * first.
   */
  shop: 'shop',
  product: (id: string) => `product:${id}`,
  collection: (id: string) => `collection:${id}`,
  allProducts: 'all-products',
  menus: 'menus',
} as const;

/**
 * Taken in this order: what stands for many first, then products and the shop, then listings,
 * so a listing seldom names a product whose document is not written yet; menus last.
 */
function priority(item: string): number {
  if (item.startsWith('product:')) return 1;
  if (item.startsWith('collection:') || item === Items.allProducts) return 2;
  if (item === Items.menus) return 3;
  return 0;
}

/**
 * Product fields no listing depends on: changing only these rebuilds the product alone, and the
 * menus for a new handle.
 */
const OWN_FIELDS = new Set(['description', 'handle', 'media']);

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
    case OnlineStoreEvents.MenuCreated:
    case OnlineStoreEvents.MenuUpdated:
    case OnlineStoreEvents.MenuDeleted:
      return [Items.menus];
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
  OnlineStoreEvents.PreferencesUpdated,
  CheckoutEvents.DeliverySettingsUpdated,
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PublisherServices {
  products: ProductService;
  collections: CollectionService;
  inventory: InventoryService;
  themes: ThemeService;
  menus: MenuService;
  preferences: PreferencesService;
  delivery: DeliveryService;
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
    private readonly options: { keys?: StorefrontKeys; logger?: PublisherLogger } = {},
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
    const containing: string[] = [];
    const wanted = new Set<string>();
    for (const item of batch.items) {
      const [kind, id = ''] = splitItem(item);
      if (kind === 'product' || kind === 'collection' || kind === 'collections-with') {
        if (!UUID.test(id)) {
          this.options.logger?.warn({ shopId, item }, 'storefront item not understood');
        } else if (kind === 'product') products.add(id);
        else if (kind === 'collection') collections.add(id);
        else containing.push(id);
      } else {
        wanted.add(kind);
      }
    }

    await this.db.tenant(shopId, async (tx) => {
      const more = await this.#expand(tx, shopId, wanted, containing);
      await batch.add(more);
      if (products.size > 0) await this.#products(tx, batch, [...products]);
      if (collections.size > 0) await this.#collections(tx, batch, [...collections]);
      if (wanted.has(Items.allProducts)) {
        await this.#allProducts(tx, batch, await this.services.collections.recordsOf(tx, shopId));
      }
      if (wanted.has(Items.menus)) {
        const menus = await this.services.menus.menusOf(tx, shopId);
        await writer.putMenus(menus.map(menuDoc));
      }
      if (wanted.has(Items.shop)) await this.#shop(tx, batch);
    });
  }

  /**
   * The shop's settings, preferences, delivery charges and main theme, and its handle in the
   * directory while it is open. The theme is written first, so the shop's document never names a
   * version not yet there.
   */
  async #shop(tx: Tx, { shopId, writer }: Batch): Promise<void> {
    const profile = await shopProfile(tx, shopId);
    const main = await this.services.themes.mainOf(tx, shopId);
    const theme = main ? themeDoc(main) : null;
    if (theme) await writer.putTheme(theme);
    else await writer.dropTheme();
    const stored = await this.redis.get(this.#keys.shop(shopId));
    const previous = stored ? (JSON.parse(stored) as ShopDoc).handle : null;
    const preferences = await this.services.preferences.preferencesOf(tx, shopId);
    const delivery = await this.services.delivery.settingsOf(tx, shopId);
    await writer.putShop(shopDoc(profile, theme, preferences, delivery));
    if (profile.status === 'active') {
      await this.directory.set(shopId, profile.handle, previous);
    } else {
      await this.directory.remove(shopId, profile.handle);
      if (previous) await this.directory.remove(shopId, previous);
    }
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
        Items.allProducts,
        Items.menus,
      );
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

  async #products(tx: Tx, { shopId, writer }: Batch, ids: string[]): Promise<void> {
    const records = await this.services.products.recordsOf(tx, shopId, ids);
    const active = records.filter((record) => record.status === 'active');
    const available = await this.services.inventory.availableOf(
      tx,
      shopId,
      active.flatMap((record) => record.variants.map((variant) => variant.id)),
    );
    await writer.putProducts(active.map((record) => productDoc(record, available)));
    const shown = new Set(active.map((record) => record.id));
    await writer.dropProducts(ids.filter((id) => !shown.has(id)));
  }

  async #collections(tx: Tx, { shopId, writer }: Batch, ids: string[]): Promise<void> {
    const records = await this.services.collections.recordsOf(tx, shopId, { ids });
    const docs = [];
    for (const record of records) {
      const productIds = await this.services.collections.activeProductIdsOf(tx, shopId, record);
      docs.push(collectionDoc(record, productIds));
    }
    await writer.putCollections(docs);
    const found = new Set(records.map((record) => record.id));
    await writer.dropCollections(ids.filter((id) => !found.has(id)));
  }

  async #allProducts(tx: Tx, { shopId, writer }: Batch, all: CollectionRecord[]): Promise<void> {
    // A collection of the shop's own with the handle "all" takes its place.
    if (all.some((collection) => collection.handle === ALL_PRODUCTS)) {
      await writer.dropCollections([ALL_PRODUCTS]);
    } else {
      const ids = await this.services.products.idsOf(tx, shopId, { status: 'active' });
      await writer.putCollections([allProductsDoc(ids)]);
    }
  }
}

/** A publisher with the modules' services, for the worker and the seed. */
export function createStorefrontPublisher(
  database: Database,
  redis: Redis,
  logger?: PublisherLogger,
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
      preferences: new PreferencesService(database),
      delivery: new DeliveryService(database),
    },
    { logger },
  );
}

function splitItem(item: string): [string, string?] {
  const colon = item.indexOf(':');
  return colon === -1 ? [item] : [item.slice(0, colon), item.slice(colon + 1)];
}
