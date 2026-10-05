import { Drop } from 'liquidjs';
import type {
  ArticleDoc,
  BlogDoc,
  CollectionDoc,
  ImageDoc,
  MenuDoc,
  MenuLinkDoc,
  PageDoc,
  ProductDoc,
  ShopDoc,
  StoreData,
  VariantDoc,
} from '@hatti/storefront-data';
import type { CartDiscountJson, CartJson, CartLineJson } from '@hatti/storefront-api';
import { imageValue, isSafeLink, settingValue, type SettingSchema } from '@hatti/themes';
import { isOnlyDefault, itemsDiscounted, lineTitle } from './cart.js';
import { POLICIES, policyTitle } from './policies.js';

// The objects templates see, made from read models as Shopify's are: `product`, `collection`,
// `section.settings`, and so on. They are plain objects, and LiquidJS runs with
// `ownPropertyOnly`, so nothing a template names reaches JavaScript's prototypes. Lookups by name
// (`collections['sale']`) and products in lists are drops, which fetch when first touched.

/**
 * A render's view of the store: each document fetched once per request, many products in one
 * round trip. A promise is kept from the first time something is asked for, so sections rendered
 * side by side share it, and asking early is prefetching.
 */
export class RequestData {
  #shop: Promise<ShopDoc> | null = null;
  readonly #products = new Map<string, Promise<ProductDoc | null>>();
  readonly #handles = new Map<string, Promise<ProductDoc | null>>();
  readonly #collections = new Map<string, Promise<CollectionDoc | null>>();
  readonly #menus = new Map<string, Promise<MenuDoc | null>>();
  readonly #pages = new Map<string, Promise<PageDoc | null>>();
  readonly #blogs = new Map<string, Promise<BlogDoc | null>>();
  readonly #articles = new Map<string, Promise<ArticleDoc | null>>();
  readonly #articleHandles = new Map<string, Promise<ArticleDoc | null>>();

  constructor(private readonly store: StoreData) {}

  shop(): Promise<ShopDoc> {
    return (this.#shop ??= this.store.shop());
  }

  productByHandle(handle: string): Promise<ProductDoc | null> {
    return remember(this.#handles, handle, () => this.store.productByHandle(handle));
  }

  /** Products by ID, fetching those not asked for before in one round trip. */
  products(ids: readonly string[]): Promise<(ProductDoc | null)[]> {
    return batched(this.#products, ids, (missing) => this.store.products(missing));
  }

  /** Articles by ID, likewise (ADR-177). */
  articles(ids: readonly string[]): Promise<(ArticleDoc | null)[]> {
    return batched(this.#articles, ids, (missing) => this.store.articles(missing));
  }

  collection(handle: string): Promise<CollectionDoc | null> {
    return remember(this.#collections, handle, () => this.store.collectionByHandle(handle));
  }

  menu(handle: string): Promise<MenuDoc | null> {
    return remember(this.#menus, handle, () => this.store.menu(handle));
  }

  /** A policy's body, fetched for its own page (ADR-056). */
  policy(type: string): Promise<string | null> {
    return this.store.policy(type);
  }

  page(handle: string): Promise<PageDoc | null> {
    return remember(this.#pages, handle, () => this.store.pageByHandle(handle));
  }

  blog(handle: string): Promise<BlogDoc | null> {
    return remember(this.#blogs, handle, () => this.store.blogByHandle(handle));
  }

  /** An article by its blog's handle and its own: news/eid-edit. */
  article(handle: string): Promise<ArticleDoc | null> {
    return remember(this.#articleHandles, handle, () => this.store.articleByHandle(handle));
  }
}

/** Documents by ID from `cache`, fetching those not asked for before in one round trip. */
function batched<T>(
  cache: Map<string, Promise<T | null>>,
  ids: readonly string[],
  fetch: (missing: string[]) => Promise<(T | null)[]>,
): Promise<(T | null)[]> {
  const missing = [...new Set(ids.filter((id) => !cache.has(id)))];
  if (missing.length > 0) {
    const batch = fetch(missing);
    missing.forEach((id, index) => {
      cache.set(
        id,
        batch.then((docs) => docs[index] ?? null),
      );
    });
  }
  return Promise.all(ids.map((id) => cache.get(id)!));
}

/** What objects need from the request they are shown for. */
export interface ObjectContext {
  data: RequestData;
  /** The query string: `variant` picks a product's variant. */
  query: Readonly<Record<string, string>>;
  /** How many products a list fetches at a time, when one of them is first touched. */
  chunkSize: number;
}

/** An image: prints as its address; `image_url` and `image_tag` size it. */
export class ImageDrop extends Drop {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string | null;
  readonly aspect_ratio: number;

  constructor(doc: ImageDoc) {
    super();
    this.src = doc.src;
    this.width = doc.width;
    this.height = doc.height;
    this.alt = doc.alt;
    this.aspect_ratio = doc.height > 0 ? Math.round((doc.width / doc.height) * 1000) / 1000 : 1;
  }

  override valueOf(): string {
    return this.src;
  }
}

export function productObject(doc: ProductDoc, ctx: ObjectContext): Record<string, unknown> {
  const images = doc.images.map((image) => new ImageDrop(image));
  const variants = doc.variants.map((variant) => variantObject(variant, doc, images));
  const available = variants.filter((variant) => variant.available);
  const selected = variants.find((variant) => variant.id === ctx.query.variant) ?? null;
  const current = selected ?? available[0] ?? variants[0] ?? null;
  const prices = doc.variants.map((variant) => variant.price);
  const compared = doc.variants.flatMap((variant) =>
    variant.compareAtPrice === null ? [] : [variant.compareAtPrice],
  );
  const onlyDefault = isOnlyDefault(doc);
  return {
    id: doc.id,
    // As search results say what each of them is: pages and articles may join products there.
    object_type: 'product',
    handle: doc.handle,
    title: doc.title,
    url: `/products/${doc.handle}`,
    description: doc.descriptionHtml,
    content: doc.descriptionHtml,
    vendor: doc.vendor,
    type: doc.productType,
    tags: doc.tags,
    price: Math.min(...prices),
    price_min: Math.min(...prices),
    price_max: Math.max(...prices),
    price_varies: Math.min(...prices) !== Math.max(...prices),
    compare_at_price: compared.length > 0 ? Math.min(...compared) : null,
    compare_at_price_min: compared.length > 0 ? Math.min(...compared) : null,
    compare_at_price_max: compared.length > 0 ? Math.max(...compared) : null,
    available: available.length > 0,
    variants,
    first_available_variant: available[0] ?? null,
    selected_variant: selected,
    selected_or_first_available_variant: current,
    has_only_default_variant: onlyDefault,
    options: doc.options.map((option) => option.name),
    options_with_values: doc.options.map((option, index) => ({
      name: option.name,
      position: index + 1,
      values: option.values,
      selected_value: current?.options[index] ?? null,
    })),
    images,
    featured_image: images[0] ?? null,
    media: images,
    featured_media: images[0] ?? null,
  };
}

function variantObject(variant: VariantDoc, product: ProductDoc, images: readonly ImageDrop[]) {
  const image = variant.image === null ? null : (images[variant.image] ?? null);
  return {
    id: variant.id,
    title: variant.title,
    sku: variant.sku,
    price: variant.price,
    compare_at_price: variant.compareAtPrice,
    available: variant.available,
    options: variant.options,
    option1: variant.options[0] ?? null,
    option2: variant.options[1] ?? null,
    option3: variant.options[2] ?? null,
    url: `/products/${product.handle}?variant=${variant.id}`,
    image,
    featured_image: image,
  };
}

/**
 * How `{% paginate %}` narrows a collection's products to a page: before a template lists them,
 * or instead of the first 50 it would list otherwise, as on Shopify.
 */
export const PAGINATE = Symbol('paginate');

export interface Paginable {
  [PAGINATE](offset: number, limit: number): void;
}

/** A collection. Its products are fetched a chunk at a time, when a template first touches one. */
export function collectionObject(
  doc: CollectionDoc,
  ctx: ObjectContext,
): Record<string, unknown> & Paginable {
  let window = { offset: 0, limit: 50 };
  let products: ItemRef[] | null = null;
  return {
    id: doc.id,
    handle: doc.handle,
    title: doc.title,
    url: `/collections/${doc.handle}`,
    description: doc.descriptionHtml,
    image: doc.image ? new ImageDrop(doc.image) : null,
    products_count: doc.productIds.length,
    all_products_count: doc.productIds.length,
    get products(): ItemRef[] {
      const ids = doc.productIds.slice(window.offset, window.offset + window.limit);
      return (products ??= lazyProducts(ids, ctx));
    },
    [PAGINATE](offset: number, limit: number) {
      window = { offset, limit };
      products = null;
    },
  };
}

/**
 * Shopify's `search`, for the search page (ADR-046): what was typed, and the products found, best
 * first, fetched a chunk at a time when a template first touches one. Not performed without words.
 */
export function searchObject(
  found: { terms: string; productIds: readonly string[] } | null,
  ctx: ObjectContext,
): Record<string, unknown> & Paginable {
  const ids = found?.productIds ?? [];
  let window = { offset: 0, limit: 50 };
  let results: ItemRef[] | null = null;
  return {
    performed: found !== null && found.terms.trim() !== '',
    terms: found?.terms ?? '',
    results_count: ids.length,
    types: ['product'],
    get results(): ItemRef[] {
      return (results ??= lazyProducts(
        ids.slice(window.offset, window.offset + window.limit),
        ctx,
      ));
    },
    [PAGINATE](offset: number, limit: number) {
      window = { offset, limit };
      results = null;
    },
  };
}

/**
 * Shopify's `predictive_search`, for a predictive search's section (ADR-046): what the shopper
 * has typed so far, the kinds of result asked for, and the products that could be what they
 * want, best first. Hatti finds nothing of the other kinds yet.
 */
export function predictiveSearchObject(
  found: { terms: string; types: readonly string[]; productIds: readonly string[] } | null,
  ctx: ObjectContext,
): Record<string, unknown> {
  const ids = found?.productIds ?? [];
  let products: ItemRef[] | null = null;
  return {
    performed: found !== null && found.terms !== '',
    terms: found?.terms ?? '',
    types: found?.types ?? [],
    resources: {
      get products(): ItemRef[] {
        return (products ??= lazyProducts(ids, ctx));
      },
      collections: [],
      pages: [],
      articles: [],
      queries: [],
    },
  };
}

/**
 * A shop's page (ADR-045), as Shopify's `page`: its content was cleaned when it was saved, so
 * themes print it as it is, as they do Shopify's.
 */
export function pageObject(doc: PageDoc): Record<string, unknown> {
  return {
    id: doc.id,
    handle: doc.handle,
    title: doc.title,
    url: `/pages/${doc.handle}`,
    content: doc.bodyHtml,
    published_at: doc.publishedAt,
    template_suffix: doc.templateSuffix,
  };
}

/**
 * A shop's blog (ADR-177), as Shopify's `blog`: its published articles, the latest first, fetched
 * a chunk at a time as a page of them is shown; with `tag`, as at /blogs/{handle}/tagged/{tag},
 * those tagged with it alone, a tag matching as its handle does.
 */
export function blogObject(
  doc: BlogDoc,
  ctx: ObjectContext,
  tag: string | null = null,
): Record<string, unknown> & Paginable {
  const listed =
    tag === null
      ? doc.articles
      : doc.articles.filter((article) => article.tags.some((each) => handleize(each) === tag));
  let window = { offset: 0, limit: 50 };
  let articles: ItemRef[] | null = null;
  return {
    id: doc.id,
    handle: doc.handle,
    title: doc.title,
    url: `/blogs/${doc.handle}`,
    template_suffix: doc.templateSuffix,
    articles_count: listed.length,
    // Every tag of its articles, and of those listed, as Shopify's `all_tags` and `tags`.
    all_tags: tagsOf(doc.articles),
    tags: tagsOf(listed),
    get articles(): ItemRef[] {
      const ids = listed.slice(window.offset, window.offset + window.limit);
      return (articles ??= lazyArticles(
        ids.map((article) => article.id),
        ctx,
      ));
    },
    [PAGINATE](offset: number, limit: number) {
      window = { offset, limit };
      articles = null;
    },
  };
}

/** The tags of these articles, each once whatever its case, in alphabetical order. */
function tagsOf(articles: readonly { tags: readonly string[] }[]): string[] {
  const seen = new Map<string, string>();
  for (const article of articles) {
    for (const tag of article.tags)
      if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * One of a blog's articles (ADR-177), as Shopify's `article`: its content and excerpt were
 * cleaned when they were saved, so themes print them as they are. No image or comments yet.
 */
export function articleObject(doc: ArticleDoc): Record<string, unknown> {
  return {
    id: doc.id,
    // As search results say what each of them is.
    object_type: 'article',
    handle: doc.handle,
    title: doc.title,
    url: `/blogs/${doc.blogHandle}/${doc.handle}`,
    content: doc.bodyHtml,
    excerpt: doc.summaryHtml,
    excerpt_or_content: doc.summaryHtml || doc.bodyHtml,
    author: doc.author,
    published_at: doc.publishedAt,
    created_at: doc.publishedAt,
    tags: doc.tags,
    template_suffix: doc.templateSuffix,
    image: null,
    comments: [],
    comments_count: 0,
  };
}

/** A menu, as Liquid's `linklist`: its links, with the links under each, three levels at most. */
export function menuObject(doc: MenuDoc): Record<string, unknown> {
  const links = linkObjects(doc.links, 1);
  return { handle: doc.handle, title: doc.title, links, levels: levelsOf(links) };
}

/** Links a theme may print as they are: one whose address could end an attribute is left out. */
function linkObjects(
  links: readonly MenuLinkDoc[] | undefined,
  level: number,
): Record<string, unknown>[] {
  if (!links || level > 3) return [];
  return links
    .filter((link) => typeof link.url === 'string' && isSafeLink(link.url))
    .map((link) => {
      const children = linkObjects(link.links, level + 1);
      return {
        title: link.title,
        url: link.url,
        type: link.type ?? 'http_link',
        links: children,
        levels: children.length > 0 ? levelsOf(children) : 0,
      };
    });
}

function levelsOf(links: readonly Record<string, unknown>[]): number {
  return links.length === 0 ? 0 : 1 + Math.max(...links.map((link) => link.levels as number));
}

/**
 * Hatti's `delivery`: what delivery costs, everywhere, in zones of cities, and nothing from
 * `free_above`. Documents from before shops set charges have none: delivery is free.
 */
export function deliveryObject(doc: ShopDoc): Record<string, unknown> {
  const delivery = doc.delivery ?? { charge: 0, freeAbove: null, zones: [] };
  return {
    charge: delivery.charge,
    free_above: delivery.freeAbove,
    zones: delivery.zones.map((zone) => ({ ...zone })),
  };
}

/**
 * Shopify's `shop`: its `domain` its primary domain of its own, else its handle's subdomain of
 * `platformUrl`, the platform's storefront address; its `url` that domain, with the platform's
 * scheme and port (ADR-048). Without `platformUrl`, as in tests, neither is known.
 */
export function shopObject(
  doc: ShopDoc,
  platformUrl?: string,
  /** The page's language, for its policies' addresses and titles. */
  language: { locale: string; prefix: string } = { locale: 'en', prefix: '' },
): Record<string, unknown> {
  const platform = platformUrl ? new URL(platformUrl) : null;
  const domain = doc.domain || (platform ? `${doc.handle}.${platform.hostname}` : '');
  let url = '';
  if (platform && domain) {
    const address = new URL(platform.origin);
    address.hostname = domain;
    url = address.origin;
  }
  return {
    name: doc.name,
    domain,
    url,
    currency: 'PKR',
    // Prices include any sales tax, as Pakistan's consumer laws ask them to be shown (ADR-096).
    taxes_included: true,
    whatsapp: doc.whatsapp,
    // What the password page tells shoppers while the shop is closed (ADR-054), as safe HTML.
    password_message: doc.password?.message ?? '',
    ...policiesObject(doc, language),
  };
}

/**
 * The shop's policies as Liquid gives them (ADR-056): `shop.policies`, in Shopify's order, and each
 * by name, as `shop.refund_policy`; their titles and addresses in the page's language. Their
 * bodies are on their own pages.
 */
function policiesObject(
  doc: ShopDoc,
  language: { locale: string; prefix: string },
): Record<string, unknown> {
  const has = new Set(doc.policies ?? []);
  const shown = POLICIES.filter((policy) => has.has(policy.type)).map((policy) => ({
    id: policy.type,
    type: policy.type,
    title: policyTitle(policy, language.locale),
    url: `${language.prefix}/policies/${policy.handle}`,
  }));
  const byType = Object.fromEntries(shown.map((policy) => [policy.type, policy]));
  return {
    policies: shown,
    refund_policy: byType.refund_policy ?? null,
    privacy_policy: byType.privacy_policy ?? null,
    terms_of_service: byType.terms_of_service ?? null,
    shipping_policy: byType.shipping_policy ?? null,
    contact_information: byType.contact_information ?? null,
  };
}

/**
 * Products in a list, fetched `chunkSize` at a time: touching the first product of a featured
 * collection of eight fetches the first chunk, in one round trip, not eight round trips or fifty
 * products. LiquidJS evaluates one expression at a time, so batching by the tick, as DataLoader
 * does, would fetch one product per round trip.
 */
/**
 * A list's items, products or articles, fetched a chunk at a time when a template first touches
 * one of them.
 */
class LazyList {
  readonly #loaded: (Record<string, unknown> | null | undefined)[];
  readonly #chunks = new Map<number, Promise<void>>();

  constructor(
    private readonly ids: readonly string[],
    private readonly chunkSize: number,
    private readonly fetch: (ids: readonly string[]) => Promise<(Record<string, unknown> | null)[]>,
  ) {
    this.#loaded = ids.map(() => undefined);
  }

  refs(): ItemRef[] {
    return this.ids.map((_, index) => new ItemRef(this, index));
  }

  /** The item at `index` if its chunk is in; null if it is gone; undefined if not fetched. */
  loaded(index: number): Record<string, unknown> | null | undefined {
    return this.#loaded[index];
  }

  async load(index: number): Promise<Record<string, unknown> | null> {
    const chunk = Math.floor(index / this.chunkSize);
    let loading = this.#chunks.get(chunk);
    if (!loading) {
      const start = chunk * this.chunkSize;
      loading = this.fetch(this.ids.slice(start, start + this.chunkSize)).then((items) => {
        items.forEach((item, offset) => {
          this.#loaded[start + offset] = item;
        });
      });
      this.#chunks.set(chunk, loading);
    }
    await loading;
    return this.#loaded[index] ?? null;
  }
}

/** Products in a list, fetched a chunk at a time. */
function lazyProducts(ids: readonly string[], ctx: ObjectContext): ItemRef[] {
  return new LazyList(ids, ctx.chunkSize, async (chunk) =>
    (await ctx.data.products(chunk)).map((doc) => doc && productObject(doc, ctx)),
  ).refs();
}

/** Articles in a list, likewise (ADR-177). */
function lazyArticles(ids: readonly string[], ctx: ObjectContext): ItemRef[] {
  return new LazyList(ids, ctx.chunkSize, async (chunk) =>
    (await ctx.data.articles(chunk)).map((doc) => doc && articleObject(doc)),
  ).refs();
}

/** An item in a list: its fields, once its chunk is in. */
export class ItemRef extends Drop {
  readonly #list: LazyList;
  readonly #index: number;

  constructor(list: LazyList, index: number) {
    super();
    this.#list = list;
    this.#index = index;
  }

  override liquidMethodMissing(key: string | number): unknown {
    const item = this.#list.loaded(this.#index);
    if (item !== undefined) return field(item, key);
    return this.#list.load(this.#index).then((loaded) => field(loaded, key));
  }

  override valueOf(): string {
    return String(this.#list.loaded(this.#index)?.title ?? '');
  }
}

/** `collections['sale']`, `all_products['kurta']`, `linklists['main-menu']`: fetched by name. */
export class Lookup extends Drop {
  readonly #find: (handle: string) => Promise<unknown>;

  constructor(find: (handle: string) => Promise<unknown>) {
    super();
    this.#find = find;
  }

  override liquidMethodMissing(key: string | number): unknown {
    return typeof key === 'string' ? this.#find(key) : undefined;
  }
}

export function lookups(ctx: ObjectContext): Record<string, Lookup> {
  return {
    collections: new Lookup((handle) => collectionPromise(handle, ctx)),
    all_products: new Lookup((handle) => productPromise(handle, ctx)),
    linklists: new Lookup(async (handle) => {
      const doc = await ctx.data.menu(handle);
      return doc ? menuObject(doc) : null;
    }),
    pages: new Lookup((handle) => pagePromise(handle, ctx)),
    blogs: new Lookup((handle) => blogPromise(handle, ctx)),
    // By the blog's handle and the article's: articles['news/eid-edit'].
    articles: new Lookup((handle) => articlePromise(handle, ctx)),
  };
}

/**
 * Settings as templates see them: those naming a collection, product, page, blog, article or
 * menu become it, fetched as soon as the settings are made, which prefetches them for the render;
 * images become images.
 * Only the schema's settings, as on Shopify; a value not of its setting's type gives way to the
 * setting's default, or to nothing: shops' files can hold anything, and themes print colours,
 * numbers and links as they are.
 */
export function resolveSettings(
  values: Readonly<Record<string, unknown>>,
  schema: readonly SettingSchema[] | undefined,
  ctx: ObjectContext,
): Record<string, unknown> {
  const schemas = new Map((schema ?? []).map((setting) => [setting.id, setting]));
  const settings: Record<string, unknown> = {};
  for (const [id, given] of Object.entries(values)) {
    const setting = schemas.get(id);
    if (!setting) continue;
    const value = settingValue(setting, given);
    const named = typeof value === 'string' && value !== '' ? value : null;
    switch (setting.type) {
      case 'collection':
        settings[id] = named && collectionPromise(named, ctx);
        break;
      case 'product':
        settings[id] = named && productPromise(named, ctx);
        break;
      case 'link_list':
        settings[id] = named && ctx.data.menu(named).then((doc) => doc && menuObject(doc));
        break;
      case 'page':
        settings[id] = named && pagePromise(named, ctx);
        break;
      case 'blog':
        settings[id] = named && blogPromise(named, ctx);
        break;
      case 'article':
        settings[id] = named && articlePromise(named, ctx);
        break;
      case 'image_picker':
        settings[id] = imageSetting(value);
        break;
      default:
        settings[id] = value;
    }
  }
  return settings;
}

function collectionPromise(handle: string, ctx: ObjectContext) {
  return ctx.data.collection(handle).then((doc) => doc && collectionObject(doc, ctx));
}

function pagePromise(handle: string, ctx: ObjectContext) {
  return ctx.data.page(handle).then((doc) => doc && pageObject(doc));
}

function productPromise(handle: string, ctx: ObjectContext) {
  return ctx.data.productByHandle(handle).then((doc) => doc && productObject(doc, ctx));
}

function blogPromise(handle: string, ctx: ObjectContext) {
  return ctx.data.blog(handle).then((doc) => doc && blogObject(doc, ctx));
}

function articlePromise(handle: string, ctx: ObjectContext) {
  return ctx.data.article(handle).then((doc) => doc && articleObject(doc));
}

/** Text as a handle, as Shopify's `handleize` makes one: "Eid Edit" gives eid-edit. */
export function handleize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** An image setting: its address, or the image with its size, as the media library keeps it. */
function imageSetting(value: unknown): ImageDrop | null {
  const image = imageValue(value);
  return image ? new ImageDrop(image) : null;
}

/** A field of a plain object; nothing it inherits. */
function field(object: Record<string, unknown> | null, key: string | number): unknown {
  return object && Object.hasOwn(object, key) ? object[key] : undefined;
}

function remember<T>(cache: Map<string, Promise<T>>, key: string, fetch: () => Promise<T>) {
  let promise = cache.get(key);
  if (!promise) {
    promise = fetch();
    cache.set(key, promise);
  }
  return promise;
}

/**
 * The shopper's cart, as Liquid's `cart`: its lines with their products and variants, from the
 * documents fetched with it. A line whose product is not published yet has its title and price.
 */
export function cartObject(
  cart: CartJson | null,
  products: ReadonlyMap<string, ProductDoc>,
  ctx: ObjectContext,
  changeUrl: string,
): Record<string, unknown> {
  const items = (cart?.items ?? []).map((item) =>
    lineItemObject(item, products.get(item.productId), ctx, changeUrl),
  );
  const subtotal = cart?.subtotal ?? 0;
  const total = subtotal - (cart?.totalDiscount ?? 0);
  const discount = cart?.discount ?? null;
  const applications = discountApplications(discount);
  return {
    item_count: cart?.itemCount ?? 0,
    items,
    total_price: total,
    original_total_price: subtotal,
    items_subtotal_price: subtotal,
    checkout_charge_amount: total,
    total_discount: cart?.totalDiscount ?? 0,
    total_weight: cart?.totalWeightGrams ?? 0,
    note: cart?.note ?? '',
    attributes: cart?.attributes ?? {},
    currency: { iso_code: 'PKR' },
    requires_shipping: items.length > 0,
    // Prices include any sales tax (ADR-096): themes say so, and checkout adds none.
    taxes_included: true,
    discount_applications: applications,
    cart_level_discount_applications: applications.filter(
      (application) => application.target_type === 'line_item',
    ),
    /** Hatti's, as `/cart.js` has them: the code the cart keeps, and whether it applies now. */
    discount_codes: discount ? [{ code: discount.code, applicable: discount.applicable }] : [],
  };
}

/**
 * The cart's discount code as Liquid's `discount_application`, when it applies: across the
 * items, its `value` the percentage or the amount in paisa; or, for free delivery, aimed at the
 * delivery checkout adds (`target_type` "shipping_line"), which takes nothing off the cart and
 * so is not among its cart-level applications, which themes list with what they take off.
 */
function discountApplications(
  discount: CartDiscountJson | null,
): { target_type: string; [field: string]: unknown }[] {
  if (!discount?.applicable) return [];
  const common = { type: 'discount_code', title: discount.code, target_selection: 'all' };
  if (discount.kind === 'free_shipping') {
    return [
      {
        ...common,
        value: 100,
        value_type: 'percentage',
        allocation_method: 'each',
        target_type: 'shipping_line',
        total_allocated_amount: 0,
      },
    ];
  }
  if (!itemsDiscounted(discount)) return [];
  return [
    {
      ...common,
      value: discount.value,
      value_type: discount.kind === 'percentage' ? 'percentage' : 'fixed_amount',
      allocation_method: 'across',
      target_type: 'line_item',
      total_allocated_amount: discount.amount,
    },
  ];
}

function lineItemObject(
  item: CartLineJson,
  doc: ProductDoc | undefined,
  ctx: ObjectContext,
  changeUrl: string,
): Record<string, unknown> {
  const product = doc ? productObject(doc, { ...ctx, query: { variant: item.variantId } }) : null;
  const variant = (product?.selected_variant ?? null) as { image?: unknown } | null;
  const onlyDefault = doc ? isOnlyDefault(doc) : true;
  const at = doc?.variants.findIndex((each) => each.id === item.variantId) ?? -1;
  return {
    id: item.variantId,
    key: item.key,
    quantity: item.quantity,
    variant_id: item.variantId,
    product_id: item.productId,
    product,
    variant,
    title: lineTitle(item, onlyDefault),
    sku: item.sku,
    vendor: doc?.vendor ?? '',
    price: item.price,
    final_price: item.price,
    original_price: item.price,
    line_price: item.linePrice,
    final_line_price: item.linePrice,
    original_line_price: item.linePrice,
    total_discount: 0,
    discounts: [],
    line_level_discount_allocations: [],
    properties: item.properties,
    url: doc ? `/products/${doc.handle}?variant=${item.variantId}` : null,
    url_to_remove: `${changeUrl}?id=${encodeURIComponent(item.key)}&quantity=0`,
    image: variant?.image ?? product?.featured_image ?? null,
    options_with_values: (doc?.options ?? []).map((option, index) => ({
      name: option.name,
      value: at >= 0 ? (doc!.variants[at]!.options[index] ?? '') : '',
    })),
    requires_shipping: true,
    gift_card: false,
    taxable: item.taxable,
    grams: item.grams,
    /** Hatti's: the most the line can have now, when fewer than its quantity; else nil. */
    max_quantity: item.maxQuantity,
  };
}
