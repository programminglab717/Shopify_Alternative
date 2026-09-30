import { Drop } from 'liquidjs';
import type {
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
import type { CartJson, CartLineJson } from '@hatti/storefront-api';
import { imageValue, isSafeLink, settingValue, type SettingSchema } from '@hatti/themes';
import { isOnlyDefault, lineTitle } from './cart.js';

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

  constructor(private readonly store: StoreData) {}

  shop(): Promise<ShopDoc> {
    return (this.#shop ??= this.store.shop());
  }

  productByHandle(handle: string): Promise<ProductDoc | null> {
    return remember(this.#handles, handle, () => this.store.productByHandle(handle));
  }

  /** Products by ID, fetching those not asked for before in one round trip. */
  products(ids: readonly string[]): Promise<(ProductDoc | null)[]> {
    const missing = [...new Set(ids.filter((id) => !this.#products.has(id)))];
    if (missing.length > 0) {
      const batch = this.store.products(missing);
      missing.forEach((id, index) => {
        this.#products.set(
          id,
          batch.then((docs) => docs[index] ?? null),
        );
      });
    }
    return Promise.all(ids.map((id) => this.#products.get(id)!));
  }

  collection(handle: string): Promise<CollectionDoc | null> {
    return remember(this.#collections, handle, () => this.store.collectionByHandle(handle));
  }

  menu(handle: string): Promise<MenuDoc | null> {
    return remember(this.#menus, handle, () => this.store.menu(handle));
  }

  page(handle: string): Promise<PageDoc | null> {
    return remember(this.#pages, handle, () => this.store.pageByHandle(handle));
  }
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
  let products: ProductRef[] | null = null;
  return {
    id: doc.id,
    handle: doc.handle,
    title: doc.title,
    url: `/collections/${doc.handle}`,
    description: doc.descriptionHtml,
    image: doc.image ? new ImageDrop(doc.image) : null,
    products_count: doc.productIds.length,
    all_products_count: doc.productIds.length,
    get products(): ProductRef[] {
      const ids = doc.productIds.slice(window.offset, window.offset + window.limit);
      return (products ??= new LazyProducts(ids, ctx).refs());
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
  let results: ProductRef[] | null = null;
  return {
    performed: found !== null && found.terms.trim() !== '',
    terms: found?.terms ?? '',
    results_count: ids.length,
    types: ['product'],
    get results(): ProductRef[] {
      return (results ??= new LazyProducts(
        ids.slice(window.offset, window.offset + window.limit),
        ctx,
      ).refs());
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
  let products: ProductRef[] | null = null;
  return {
    performed: found !== null && found.terms !== '',
    terms: found?.terms ?? '',
    types: found?.types ?? [],
    resources: {
      get products(): ProductRef[] {
        return (products ??= new LazyProducts(ids, ctx).refs());
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
export function shopObject(doc: ShopDoc, platformUrl?: string): Record<string, unknown> {
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
    whatsapp: doc.whatsapp,
    // What the password page tells shoppers while the shop is closed (ADR-054), as safe HTML.
    password_message: doc.password?.message ?? '',
  };
}

/**
 * Products in a list, fetched `chunkSize` at a time: touching the first product of a featured
 * collection of eight fetches the first chunk, in one round trip, not eight round trips or fifty
 * products. LiquidJS evaluates one expression at a time, so batching by the tick, as DataLoader
 * does, would fetch one product per round trip.
 */
class LazyProducts {
  readonly #loaded: (Record<string, unknown> | null | undefined)[];
  readonly #chunks = new Map<number, Promise<void>>();

  constructor(
    private readonly ids: readonly string[],
    private readonly ctx: ObjectContext,
  ) {
    this.#loaded = ids.map(() => undefined);
  }

  refs(): ProductRef[] {
    return this.ids.map((_, index) => new ProductRef(this, index));
  }

  /** The product at `index` if its chunk is in; null if it is gone; undefined if not fetched. */
  loaded(index: number): Record<string, unknown> | null | undefined {
    return this.#loaded[index];
  }

  async load(index: number): Promise<Record<string, unknown> | null> {
    const { chunkSize } = this.ctx;
    const chunk = Math.floor(index / chunkSize);
    let loading = this.#chunks.get(chunk);
    if (!loading) {
      const start = chunk * chunkSize;
      loading = this.ctx.data.products(this.ids.slice(start, start + chunkSize)).then((docs) => {
        docs.forEach((doc, offset) => {
          this.#loaded[start + offset] = doc ? productObject(doc, this.ctx) : null;
        });
      });
      this.#chunks.set(chunk, loading);
    }
    await loading;
    return this.#loaded[index] ?? null;
  }
}

/** A product in a list: its fields, once its chunk is in. */
export class ProductRef extends Drop {
  readonly #list: LazyProducts;
  readonly #index: number;

  constructor(list: LazyProducts, index: number) {
    super();
    this.#list = list;
    this.#index = index;
  }

  override liquidMethodMissing(key: string | number): unknown {
    const product = this.#list.loaded(this.#index);
    if (product !== undefined) return field(product, key);
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
  };
}

/**
 * Settings as templates see them: those naming a collection, product, page or menu become it, fetched
 * as soon as the settings are made, which prefetches them for the render; images become images.
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
  return {
    item_count: cart?.itemCount ?? 0,
    items,
    total_price: subtotal,
    original_total_price: subtotal,
    items_subtotal_price: subtotal,
    checkout_charge_amount: subtotal,
    total_discount: 0,
    total_weight: cart?.totalWeightGrams ?? 0,
    note: cart?.note ?? '',
    attributes: cart?.attributes ?? {},
    currency: { iso_code: 'PKR' },
    requires_shipping: items.length > 0,
    discount_applications: [],
    cart_level_discount_applications: [],
  };
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
    grams: item.grams,
    /** Hatti's: the most the line can have now, when fewer than its quantity; else nil. */
    max_quantity: item.maxQuantity,
  };
}
