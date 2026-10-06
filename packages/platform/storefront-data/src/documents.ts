import { setTimeout as sleep } from 'node:timers/promises';
import type { HandledKind } from './keys.js';

// The read models a storefront renders from, as the core writes them to Valkey on catalog and
// stock events (03 §8): one JSON document per product, collection, menu, page, blog, article and
// shop, and the shop's URL redirects. Prices are in minor units (paisa).

/**
 * The documents' shape. Raise it when documents gain or change a field: a publisher that finds a
 * shop's written in an older shape publishes all of them again.
 */
export const DOCUMENTS_VERSION = 15;

/**
 * What search engines and link previews are told of a product, collection, page or article in
 * place of its own title and the start of its text (OS-09, ADR-231): null for its own.
 */
export interface SeoDoc {
  title: string | null;
  description: string | null;
}

/**
 * A document's fields in other languages of the storefront, as the shop translated them (OS-06,
 * ADR-238), by language: each field it translated, and its SEO title or description, shown in
 * place of the document's own on that language's pages (`translated`).
 */
export type TranslationsDoc<T, K extends keyof T> = Partial<
  Record<string, Partial<Pick<T, K>> & { seo?: Partial<SeoDoc> }>
>;

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
  /**
   * When it was made and last changed, as ISO 8601 (ADR-216): its collection's feed dates its entry
   * with them. Absent in documents written before.
   */
  createdAt?: string;
  updatedAt?: string;
  /**
   * What search engines and link previews are told in place of its own title and text (ADR-231).
   * Absent in documents written before: its own.
   */
  seo?: SeoDoc;
  /** Its fields in Urdu, those the shop translated (ADR-238); absent where it translated none. */
  translations?: TranslationsDoc<ProductDoc, 'title' | 'descriptionHtml' | 'productType'>;
}

export interface CollectionDoc {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string;
  image: ImageDoc | null;
  /** Its products, in the collection's order; their documents are fetched a page at a time. */
  productIds: string[];
  /**
   * When it last changed, as ISO 8601: its sitemap's `lastmod` (ADR-236). Absent in documents
   * written before, and for all products.
   */
  updatedAt?: string;
  /**
   * What search engines and link previews are told in place of its own title and text (ADR-231).
   * Absent in documents written before: its own.
   */
  seo?: SeoDoc;
  /** Its fields in Urdu, those the shop translated (ADR-238); absent where it translated none. */
  translations?: TranslationsDoc<CollectionDoc, 'title' | 'descriptionHtml'>;
}

export interface MenuDoc {
  handle: string;
  title: string;
  links: MenuLinkDoc[];
  /**
   * Its title and links in Urdu (ADR-238), each link's title the shop's translation where it gave
   * one; absent where it translated none.
   */
  translations?: TranslationsDoc<MenuDoc, 'title' | 'links'>;
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
  /** When it last changed, as ISO 8601 (ADR-236). Absent in documents written before. */
  updatedAt?: string;
  /**
   * What search engines and link previews are told in place of its own title and text (ADR-231).
   * Absent in documents written before: its own.
   */
  seo?: SeoDoc;
  /** Its fields in Urdu, those the shop translated (ADR-238); absent where it translated none. */
  translations?: TranslationsDoc<PageDoc, 'title' | 'bodyHtml'>;
}

/** A shop's blog, such as News (ADR-177). */
export interface BlogDoc {
  id: string;
  handle: string;
  title: string;
  /** Another of the theme's blog templates, "news" for blog.news.json; null for blog.json. */
  templateSuffix: string | null;
  /**
   * Its published articles, the latest first, each with its tags: their documents are fetched a
   * page at a time, and those with a tag listed at /blogs/{handle}/tagged/{tag}.
   */
  articles: { id: string; tags: string[] }[];
  /**
   * Whether its articles take comments, and whether the shop approves each first (ADR-220).
   * Absent in documents written before blogs took comments: closed.
   */
  commentPolicy?: CommentPolicyDoc;
  /** When it last changed, as ISO 8601 (ADR-236). Absent in documents written before. */
  updatedAt?: string;
  /** Its fields in Urdu, those the shop translated (ADR-238); absent where it translated none. */
  translations?: TranslationsDoc<BlogDoc, 'title'>;
}

/** Shopify's comment policies: none, each approved by the shop first, or each shown at once. */
export type CommentPolicyDoc = 'closed' | 'moderated' | 'auto_published';

/** A comment on an article, once the storefront shows it (ADR-220). */
export interface CommentDoc {
  id: string;
  /** The name it is signed with. */
  author: string;
  /** Its text, escaped, its paragraphs and lines kept: safe to show as it is. */
  bodyHtml: string;
  /** When it was posted, in ISO 8601. */
  createdAt: string;
}

/** One of a blog's articles, while it is published (ADR-177). */
export interface ArticleDoc {
  id: string;
  /** Its own handle, unique in its blog: it is found by {@link articleHandle}. */
  handle: string;
  blogHandle: string;
  title: string;
  /** Safe to show as it is: cleaned of anything that could run when it was saved. */
  bodyHtml: string;
  /** What its blog's page shows of it, cleaned likewise; empty for none. */
  summaryHtml: string;
  /** The name it is signed with; empty for none. */
  author: string;
  tags: string[];
  /** When it was published, in ISO 8601. */
  publishedAt: string;
  /** Another of the theme's article templates, "recipe" for article.recipe.json; null for none. */
  templateSuffix: string | null;
  /**
   * When it last changed, in ISO 8601, as its blog's feed says (ADR-209). Absent in documents
   * written before blogs had feeds: when it was published.
   */
  updatedAt?: string;
  /**
   * Its image, where the API serves it (ADR-213); null for none. Absent in documents written
   * before articles had images.
   */
  image?: ImageDoc | null;
  /**
   * Its blog's comment policy, and its comments the storefront shows (ADR-220): the latest
   * published, the oldest of them first, and how many it has published. Absent in documents
   * written before articles took comments: closed, and none.
   */
  commentPolicy?: CommentPolicyDoc;
  comments?: CommentDoc[];
  commentsCount?: number;
  /**
   * What search engines and link previews are told in place of its own title and text (ADR-231).
   * Absent in documents written before: its own.
   */
  seo?: SeoDoc;
  /** Its fields in Urdu, those the shop translated (ADR-238); absent where it translated none. */
  translations?: TranslationsDoc<ArticleDoc, 'title' | 'bodyHtml' | 'summaryHtml'>;
}

/**
 * Where a policy's body in another language is kept, beside its own in the shop's policies
 * (ADR-239): "ur:refund_policy".
 */
export function policyField(type: string, locale: string): string {
  return `${locale}:${type}`;
}

/** What an article is found by, as in its address: its blog's handle and its own, news/eid-edit. */
export function articleHandle(article: { blogHandle: string; handle: string }): string {
  return `${article.blogHandle}/${article.handle}`;
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
  /**
   * The IANA time zone its days fall in, as its sessions are counted (ADR-180): "Asia/Karachi".
   * Absent in documents written before shops' sessions were counted: Pakistan's.
   */
  timezone?: string;
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
  /**
   * While its storefront is closed behind a password (ADR-054): a verifier of the password, and
   * what the password page tells shoppers, as HTML. Absent or null while it is open, as in
   * documents written before shops had passwords.
   */
  password?: { verifier: string; message: string } | null;
  /**
   * Rules it adds to its robots.txt (ADR-055), one a line, as the online store checked them.
   * Absent or empty for none, as in documents written before shops had them.
   */
  robotsRules?: string;
  /**
   * The policies it has (ADR-056), as Shopify names them, in Shopify's order: `refund_policy`,
   * `privacy_policy`, `terms_of_service`, `shipping_policy`, `contact_information`. Their bodies
   * are kept apart, fetched only for their own pages. Absent in documents written before shops
   * had policies: none.
   */
  policies?: string[];
  /**
   * Its Meta pixel's ID, while it has Meta connected (MKT-10, ADR-144): its pages load the pixel
   * for its shoppers. Absent or null for none, as in documents written before shops had them.
   */
  metaPixelId?: string | null;
  /**
   * Its link-in-bio page, at /links (CH-07, ADR-161): what it says of itself, its own links, and
   * the products it shows, by ID, in their order. Absent while it set none, as in documents
   * written before shops had them.
   */
  linkPage?: LinkPageDoc;
  /**
   * Where its logos are served (ADR-205): its logo, and its square logo for the places that show
   * a square, as its link page; each address names the image, so another is fetched anew. Absent
   * while it has neither, as in documents written before shops' documents had them.
   */
  brand?: BrandDoc;
}

export interface BrandDoc {
  /** An absolute URL; null for none. */
  logo: string | null;
  /** An absolute URL; null for none. */
  squareLogo: string | null;
}

export interface LinkPageDoc {
  bio: string;
  /** A path on the storefront, or an https address. */
  links: { title: string; url: string }[];
  productIds: string[];
  /**
   * The variant chosen of each of `productIds`, by its place (ADR-206); null for none. Absent
   * while none is, as in documents written before variants could be.
   */
  variantIds?: (string | null)[];
}

export interface DeliveryDoc {
  charge: number;
  freeAbove: number | null;
  /**
   * How many working days delivery takes everywhere (ADR-235); null while the shop has not said,
   * absent in documents written before shops could.
   */
  days?: DeliveryDaysDoc | null;
  zones: {
    name: string;
    cities: string[];
    charge: number;
    /** Its own days; null or absent for everywhere's. */
    days?: DeliveryDaysDoc | null;
  }[];
}

/** From `min` to `max` working days, 0 the same day. */
export interface DeliveryDaysDoc {
  min: number;
  max: number;
}

/**
 * What a shop's sitemaps say of a document (ADR-236), kept beside its handle as it is written:
 * when it last changed, as ISO 8601, and its image, where the image service serves it; null for
 * what it has not.
 */
export interface SitemapEntryDoc {
  at: string | null;
  image: string | null;
}

/** A document's sitemap entry, with the handle the storefront finds it by. */
export interface SitemapEntry extends SitemapEntryDoc {
  handle: string;
}

/**
 * What the sitemaps say of `doc`, a document of `kind`: when it last changed, else when it was
 * published; and a product's first image, a collection's or an article's own.
 */
export function sitemapEntryOf(kind: HandledKind, doc: object): SitemapEntryDoc {
  const fields = doc as {
    updatedAt?: string;
    publishedAt?: string;
    images?: ImageDoc[];
    image?: ImageDoc | null;
  };
  const image = kind === 'product' ? fields.images?.[0] : fields.image;
  return { at: fields.updatedAt ?? fields.publishedAt ?? null, image: image?.src ?? null };
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
  /** Many pages in one round trip, in the order asked; null for those gone (ADR-212). */
  pages(ids: readonly string[]): Promise<(PageDoc | null)[]>;
  blogByHandle(handle: string): Promise<BlogDoc | null>;
  /** An article by its blog's handle and its own, as {@link articleHandle} makes them. */
  articleByHandle(handle: string): Promise<ArticleDoc | null>;
  /** Many articles in one round trip, in the order asked; null for those gone. */
  articles(ids: readonly string[]): Promise<(ArticleDoc | null)[]>;
  /**
   * Where the shop's URL redirect from `path`, in `redirectKey`'s form, sends shoppers: a path
   * on the shop or an address elsewhere; null when it has none (ADR-052).
   */
  redirect(path: string): Promise<string | null>;
  /**
   * The body of the shop's policy of `type`, as HTML; null when it has none (ADR-056). In
   * `locale`, its words there where the shop gave them, else its own (ADR-239).
   */
  policy(type: string, locale?: string): Promise<string | null>;
  /** The shop's theme files, fetched when the shop's document names a version not yet at hand. */
  theme(): Promise<ThemeDoc | null>;
  /**
   * The handle of every product, collection, page, blog or article the storefront shows, for its
   * sitemaps, an article's with its blog's: in no order, in one round trip.
   */
  handles(kind: HandledKind): Promise<string[]>;
  /**
   * What the sitemaps say of each of a kind the storefront shows (ADR-236): its handle, when it
   * last changed and its image, in no order, in one round trip.
   */
  sitemap(kind: HandledKind): Promise<SitemapEntry[]>;
  /** The ID of every product the storefront shows, for its catalog feed: in no order, likewise. */
  productIds(): Promise<string[]>;
}

/** A shop's documents, as the catalog would write them. */
export interface StoreDocuments {
  shop: ShopDoc;
  products: ProductDoc[];
  collections: CollectionDoc[];
  menus: MenuDoc[];
  pages?: PageDoc[];
  blogs?: BlogDoc[];
  articles?: ArticleDoc[];
  theme?: ThemeDoc;
  /** Targets by path. */
  redirects?: Record<string, string>;
  /** Policies' bodies by type, and in other languages by {@link policyField}. */
  policies?: Record<string, string>;
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
  readonly #pagesById: Map<string, PageDoc>;
  readonly #blogs: Map<string, BlogDoc>;
  readonly #articles: Map<string, ArticleDoc>;
  readonly #articlesByHandle: Map<string, ArticleDoc>;
  readonly #redirects: Map<string, string>;
  readonly #policies: Map<string, string>;
  #shop: Promise<ShopDoc> | undefined;

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
    this.#pagesById = new Map((documents.pages ?? []).map((page) => [page.id, page]));
    this.#blogs = new Map((documents.blogs ?? []).map((blog) => [blog.handle, blog]));
    this.#articles = new Map((documents.articles ?? []).map((article) => [article.id, article]));
    this.#articlesByHandle = new Map(
      (documents.articles ?? []).map((article) => [articleHandle(article), article]),
    );
    this.#redirects = new Map(Object.entries(documents.redirects ?? {}));
    this.#policies = new Map(Object.entries(documents.policies ?? {}));
  }

  /** The same documents, with a fresh count, as for the next request. */
  fresh(latencyMs = this.latencyMs): MemoryStore {
    return new MemoryStore(this.documents, latencyMs);
  }

  /** Fetched once, as {@link RedisStore} fetches it. */
  shop(): Promise<ShopDoc> {
    this.#shop ??= this.#answer(this.documents.shop);
    return this.#shop;
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

  pages(ids: readonly string[]): Promise<(PageDoc | null)[]> {
    return this.#answer(ids.map((id) => this.#pagesById.get(id) ?? null));
  }

  blogByHandle(handle: string): Promise<BlogDoc | null> {
    return this.#answer(this.#blogs.get(handle) ?? null);
  }

  articleByHandle(handle: string): Promise<ArticleDoc | null> {
    return this.#answer(this.#articlesByHandle.get(handle) ?? null);
  }

  articles(ids: readonly string[]): Promise<(ArticleDoc | null)[]> {
    return this.#answer(ids.map((id) => this.#articles.get(id) ?? null));
  }

  redirect(path: string): Promise<string | null> {
    return this.#answer(this.#redirects.get(path) ?? null);
  }

  policy(type: string, locale?: string): Promise<string | null> {
    const translated = locale ? this.#policies.get(policyField(type, locale)) : undefined;
    return this.#answer(translated ?? this.#policies.get(type) ?? null);
  }

  theme(): Promise<ThemeDoc | null> {
    return this.#answer(this.documents.theme ?? null);
  }

  handles(kind: HandledKind): Promise<string[]> {
    const found = {
      product: this.#productsByHandle,
      collection: this.#collections,
      page: this.#pages,
      blog: this.#blogs,
      article: this.#articlesByHandle,
    }[kind];
    return this.#answer([...found.keys()]);
  }

  productIds(): Promise<string[]> {
    return this.#answer([...this.#products.keys()]);
  }

  sitemap(kind: HandledKind): Promise<SitemapEntry[]> {
    const docs: Map<string, object> = {
      product: this.#productsByHandle,
      collection: this.#collections,
      page: this.#pages,
      blog: this.#blogs,
      article: this.#articlesByHandle,
    }[kind];
    return this.#answer(
      [...docs].map(([handle, doc]) => ({ handle, ...sitemapEntryOf(kind, doc) })),
    );
  }

  async #answer<T>(value: T): Promise<T> {
    this.roundTrips += 1;
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    return value;
  }
}
