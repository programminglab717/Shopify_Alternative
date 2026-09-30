import { setTimeout as sleep } from 'node:timers/promises';
import type { HandledKind } from './keys.js';

// The read models a storefront renders from, as the core writes them to Valkey on catalog and
// stock events (03 §8): one JSON document per product, collection, menu, page and shop. Prices are in
// minor units (paisa).

/**
 * The documents' shape. Raise it when documents gain or change a field: a publisher that finds a
 * shop's written in an older shape publishes all of them again.
 */
export const DOCUMENTS_VERSION = 6;

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
  links: MenuLinkDoc[];
}

/** A menu's link, as Liquid's `link` has it, with the links under it. */
export interface MenuLinkDoc {
  title: string;
  /** A path on the storefront, or a web, mail or phone address. */
  url: string;
  /**
   * What it links to: frontpage_link, catalog_link, collection_link, product_link, page_link or
   * http_link.
   */
  type: string;
  /** Up to three levels in all. */
  links: MenuLinkDoc[];
}

/** A shop's page, such as About us, while it is published (ADR-045). */
export interface PageDoc {
  id: string;
  handle: string;
  title: string;
  /** Safe to show as it is: cleaned of anything that could run when it was saved. */
  bodyHtml: string;
  /** Another of the theme's page templates, "contact" for page.contact.json; null for page.json. */
  templateSuffix: string | null;
  /** When it was published, in ISO 8601. */
  publishedAt: string;
}

export interface ShopDoc {
  /** The {@link DOCUMENTS_VERSION} the shop's documents were written in. */
  version: number;
  name: string;
  /** Names its storefront on the platform's domain, e.g. "zari" for zari.hatti.pk. */
  handle: string;
  /**
   * Its primary domain of its own, e.g. www.zari.pk, where the storefront sends shoppers; empty
   * while it has none, and its handle's subdomain is (ADR-048).
   */
  domain: string;
  /**
   * Its own domains the storefront answers at, those DNS pointed at the platform, the primary
   * one among them. Documents written before shops had domains have none.
   */
  domains?: string[];
  /** For "Order on WhatsApp" links, in E.164. */
  whatsapp: string | null;
  /** Cash on delivery: whether it is offered, its fee and its limit, in minor units. */
  cod: { available: boolean; fee: number; limit: number | null };
  /**
   * What delivery costs, in minor units: everywhere, in zones of cities, and nothing from a
   * subtotal. Documents written before shops set charges have none: nothing is charged.
   */
  delivery?: DeliveryDoc;
  /**
   * Its main theme, as last published: the {@link ThemeDoc} to lay over the platform theme. Null
   * for the platform theme as it is.
   */
  theme: { id: string; version: number } | null;
}

export interface DeliveryDoc {
  charge: number;
  freeAbove: number | null;
  zones: { name: string; cities: string[]; charge: number }[];
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
  pageByHandle(handle: string): Promise<PageDoc | null>;
  /** The shop's theme files, fetched when the shop's document names a version not yet at hand. */
  theme(): Promise<ThemeDoc | null>;
  /**
   * The handle of every product, collection or page the storefront shows, for its sitemaps: in no
   * order, in one round trip.
   */
  handles(kind: HandledKind): Promise<string[]>;
}

/** A shop's documents, as the catalog would write them. */
export interface StoreDocuments {
  shop: ShopDoc;
  products: ProductDoc[];
  collections: CollectionDoc[];
  menus: MenuDoc[];
  pages?: PageDoc[];
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
  readonly #pages: Map<string, PageDoc>;

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
    this.#pages = new Map((documents.pages ?? []).map((page) => [page.handle, page]));
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

  pageByHandle(handle: string): Promise<PageDoc | null> {
    return this.#answer(this.#pages.get(handle) ?? null);
  }

  theme(): Promise<ThemeDoc | null> {
    return this.#answer(this.documents.theme ?? null);
  }

  handles(kind: HandledKind): Promise<string[]> {
    const found = {
      product: this.#productsByHandle,
      collection: this.#collections,
      page: this.#pages,
    }[kind];
    return this.#answer([...found.keys()]);
  }

  async #answer<T>(value: T): Promise<T> {
    this.roundTrips += 1;
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    return value;
  }
}
