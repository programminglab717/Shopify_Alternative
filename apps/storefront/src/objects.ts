import { Drop } from 'liquidjs';
import type {
  CollectionDoc,
  ImageDoc,
  MenuDoc,
  MenuLinkDoc,
  ProductDoc,
  ShopDoc,
  StoreData,
  VariantDoc,
} from '@hatti/storefront-data';
import type { SettingSchema } from './theme.js';

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
  const onlyDefault =
    doc.options.length === 1 &&
    doc.options[0]!.name === 'Title' &&
    doc.options[0]!.values.length === 1;
  return {
    id: doc.id,
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
    .filter((link) => typeof link.url === 'string' && LINK.test(link.url))
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

export function shopObject(doc: ShopDoc): Record<string, unknown> {
  return {
    name: doc.name,
    domain: doc.domain,
    url: doc.domain ? `https://${doc.domain}` : '',
    currency: 'PKR',
    whatsapp: doc.whatsapp,
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
  };
}

/**
 * Settings as templates see them: those naming a collection, product or menu become it, fetched
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
    const value = checkedSetting(setting, given);
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

function productPromise(handle: string, ctx: ObjectContext) {
  return ctx.data.productByHandle(handle).then((doc) => doc && productObject(doc, ctx));
}

// What settings of these types may hold. A link or an image's address is a path on the
// storefront or a web address (a link may also be an email address or a phone number), with
// nothing that could end the attribute it is printed in.
const COLOR =
  /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*\d{1,3}(\s*,\s*\d{1,3}){2}(\s*,\s*(0|1|0?\.\d+))?\s*\))$/i;
const LINK = /^(\/(?![/\\])|https?:\/\/|mailto:|tel:)[^\s"'<>\\`]*$/i;
const IMAGE_SRC = /^(\/(?![/\\])|https:\/\/)[^\s"'<>\\`]*$/i;

/** A setting's value if it is of the setting's type, else its default if that is, else null. */
function checkedSetting(setting: SettingSchema, value: unknown): unknown {
  return ofType(setting, value) ?? ofType(setting, setting.default) ?? null;
}

/** `value` as a setting of its type holds it; undefined if it is not one. */
function ofType(setting: SettingSchema, value: unknown): unknown {
  switch (setting.type) {
    case 'color':
      return typeof value === 'string' && COLOR.test(value) ? value : undefined;
    case 'range':
    case 'number': {
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof number !== 'number' || !Number.isFinite(number)) return undefined;
      return Math.min(Math.max(number, setting.min ?? -Infinity), setting.max ?? Infinity);
    }
    case 'checkbox':
      return typeof value === 'boolean' ? value : undefined;
    case 'select':
    case 'radio':
      return setting.options?.some((option) => option.value === value) ? value : undefined;
    case 'url':
      return typeof value === 'string' && LINK.test(value) ? value : undefined;
    case 'image_picker':
      return imageSetting(value) ? value : undefined;
    case 'text':
    case 'textarea':
    case 'richtext':
    case 'inline_richtext':
    case 'html':
    case 'collection':
    case 'product':
    case 'link_list':
      return typeof value === 'string' ? value : undefined;
    default:
      return value;
  }
}

/** An image setting: its address, or the image with its size, as the media library keeps it. */
function imageSetting(value: unknown): ImageDrop | null {
  if (typeof value === 'string' && IMAGE_SRC.test(value)) {
    return new ImageDrop({ src: value, width: 0, height: 0, alt: null });
  }
  if (typeof value !== 'object' || value === null) return null;
  const { src, width, height, alt } = value as Record<string, unknown>;
  if (typeof src !== 'string' || !IMAGE_SRC.test(src)) return null;
  const size = (pixels: unknown) =>
    typeof pixels === 'number' && Number.isFinite(pixels) && pixels > 0 ? Math.round(pixels) : 0;
  return new ImageDrop({
    src,
    width: size(width),
    height: size(height),
    alt: typeof alt === 'string' ? alt : null,
  });
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
