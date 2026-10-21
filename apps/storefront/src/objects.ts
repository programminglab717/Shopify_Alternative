import { Drop } from 'liquidjs';
import { checkoutPausedAt } from '@hatti/storefront-data';
import type {
  AttributeWordDoc,
  ArticleDoc,
  BlogDoc,
  CollectionDoc,
  ImageDoc,
  MediaDoc,
  MenuDoc,
  MenuLinkDoc,
  MetafieldsDoc,
  PageDoc,
  ProductDoc,
  ShopDoc,
  StoreData,
  VariantDoc,
  VideoSourceDoc,
} from '@hatti/storefront-data';
import type {
  CartAutomaticDiscountJson,
  CartDiscountJson,
  CartJson,
  CartLineJson,
} from '@hatti/storefront-api';
import { imageValue, isSafeLink, settingValue, type SettingSchema } from '@hatti/themes';
import { isOnlyDefault, itemsDiscounted, lineTitle } from './cart.js';
import type { FilteredListing, FilterRequest } from './filters.js';
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
  readonly #pagesById = new Map<string, Promise<PageDoc | null>>();
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

  /** Pages by ID, as a search finds them (ADR-212), likewise. */
  pages(ids: readonly string[]): Promise<(PageDoc | null)[]> {
    return batched(this.#pagesById, ids, (missing) => this.store.pages(missing));
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
  /** What a collection's page filters it by (SRC-03, ADR-478); none where absent. */
  filters?: FilterRequest;
  /**
   * What the page's language puts before its pages' addresses, `/ur` on Urdu pages, as Shopify's
   * objects' `url` carry their locale's (ADR-624); none in the shop's own language.
   */
  prefix?: string;
  /**
   * What each of the shop's pictures its theme names holds, by the picture's file ID (ADR-670),
   * as the shop's document has it: put in the picture's address.
   */
  pictures?: Readonly<Record<string, string>>;
}

/**
 * A path on the shop in the page's language (ADR-624): under `prefix` where the path is the
 * shop's own and not in a language already.
 */
export function localizedPath(path: string, prefix = ''): string {
  if (!prefix || !path.startsWith('/') || path.startsWith('//')) return path;
  if (/^\/[a-z]{2}(?:-[a-z]{2})?(?=[/?#]|$)/i.test(path)) return path;
  return path === '/'
    ? prefix
    : /^\/[?#]/.test(path)
      ? `${prefix}${path.slice(1)}`
      : `${prefix}${path}`;
}

/** An image: prints as its address; `image_url` and `image_tag` size it. */
export class ImageDrop extends Drop {
  /** As Shopify's media object, among a product's media (ADR-258). */
  readonly media_type = 'image';
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string | null;
  readonly aspect_ratio: number;
  /** As Shopify's image_presentation: its focal point, the middle where the shop set none. */
  readonly presentation: { focal_point: FocalPointDrop };
  /** The focal point the shop set (ADR-257), which `image_tag` keeps in sight; null for none. */
  readonly #focalPoint: { x: number; y: number } | null;

  constructor(doc: ImageDoc) {
    super();
    this.src = doc.src;
    this.width = doc.width;
    this.height = doc.height;
    this.alt = doc.alt;
    this.aspect_ratio = doc.height > 0 ? Math.round((doc.width / doc.height) * 1000) / 1000 : 1;
    this.#focalPoint = doc.focalPoint ?? null;
    const { x, y } = doc.focalPoint ?? { x: 50, y: 50 };
    this.presentation = { focal_point: new FocalPointDrop(x, y) };
  }

  /** The focal point the shop set for `image`; null for none. */
  static focalPointOf(image: ImageDrop): FocalPointDrop | null {
    return image.#focalPoint && image.presentation.focal_point;
  }

  /** As a media's: an image is its own preview. */
  get preview_image(): ImageDrop {
    return this;
  }

  override valueOf(): string {
    return this.src;
  }
}

/** A video's file, as Shopify's video_source. */
export class VideoSourceDrop extends Drop {
  readonly url: string;
  readonly mime_type: string;
  readonly format: string;
  readonly width: number;
  readonly height: number;

  constructor(doc: VideoSourceDoc) {
    super();
    this.url = doc.src;
    this.mime_type = doc.mimeType;
    this.format = doc.format;
    this.width = doc.width;
    this.height = doc.height;
  }

  override valueOf(): string {
    return this.url;
  }
}

/** A video the shop uploaded, as Shopify's video object (ADR-258). */
export class VideoDrop extends Drop {
  readonly media_type = 'video';
  readonly id: string;
  readonly alt: string | null;
  readonly position: number;
  readonly preview_image: ImageDrop;
  readonly sources: VideoSourceDrop[];
  /** In milliseconds. */
  readonly duration: number;
  readonly aspect_ratio: number;

  constructor(doc: Extract<MediaDoc, { type: 'video' }>, position: number) {
    super();
    this.id = doc.id;
    this.alt = doc.alt;
    this.position = position;
    this.preview_image = new ImageDrop(doc.preview);
    this.sources = doc.sources.map((source) => new VideoSourceDrop(source));
    this.duration = doc.durationMs;
    const [first] = doc.sources;
    this.aspect_ratio =
      first && first.height > 0 ? Math.round((first.width / first.height) * 1000) / 1000 : 1;
  }

  override valueOf(): string {
    return this.preview_image.src;
  }
}

/** A YouTube or Vimeo video, as Shopify's external_video object (ADR-258). */
export class ExternalVideoDrop extends Drop {
  readonly media_type = 'external_video';
  readonly id: string;
  readonly alt: string | null;
  readonly position: number;
  readonly preview_image: ImageDrop;
  readonly host: 'youtube' | 'vimeo';
  readonly external_id: string;
  readonly aspect_ratio: number;

  constructor(doc: Extract<MediaDoc, { type: 'external_video' }>, position: number) {
    super();
    this.id = doc.id;
    this.alt = doc.alt;
    this.position = position;
    this.preview_image = new ImageDrop(doc.preview);
    this.host = doc.host;
    this.external_id = doc.externalId;
    this.aspect_ratio = this.preview_image.aspect_ratio;
  }

  override valueOf(): string {
    return this.preview_image.src;
  }
}

/**
 * A product's media in its order, as Shopify's `product.media` (ADR-258): its images, and its
 * videos; its images alone in documents with no video.
 */
function mediaOf(doc: ProductDoc, images: readonly ImageDrop[]): Drop[] {
  if (!doc.media) return [...images];
  return doc.media.flatMap((item, index): Drop[] => {
    if (item.type === 'image') return images[item.image] ? [images[item.image]!] : [];
    return [
      item.type === 'video'
        ? new VideoDrop(item, index + 1)
        : new ExternalVideoDrop(item, index + 1),
    ];
  });
}

/**
 * What matters in an image, as Shopify's focal_point: `x` and `y` in percent of it across and
 * down, and "x% y%" as text, as CSS's object-position takes it.
 */
export class FocalPointDrop extends Drop {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {
    super();
  }

  override valueOf(): string {
    return `${this.x}% ${this.y}%`;
  }
}

export function productObject(doc: ProductDoc, ctx: ObjectContext): Record<string, unknown> {
  const images = doc.images.map((image) => new ImageDrop(image));
  const media = mediaOf(doc, images);
  const prefix = ctx.prefix ?? '';
  const variants = doc.variants.map((variant) => variantObject(variant, doc, images, prefix));
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
    url: `${prefix}/products/${doc.handle}`,
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
    // Sold as a gift card (ADR-451), a card issued for each one once the order is paid.
    'gift_card?': doc.giftCard === true,
    options: doc.options.map((option) => option.name),
    options_with_values: doc.options.map((option, index) => ({
      name: option.name,
      position: index + 1,
      values: option.values,
      selected_value: current?.options[index] ?? null,
    })),
    images,
    featured_image: images[0] ?? null,
    media,
    featured_media: media[0] ?? null,
    // When it was made and last changed (ADR-216): published when made, as Hatti keeps no time
    // of a product's being made active. Null in documents written before.
    created_at: doc.createdAt ?? null,
    published_at: doc.createdAt ?? null,
    updated_at: doc.updatedAt ?? doc.createdAt ?? null,
    // Its published reviews (ADR-401): their stars as Shopify's standard review metafields hold
    // them, which themes and apps read, and the latest of them, Hatti's own.
    // The shop's own (ADR-489), beside those Hatti writes in its own namespaces.
    metafields: {
      ...metafieldsObject(doc.metafields),
      ...reviewMetafields(doc),
      ...easternWearMetafields(doc),
    },
    // The day it ships by while it is on pre-order (ADR-403), YYYY-MM-DD for the date filter;
    // nil when it is not. Hatti's own.
    preorder_ships_on: doc.preorderShipsOn ?? null,
    // Whether it comes stitched, its pieces, fabrics and season (ADR-477), each its value and its
    // words in the page's language; nil where none is said. Hatti's own.
    eastern_wear: easternWearObject(doc),
    // When the sale it is in now ends (ADR-445), ISO 8601 for a countdown; nil when it is in none.
    // Hatti's own.
    sale_ends_at: doc.saleEndsAt ?? null,
    // Its size chart (ADR-407), each measurement in inches and centimetres; nil when it has none.
    // Hatti's own.
    size_chart: sizeChartObject(doc),
    // What its page asks the shopper for when it is made to order (ADR-689), in order, each with
    // the name its answer goes in on the product form, properties[Name]; empty when it asks for
    // nothing. Hatti's own.
    personalisation_fields: (doc.personalisation ?? []).map((field) => ({
      name: field.name,
      type: field.kind,
      required: field.required,
      max_length: field.maxLength ?? null,
      choices: field.choices ?? [],
      // What an answer adds to each unit's price, in minor units for `money` (ADR-697); 0 for none.
      price: field.price ?? 0,
      input_name: `properties[${field.name}]`,
    })),
    // What it holds, where it is a bundle (ADR-411): each part's title, variant, how many one set
    // has, and a link to it while it is for sale; nil for a product that is no bundle. Hatti's own.
    bundle: doc.bundle
      ? {
          components: doc.bundle.components.map((part) => ({
            title: part.title,
            variant_title: part.variantTitle,
            quantity: part.quantity,
            url: part.handle === null ? null : `${prefix}/products/${part.handle}`,
          })),
        }
      : null,
    reviews: (doc.reviews?.latest ?? []).map((review) => ({
      id: review.id,
      author: review.author,
      rating: review.rating,
      content: review.bodyHtml ?? '',
      created_at: review.createdAt,
    })),
  };
}

/** A measurement in a unit, to a tenth: inches from centimetres or the other way. */
function inUnit(value: number | null, from: 'in' | 'cm', to: 'in' | 'cm'): number | null {
  if (value === null) return null;
  if (from === to) return value;
  const converted = from === 'in' ? value * 2.54 : value / 2.54;
  return Math.round(converted * 10) / 10;
}

/**
 * A product's size chart (CAT-10, ADR-407): its name, the unit it was written in, what is
 * measured, and a row for each size with its measurements as written and in both units.
 */
function sizeChartObject(doc: ProductDoc): Record<string, unknown> | null {
  const chart = doc.sizeChart;
  if (!chart) return null;
  return {
    name: chart.name,
    unit: chart.unit,
    columns: chart.columns,
    rows: chart.rows.map((row) => ({
      size: row.size,
      values: row.values,
      inches: row.values.map((value) => inUnit(value, chart.unit, 'in')),
      centimetres: row.values.map((value) => inUnit(value, chart.unit, 'cm')),
    })),
    note: chart.note,
  };
}

/**
 * Shopify's `reviews.rating` and `reviews.rating_count` metafields of a product with published
 * reviews: its average stars of 1 to 5, and how many; none for one without.
 */
function reviewMetafields(doc: ProductDoc): Record<string, Record<string, unknown>> {
  if (!doc.reviews) return {};
  return {
    reviews: {
      rating: {
        type: 'rating',
        value: { rating: doc.reviews.rating, scale_min: 1, scale_max: 5 },
      },
      rating_count: { type: 'number_integer', value: doc.reviews.count },
    },
  };
}

/**
 * A product's eastern-wear attributes for Liquid (ADR-477): each `value` as filters match it and
 * `label` as the page says it, `fabrics` a list, and `summary` all of them in a line: "Unstitched ·
 * 3-piece · Lawn, Chiffon · Summer". Nil where none is said.
 */
function easternWearObject(doc: ProductDoc): Record<string, unknown> | null {
  const wear = doc.easternWear;
  if (!wear) return null;
  const word = (each: AttributeWordDoc | undefined) =>
    each ? { value: each.value, label: each.label } : null;
  const fabrics = wear.fabrics.map((fabric) => word(fabric)!);
  return {
    stitching: word(wear.stitching),
    pieces: wear.pieces ? { value: Number(wear.pieces.value), label: wear.pieces.label } : null,
    fabrics,
    season: word(wear.season),
    summary: [
      wear.stitching?.label,
      wear.pieces?.label,
      fabrics.map((fabric) => fabric.label).join(', '),
      wear.season?.label,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

/**
 * The same attributes as metafields of Hatti's own namespace, as Shopify's themes read a
 * product's: `product.metafields.hatti.fabric.value`, a list of its fabrics' words. None where
 * none is said.
 */
function easternWearMetafields(doc: ProductDoc): Record<string, Record<string, unknown>> {
  const wear = doc.easternWear;
  if (!wear) return {};
  const text = (value: string) => ({ type: 'single_line_text_field', value });
  return {
    hatti: {
      ...(wear.stitching && { stitching: text(wear.stitching.label) }),
      ...(wear.pieces && {
        pieces: { type: 'number_integer', value: Number(wear.pieces.value) },
      }),
      ...(wear.fabrics.length > 0 && {
        fabric: {
          type: 'list.single_line_text_field',
          value: wear.fabrics.map((fabric) => fabric.label),
        },
      }),
      ...(wear.season && { season: text(wear.season.label) }),
    },
  };
}

function variantObject(
  variant: VariantDoc,
  product: ProductDoc,
  images: readonly ImageDrop[],
  prefix: string,
) {
  const image = variant.image === null ? null : (images[variant.image] ?? null);
  return {
    id: variant.id,
    title: variant.title,
    sku: variant.sku,
    price: variant.price,
    compare_at_price: variant.compareAtPrice,
    available: variant.available,
    // How many are left, as Shopify says it, where 5 or fewer are (ADR-445): Hatti says no more,
    // so "only 3 left" is never a guess. Nil otherwise, as for stock Shopify does not count.
    inventory_quantity: variant.left ?? null,
    inventory_management: variant.left === undefined ? null : 'shopify',
    options: variant.options,
    option1: variant.options[0] ?? null,
    option2: variant.options[1] ?? null,
    option3: variant.options[2] ?? null,
    url: `${prefix}/products/${product.handle}?variant=${variant.id}`,
    image,
    featured_image: image,
    metafields: metafieldsObject(variant.metafields),
  };
}

/**
 * A metafield as Liquid reads it (CAT-06, ADR-489): its `type`, its `value` of that type (a
 * number, true or false, a list or an object for JSON, text otherwise), and printed as its value.
 */
export class MetafieldDrop extends Drop {
  readonly type: string;
  readonly value: unknown;
  readonly #kept: string;

  constructor(type: string, kept: string) {
    super();
    this.type = type;
    this.#kept = kept;
    this.value = metafieldValue(type, kept);
  }

  /** What `{{ product.metafields.custom.care }}` prints: its value, or as kept for JSON. */
  override valueOf(): unknown {
    return typeof this.value === 'object' && this.value !== null ? this.#kept : this.value;
  }
}

function metafieldValue(type: string, kept: string): unknown {
  switch (type) {
    case 'number_integer':
    case 'number_decimal':
      return Number(kept);
    case 'boolean':
      return kept === 'true';
    case 'json':
    case 'list.single_line_text_field':
      try {
        return JSON.parse(kept) as unknown;
      } catch {
        return null;
      }
    default:
      return kept;
  }
}

/** An owner's metafields for Liquid, by namespace and key (ADR-489); none where it has none. */
export function metafieldsObject(
  fields: MetafieldsDoc | undefined,
): Record<string, Record<string, MetafieldDrop>> {
  return Object.fromEntries(
    Object.entries(fields ?? {}).map(([namespace, keys]) => [
      namespace,
      Object.fromEntries(
        Object.entries(keys).map(([key, field]) => [
          key,
          new MetafieldDrop(field.type, field.value),
        ]),
      ),
    ]),
  );
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
  listing?: FilteredListing,
): Record<string, unknown> & Paginable {
  let window = { offset: 0, limit: 50 };
  let products: ItemRef[] | null = null;
  // Narrowed by the page's filters (SRC-03, ADR-478), where its page gave them.
  const productIds = listing?.productIds ?? doc.productIds;
  return {
    id: doc.id,
    handle: doc.handle,
    title: doc.title,
    url: `${ctx.prefix ?? ''}/collections/${doc.handle}`,
    description: doc.descriptionHtml,
    image: doc.image ? new ImageDrop(doc.image) : null,
    products_count: productIds.length,
    all_products_count: doc.productIds.length,
    filters: listing?.filters ?? [],
    // Put in the order the page asked for (ADR-479).
    sort_by: listing?.sortBy ?? 'manual',
    default_sort_by: 'manual',
    sort_options: listing?.sortOptions ?? [],
    metafields: metafieldsObject(doc.metafields),
    get products(): ItemRef[] {
      const ids = productIds.slice(window.offset, window.offset + window.limit);
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
  found: SearchFound | null,
  ctx: ObjectContext,
  listing?: FilteredListing,
): Record<string, unknown> & Paginable {
  // Filtered, its products alone: pages and articles have none of their filters (ADR-479).
  const filtered = listing?.filtered ?? false;
  // Products, then pages, then articles, each kind best first (ADR-212).
  const entries = [
    ...(listing?.productIds ?? found?.productIds ?? []).map((id) => `product:${id}`),
    ...(filtered ? [] : (found?.pageIds ?? [])).map((id) => `page:${id}`),
    ...(filtered ? [] : (found?.articleIds ?? [])).map((id) => `article:${id}`),
  ];
  let window = { offset: 0, limit: 50 };
  let results: ItemRef[] | null = null;
  return {
    performed: found !== null && found.terms.trim() !== '',
    terms: found?.terms ?? '',
    results_count: entries.length,
    types: found?.types ?? ['product'],
    filters: listing?.filters ?? [],
    sort_by: listing?.sortBy ?? 'relevance',
    default_sort_by: 'relevance',
    sort_options: listing?.sortOptions ?? [],
    get results(): ItemRef[] {
      return (results ??= lazyResults(
        entries.slice(window.offset, window.offset + window.limit),
        ctx,
      ));
    },
    [PAGINATE](offset: number, limit: number) {
      window = { offset, limit };
      results = null;
    },
  };
}

/** What a search found, each kind by its documents' IDs, best first, and the kinds it looked for. */
export interface SearchFound {
  terms: string;
  productIds: readonly string[];
  pageIds?: readonly string[];
  articleIds?: readonly string[];
  /** As Shopify's `search.types`: product, page and article, those searched. */
  types?: readonly string[];
}

/**
 * Shopify's `predictive_search`, for a predictive search's section (ADR-046): what the shopper
 * has typed so far, the kinds of result asked for, and the products that could be what they
 * want, best first. Hatti finds nothing of the other kinds yet.
 */
export function predictiveSearchObject(
  found: (SearchFound & { types: readonly string[] }) | null,
  ctx: ObjectContext,
): Record<string, unknown> {
  let products: ItemRef[] | null = null;
  let pages: ItemRef[] | null = null;
  let articles: ItemRef[] | null = null;
  return {
    performed: found !== null && found.terms !== '',
    terms: found?.terms ?? '',
    types: found?.types ?? [],
    resources: {
      get products(): ItemRef[] {
        return (products ??= lazyProducts(found?.productIds ?? [], ctx));
      },
      collections: [],
      // The shop's own pages and articles too, as a search finds them (ADR-212).
      get pages(): ItemRef[] {
        return (pages ??= lazyPages(found?.pageIds ?? [], ctx));
      },
      get articles(): ItemRef[] {
        return (articles ??= lazyArticles(found?.articleIds ?? [], ctx));
      },
      queries: [],
    },
  };
}

/**
 * Shopify's `recommendations`, for a product recommendations section (MKT-09, ADR-434): whether
 * they were asked for, of which kind, and the products, the most related first. Empty on any other
 * page, as Shopify's is.
 */
export function recommendationsObject(
  found: { intent: string; productIds: readonly string[] } | null,
  ctx: ObjectContext,
): Record<string, unknown> {
  let products: ItemRef[] | null = null;
  return {
    'performed?': found !== null,
    performed: found !== null,
    intent: found?.intent ?? null,
    products_count: found?.productIds.length ?? 0,
    get products(): ItemRef[] {
      return (products ??= lazyProducts(found?.productIds ?? [], ctx));
    },
  };
}

/**
 * A shop's page (ADR-045), as Shopify's `page`: its content was cleaned when it was saved, so
 * themes print it as it is, as they do Shopify's.
 */
export function pageObject(doc: PageDoc, prefix = ''): Record<string, unknown> {
  return {
    id: doc.id,
    // As search results say what each of them is.
    object_type: 'page',
    handle: doc.handle,
    title: doc.title,
    url: `${prefix}/pages/${doc.handle}`,
    content: doc.bodyHtml,
    published_at: doc.publishedAt,
    template_suffix: doc.templateSuffix,
  };
}

/**
 * A shop's blog (ADR-177), as Shopify's `blog`: its published articles, the latest first, fetched
 * a chunk at a time as a page of them is shown; with `tag`, as at /blogs/{handle}/tagged/{tag},
 * those tagged with it alone, a tag matching as its handle does. On the page of its article
 * `shown`, the articles either side of it too (ADR-209).
 */
export function blogObject(
  doc: BlogDoc,
  ctx: ObjectContext,
  tag: string | null = null,
  shown: string | null = null,
): Record<string, unknown> & Paginable {
  const listed =
    tag === null
      ? doc.articles
      : doc.articles.filter((article) => article.tags.some((each) => handleize(each) === tag));
  let window = { offset: 0, limit: 50 };
  let articles: ItemRef[] | null = null;
  // Shopify's `previous_article` is the newer, `next_article` the older; both are fetched in one
  // round trip when a template first asks for either, and neither elsewhere than on the page.
  const at = shown === null ? -1 : doc.articles.findIndex((article) => article.id === shown);
  const newer = at > 0 ? doc.articles[at - 1]!.id : null;
  const older = at >= 0 ? (doc.articles[at + 1]?.id ?? null) : null;
  const beside = [newer, older].filter((id): id is string => id !== null);
  const besideOf = (id: string | null) =>
    id === null
      ? null
      : ctx.data.articles(beside).then((docs) => {
          const found = docs[beside.indexOf(id)];
          return found ? besideObject(found, ctx.prefix) : null;
        });
  return {
    id: doc.id,
    handle: doc.handle,
    title: doc.title,
    url: `${ctx.prefix ?? ''}/blogs/${doc.handle}`,
    template_suffix: doc.templateSuffix,
    // Whether its articles take comments, and whether the shop approves each first (ADR-220).
    'comments_enabled?': (doc.commentPolicy ?? 'closed') !== 'closed',
    'moderated?': doc.commentPolicy === 'moderated',
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
    get previous_article() {
      return besideOf(newer);
    },
    get next_article() {
      return besideOf(older);
    },
    [PAGINATE](offset: number, limit: number) {
      window = { offset, limit };
      articles = null;
    },
  };
}

/**
 * An article beside the one shown, as Shopify's `article`. Printed, it is its address: Shopify
 * gave the address alone before it gave the article, and themes written then print it.
 */
function besideObject(doc: ArticleDoc, prefix?: string): Record<string, unknown> {
  const article = articleObject(doc, prefix);
  return { ...article, toString: () => String(article.url) };
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
 * cleaned when they were saved, so themes print them as they are; its image, if it has one
 * (ADR-213); and its comments the storefront shows, a page of them at a time, with where its
 * form posts a new one (ADR-220).
 */
export function articleObject(doc: ArticleDoc, prefix = ''): Record<string, unknown> & Paginable {
  const url = `${prefix}/blogs/${doc.blogHandle}/${doc.handle}`;
  const comments = (doc.comments ?? []).map((comment) => ({
    id: comment.id,
    author: comment.author,
    // Escaped as text when it was published: printed as it is.
    content: comment.bodyHtml,
    created_at: comment.createdAt,
    status: 'published',
    url: `${url}#comment-${comment.id}`,
  }));
  let window = { offset: 0, limit: 50 };
  return {
    id: doc.id,
    // As search results say what each of them is.
    object_type: 'article',
    handle: doc.handle,
    title: doc.title,
    url,
    content: doc.bodyHtml,
    excerpt: doc.summaryHtml,
    excerpt_or_content: doc.summaryHtml || doc.bodyHtml,
    author: doc.author,
    published_at: doc.publishedAt,
    created_at: doc.publishedAt,
    updated_at: doc.updatedAt ?? doc.publishedAt,
    tags: doc.tags,
    template_suffix: doc.templateSuffix,
    // One of the shop's files where the API serves it (ADR-213); null for none.
    image: doc.image ? new ImageDrop(doc.image) : null,
    get comments() {
      return comments.slice(window.offset, window.offset + window.limit);
    },
    comments_count: doc.commentsCount ?? 0,
    'comments_enabled?': (doc.commentPolicy ?? 'closed') !== 'closed',
    'moderated?': doc.commentPolicy === 'moderated',
    comment_post_url: `${url}/comments`,
    [PAGINATE](offset: number, limit: number) {
      window = { offset, limit };
    },
  };
}

/** A menu, as Liquid's `linklist`: its links, with the links under each, three levels at most. */
export function menuObject(doc: MenuDoc, prefix = ''): Record<string, unknown> {
  const links = linkObjects(doc.links, 1, prefix);
  return { handle: doc.handle, title: doc.title, links, levels: levelsOf(links) };
}

/** Links a theme may print as they are: one whose address could end an attribute is left out. */
function linkObjects(
  links: readonly MenuLinkDoc[] | undefined,
  level: number,
  prefix: string,
): Record<string, unknown>[] {
  if (!links || level > 3) return [];
  return links
    .filter((link) => typeof link.url === 'string' && isSafeLink(link.url))
    .map((link) => {
      const children = linkObjects(link.links, level + 1, prefix);
      return {
        title: link.title,
        // The shop's own pages in the page's language (ADR-624); others as they are.
        url: localizedPath(link.url, prefix),
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
 * `free_above`. Documents from before shops set charges have none: delivery is free. How many
 * working days it takes (ADR-235): `min_days` to `max_days` wherever it goes, the fewest
 * anywhere to the most, nil unless the shop said how long it takes everywhere; and each zone's,
 * its own or everywhere's; and everywhere's own, outside the zones (OS-11, ADR-454). And what
 * heavier orders cost more (ADR-704): `weights`, the lightest first, each `above_grams`, the same
 * in `above_kg`, and its `charge`.
 */
export function deliveryObject(doc: ShopDoc): Record<string, unknown> {
  const delivery = doc.delivery ?? { charge: 0, freeAbove: null, zones: [] };
  const everywhere = delivery.days ?? null;
  const zones = delivery.zones.map((zone) => {
    const days = zone.days ?? everywhere;
    return {
      name: zone.name,
      cities: zone.cities,
      charge: zone.charge,
      min_days: days?.min ?? null,
      max_days: days?.max ?? null,
    };
  });
  const range = everywhere && {
    min: Math.min(everywhere.min, ...zones.map((zone) => zone.min_days ?? everywhere.min)),
    max: Math.max(everywhere.max, ...zones.map((zone) => zone.max_days ?? everywhere.max)),
  };
  return {
    charge: delivery.charge,
    free_above: delivery.freeAbove,
    min_days: range?.min ?? null,
    max_days: range?.max ?? null,
    everywhere_min_days: everywhere?.min ?? null,
    everywhere_max_days: everywhere?.max ?? null,
    zones,
    weights: (delivery.weights ?? []).map((weight) => ({
      above_grams: weight.aboveGrams,
      above_kg: weight.aboveGrams / 1000,
      charge: weight.charge,
    })),
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
  /** When the page is made, for what the shop paused. */
  now: Date = new Date(),
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
    // Its home page's description for search engines (ADR-243), as Shopify's; nil without one.
    description: doc.seo?.description ?? null,
    // What the password page tells shoppers while the shop is closed (ADR-054), as safe HTML.
    password_message: doc.password?.message ?? '',
    // Whether the shop tells shoppers when a sold-out variant is back (ADR-429), for its form.
    back_in_stock: doc.backInStock === true,
    // What Hatti verified of the shop (ADR-465), Hatti's own: "identity", "business", or nil.
    verified: doc.verified ?? null,
    // Orders paused, its storefront open to browse (ADR-603, ADR-620), Hatti's own: the shop's
    // message as typed, and when orders come back, nil for no time set; nil while it takes them.
    checkout_paused: checkoutPausedAt(doc.maintenance, now)
      ? { message: doc.maintenance!.message, until: doc.maintenance!.until }
      : null,
    // Its return window (ADR-468), Hatti's own: days, 0 for none, and exchanges alone; or nil.
    returns: doc.returns
      ? { days: doc.returns.days, exchanges_only: doc.returns.exchangesOnly }
      : null,
    brand: brandObject(doc),
    ...policiesObject(doc, language),
  };
}

/**
 * The shop's brand as Liquid gives it, Shopify's `shop.brand` (ADR-207): its logo and square
 * logo as images, from where the API serves them (ADR-205), nil for those it has none of; the
 * brand's colours, cover image and words Hatti does not keep yet, nil.
 */
function brandObject(doc: ShopDoc): Record<string, unknown> {
  const image = (src: string | null | undefined) =>
    src ? new ImageDrop({ src, width: 0, height: 0, alt: null }) : null;
  return {
    logo: image(doc.brand?.logo),
    square_logo: image(doc.brand?.squareLogo),
    cover_image: null,
    colors: null,
    slogan: null,
    short_description: null,
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
    (await ctx.data.articles(chunk)).map((doc) => doc && articleObject(doc, ctx.prefix)),
  ).refs();
}

/** Pages in a list, likewise (ADR-212). */
function lazyPages(ids: readonly string[], ctx: ObjectContext): ItemRef[] {
  return new LazyList(ids, ctx.chunkSize, async (chunk) =>
    (await ctx.data.pages(chunk)).map((doc) => doc && pageObject(doc, ctx.prefix)),
  ).refs();
}

/**
 * A search's results of every kind, each "kind:id", fetched a chunk at a time: a chunk's products,
 * pages and articles each in one round trip, all at once (ADR-212).
 */
function lazyResults(entries: readonly string[], ctx: ObjectContext): ItemRef[] {
  return new LazyList(entries, ctx.chunkSize, async (chunk) => {
    const of = (kind: string) =>
      chunk
        .filter((entry) => entry.startsWith(`${kind}:`))
        .map((entry) => entry.slice(kind.length + 1));
    const [products, pages, articles] = await Promise.all([
      ctx.data.products(of('product')),
      ctx.data.pages(of('page')),
      ctx.data.articles(of('article')),
    ]);
    const found = new Map<string, Record<string, unknown> | null>([
      ...of('product').map((id, index) => {
        const doc = products[index];
        return [`product:${id}`, doc ? productObject(doc, ctx) : null] as const;
      }),
      ...of('page').map((id, index) => {
        const doc = pages[index];
        return [`page:${id}`, doc ? pageObject(doc, ctx.prefix) : null] as const;
      }),
      ...of('article').map((id, index) => {
        const doc = articles[index];
        return [`article:${id}`, doc ? articleObject(doc, ctx.prefix) : null] as const;
      }),
    ]);
    return chunk.map((entry) => found.get(entry) ?? null);
  }).refs();
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
      return doc ? menuObject(doc, ctx.prefix) : null;
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
        settings[id] =
          named && ctx.data.menu(named).then((doc) => doc && menuObject(doc, ctx.prefix));
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
        settings[id] = imageSetting(value, ctx.pictures);
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
  return ctx.data.page(handle).then((doc) => doc && pageObject(doc, ctx.prefix));
}

function productPromise(handle: string, ctx: ObjectContext) {
  return ctx.data.productByHandle(handle).then((doc) => doc && productObject(doc, ctx));
}

function blogPromise(handle: string, ctx: ObjectContext) {
  return ctx.data.blog(handle).then((doc) => doc && blogObject(doc, ctx));
}

function articlePromise(handle: string, ctx: ObjectContext) {
  return ctx.data.article(handle).then((doc) => doc && articleObject(doc, ctx.prefix));
}

/** Text as a handle, as Shopify's `handleize` makes one: "Eid Edit" gives eid-edit. */
export function handleize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * An image setting: its address, or the image with its size, as the media library keeps it. One
 * of the shop's pictures carries what its file holds (ADR-670), so a file replaced is fetched
 * afresh, by browsers and the edge alike.
 */
function imageSetting(
  value: unknown,
  pictures: Readonly<Record<string, string>> = {},
): ImageDrop | null {
  const image = imageValue(value);
  if (!image) return null;
  const file = THEME_PICTURE.exec(image.src)?.[1];
  const version = file === undefined ? undefined : pictures[file];
  return new ImageDrop(
    version === undefined ? image : { ...image, src: `${image.src}?v=${version}` },
  );
}

/** A field of a plain object; nothing it inherits. */
function field(object: Record<string, unknown> | null, key: string | number): unknown {
  return object && Object.hasOwn(object, key) ? object[key] : undefined;
}

/** A picture of the shop's at its theme's address (ADR-326), without a query: its file's ID. */
const THEME_PICTURE = /^\/theme-images\/(file_[0-9a-hjkmnp-tv-z]{26})(?:\/[^?#]*)?$/;

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
  // The shop's automatic discounts first, then the code (ADR-515).
  const applications = [
    ...(cart?.automaticDiscounts ?? []).flatMap(automaticApplication),
    ...discountApplications(discount),
  ];
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

/**
 * An automatic discount the cart takes as Liquid's `discount_application` of type "automatic"
 * (ADR-515), titled as the shop titles it: across the items, or aimed at delivery.
 */
function automaticApplication(
  automatic: CartAutomaticDiscountJson,
): { target_type: string; [field: string]: unknown }[] {
  const common = { type: 'automatic', title: automatic.title, target_selection: 'all' };
  if (automatic.kind === 'free_shipping') {
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
  if (automatic.amount <= 0) return [];
  return [
    {
      ...common,
      value: automatic.value,
      value_type: automatic.kind === 'percentage' ? 'percentage' : 'fixed_amount',
      allocation_method: 'across',
      target_type: 'line_item',
      total_allocated_amount: automatic.amount,
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
    url: doc ? `${ctx.prefix ?? ''}/products/${doc.handle}?variant=${item.variantId}` : null,
    url_to_remove: `${changeUrl}?id=${encodeURIComponent(item.key)}&quantity=0`,
    image: variant?.image ?? product?.featured_image ?? null,
    options_with_values: (doc?.options ?? []).map((option, index) => ({
      name: option.name,
      value: at >= 0 ? (doc!.variants[at]!.options[index] ?? '') : '',
    })),
    requires_shipping: true,
    gift_card: doc?.giftCard === true,
    taxable: item.taxable,
    grams: item.grams,
    /** Hatti's: the most the line can have now, when fewer than its quantity; else nil. */
    max_quantity: item.maxQuantity,
  };
}
