import { setTimeout as sleep } from 'node:timers/promises';

// The read models a storefront renders from, as the core writes them to Valkey on catalog and
// stock events (03 §8): one JSON document per product, collection, menu and shop. Prices are in
// minor units (paisa).

/**
 * The documents' shape. Raise it when documents gain or change a field: a publisher that finds a
 * shop's written in an older shape publishes all of them again.
 */
export const DOCUMENTS_VERSION = 3;

export interface ImageDoc {
  /** Where the image service serves it, without size parameters. */
  src: string;
  /** In pixels; 0 while not known, as before the image is processed. */
  width: number;
  height: number;
  alt: string | null;
}

export interface VariantDoc {
  id: string;
  title: string;
  sku: string | null;
  price: number;
  compareAtPrice: number | null;
  available: boolean;
  /** One value per product option, in the options' order. */
  options: string[];
  /** Its image, by position in the product's images. */
  image: number | null;
}

export interface ProductDoc {
  id: string;
  handle: string;
  title: string;
  /** Safe to show as it is: made from the product's text, escaped. */
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  options: { name: string; values: string[] }[];
  variants: VariantDoc[];
  images: ImageDoc[];
}

export interface CollectionDoc {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string;
  image: ImageDoc | null;
  /** Its products, in the collection's order; their documents are fetched a page at a time. */
  productIds: string[];
}

export interface MenuDoc {
  handle: string;
  title: string;
  links: { title: string; url: string }[];
}

export interface ShopDoc {
  /** The {@link DOCUMENTS_VERSION} the shop's documents were written in. */
  version: number;
  name: string;
  /** Names its storefront on the platform's domain, e.g. "zari" for zari.hatti.pk. */
  handle: string;
  /** Its primary domain, e.g. zari.hatti.pk; empty until shops have domains. */
  domain: string;
  /** For "Order on WhatsApp" links, in E.164. */
  whatsapp: string | null;
  /** Cash on delivery: whether it is offered, its fee and its limit, in minor units. */
  cod: { available: boolean; fee: number; limit: number | null };
  /**
   * Its main theme, as last published: the {@link ThemeDoc} to lay over the platform theme. Null
   * for the platform theme as it is.
   */
  theme: { id: string; version: number } | null;
}

/**
 * A shop's main theme: the platform theme it is built on, and the shop's own JSON files over it,
 * templates, section groups and settings (ADR-039).
 */
export interface ThemeDoc {
  id: string;
  /** Goes up with every change; the shop's document names the one it goes with. */
  version: number;
  /** The platform theme, such as hatti-base. */
  base: string;
  /** By filename, such as templates/index.json. */
  files: Record<string, string>;
}

/**
 * Where a render reads its documents: Valkey in production, memory in tests and benchmarks. Every
 * method is one round trip, so lists are fetched in one call, never one call per item.
 */
export interface StoreData {
  shop(): Promise<ShopDoc>;
  productByHandle(handle: string): Promise<ProductDoc | null>;
  /** Many products in one round trip, in the order asked; null for those gone. */
  products(ids: readonly string[]): Promise<(ProductDoc | null)[]>;
  collectionByHandle(handle: string): Promise<CollectionDoc | null>;
  menu(handle: string): Promise<MenuDoc | null>;
  /** The shop's theme files, fetched when the shop's document names a version not yet at hand. */
  theme(): Promise<ThemeDoc | null>;
}

/** A shop's documents, as the catalog would write them. */
export interface StoreDocuments {
  shop: ShopDoc;
  products: ProductDoc[];
  collections: CollectionDoc[];
  menus: MenuDoc[];
  theme?: ThemeDoc;
}

/**
 * Documents in memory, answered after `latencyMs` as a network round trip would be, counting the
 * round trips a render makes.
 */
export class MemoryStore implements StoreData {
  roundTrips = 0;
  readonly #products: Map<string, ProductDoc>;
  readonly #productsByHandle: Map<string, ProductDoc>;
  readonly #collections: Map<string, CollectionDoc>;
  readonly #menus: Map<string, MenuDoc>;

  constructor(
    private readonly documents: StoreDocuments,
    private readonly latencyMs = 0,
  ) {
    this.#products = new Map(documents.products.map((product) => [product.id, product]));
    this.#productsByHandle = new Map(
      documents.products.map((product) => [product.handle, product]),
    );
    this.#collections = new Map(documents.collections.map((c) => [c.handle, c]));
    this.#menus = new Map(documents.menus.map((menu) => [menu.handle, menu]));
  }

  /** The same documents, with a fresh count, as for the next request. */
  fresh(latencyMs = this.latencyMs): MemoryStore {
    return new MemoryStore(this.documents, latencyMs);
  }

  shop(): Promise<ShopDoc> {
    return this.#answer(this.documents.shop);
  }

  productByHandle(handle: string): Promise<ProductDoc | null> {
    return this.#answer(this.#productsByHandle.get(handle) ?? null);
  }

  products(ids: readonly string[]): Promise<(ProductDoc | null)[]> {
    return this.#answer(ids.map((id) => this.#products.get(id) ?? null));
  }

  collectionByHandle(handle: string): Promise<CollectionDoc | null> {
    return this.#answer(this.#collections.get(handle) ?? null);
  }

  menu(handle: string): Promise<MenuDoc | null> {
    return this.#answer(this.#menus.get(handle) ?? null);
  }

  theme(): Promise<ThemeDoc | null> {
    return this.#answer(this.documents.theme ?? null);
  }

  async #answer<T>(value: T): Promise<T> {
    this.roundTrips += 1;
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    return value;
  }
}
