import { formatMoney, money } from '@hatti/money';
import {
  Drop,
  Hash,
  IncludeTag,
  Liquid,
  RenderTag,
  Tag,
  Tokenizer,
  TypeGuards,
  evalToken,
  type Context,
  type Emitter,
  type FS,
  type FilterImplOptions,
  type Parser,
  type TagToken,
  type Template,
  type TopLevelToken,
  type ValueToken,
} from 'liquidjs';
import type { WorkLimiter } from './limits.js';
import {
  ExternalVideoDrop,
  ImageDrop,
  PAGINATE,
  VideoDrop,
  handleize,
  type Paginable,
} from './objects.js';
import type { Theme, ThemeFiles } from '@hatti/themes';

/**
 * What filters and tags need from the page they render: its language, and how to render the
 * sections a layout names. Kept in the render's globals under a symbol, which no template can
 * name.
 */
export interface PageState {
  theme: Theme;
  locale: string;
  /** The shop's time zone, as its document says, which dates print in (ADR-211). */
  timezone: string;
  renderSection(name: string): PromiseLike<string>;
  renderGroup(name: string): PromiseLike<string>;
  /** The page asked for, from 1, for `{% paginate %}`. */
  page: number;
  /** The request's query, which `{% paginate %}`'s links keep, but for its page. */
  query: Readonly<Record<string, string>>;
  /** What a form posted to the page got wrong, by the form's type, as `form.errors` gives it. */
  formErrors: Readonly<Record<string, readonly string[]>>;
}

export const PAGE = Symbol('page');

/** The theme's `{% render %}`s come from snippets/, layouts from layout/. */
export function createEngine(theme: Theme): Liquid {
  const liquid = new Liquid({
    fs: themeFs(theme.files),
    root: ['snippets'],
    partials: ['snippets'],
    layouts: ['layout'],
    extname: '.liquid',
    cache: true,
    // Templates reach only what the renderer gives them: no prototypes, no files.
    ownPropertyOnly: true,
    // A filter the theme misspells fails when it is published, not when a customer visits.
    strictFilters: true,
    // Dates print in the shop's time zone (ADR-211); outside a page's render, Pakistan's.
    timezoneOffset: DEFAULT_TIMEZONE,
  });
  for (const [name, filter] of Object.entries(filters(theme))) liquid.registerFilter(name, filter);
  registerDateFilters(liquid, theme);
  for (const name of ['schema', 'stylesheet', 'javascript']) {
    liquid.registerTag(name, skippedBlock(name));
  }
  liquid.registerTag('render', NestedRenderTag);
  liquid.registerTag('include', NestedIncludeTag);
  liquid.registerTag('style', StyleTag);
  liquid.registerTag('section', sectionTag('section'));
  liquid.registerTag('sections', sectionTag('sections'));
  liquid.registerTag('form', FormTag);
  liquid.registerTag('paginate', PaginateTag);
  return liquid;
}

/** Where Hatti's shops are, for a shop whose document names no time zone. */
export const DEFAULT_TIMEZONE = 'Asia/Karachi';

/**
 * Shopify's own date formats, which `date` and `time_tag` take by name (`format: 'date'`) when
 * the theme's locale has none of its own by that name under `date_formats`.
 */
export const DATE_FORMATS: Readonly<Record<string, string>> = {
  abbreviated_date: '%b %-d, %Y',
  basic: '%m/%d/%Y',
  date: '%B %-d, %Y',
  date_at_time: '%B %-d, %Y at %-l:%M %P',
  default: '%A, %B %-d, %Y at %-l:%M %P %z',
  on_date: 'on %B %-d, %Y',
};

/** LiquidJS's date filters, which read their time zone and language from the engine's options. */
const DATE_FILTERS = [
  'date',
  'date_to_xmlschema',
  'date_to_rfc822',
  'date_to_string',
  'date_to_long_string',
] as const;

type DateFilter = (this: { context: Context }, value: unknown, ...args: unknown[]) => unknown;

/**
 * Dates in the shop's time zone and the page's language (ADR-211): LiquidJS's date filters, each
 * given its page's in place of the engine's; `date` taking Shopify's formats by name too; and
 * Shopify's `time_tag`.
 */
function registerDateFilters(liquid: Liquid, theme: Theme): void {
  const builtin = (name: string) => liquid.filters[name] as unknown as DateFilter;
  const date = builtin('date');
  for (const name of DATE_FILTERS) {
    const filter = builtin(name);
    liquid.registerFilter(name, function (this: { context: Context }, value, ...args) {
      const format = name === 'date' ? named(args).format : undefined;
      if (typeof format === 'string') {
        return date.call(zoned(this), value, dateFormat(theme, this.context, format));
      }
      return filter.call(zoned(this), value, ...args);
    });
  }
  /**
   * Shopify's: a date as `<time>`: printed in a format of strftime's, or one of the theme's or
   * Shopify's by name (`format: 'date'`), else Shopify's default; its `datetime` in UTC, or in the
   * format `datetime:` gives. Nothing for no date.
   */
  liquid.registerFilter('time_tag', function (this: { context: Context }, value, ...args) {
    if (!isDate(value)) return '';
    const options = named(args);
    const given = args.find((arg) => typeof arg === 'string');
    const format =
      typeof options.format === 'string'
        ? dateFormat(theme, this.context, options.format)
        : typeof given === 'string'
          ? given
          : dateFormat(theme, this.context, 'default');
    const datetime =
      typeof options.datetime === 'string'
        ? date.call(zoned(this), value, options.datetime)
        : date.call(zoned(this, 'UTC'), value, '%Y-%m-%dT%H:%M:%SZ');
    const shown = date.call(zoned(this), value, format);
    return `<time datetime="${attribute(datetime)}">${escapeHtml(String(shown))}</time>`;
  });
}

/** A format by name: the theme's own in the page's language, else Shopify's, else its default. */
function dateFormat(theme: Theme, context: Context, name: string): string {
  const locale = (context.globals as { [PAGE]?: PageState })[PAGE]?.locale ?? theme.defaultLocale;
  return (
    translation(theme, locale, `date_formats.${name}`, {}) ??
    DATE_FORMATS[name] ??
    DATE_FORMATS.default!
  );
}

/** Whether LiquidJS reads `value` as a date: a Date, seconds, "now", or a date as text. */
function isDate(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string' || value.trim() === '') return false;
  return /^(now|today|\d+)$/.test(value) || !Number.isNaN(Date.parse(value));
}

/**
 * A filter's `this` with its context's options in the page's time zone, or `timezone`, and its
 * language: a page's render is one of many the engine runs at once, so its options stay shared.
 */
function zoned(filter: { context: Context }, timezone?: string): { context: Context } {
  const state = (filter.context.globals as { [PAGE]?: PageState })[PAGE];
  if (!state && !timezone) return filter;
  const opts = {
    ...filter.context.opts,
    timezoneOffset: timezone ?? state!.timezone,
    locale: dateLocale(state?.locale),
  };
  const context = Object.create(filter.context, { opts: { value: opts } }) as Context;
  return Object.assign(Object.create(filter) as object, { context });
}

/** The language month and day names are in: the page's, where Intl knows it; else English. */
function dateLocale(locale: string | undefined): string {
  if (!locale) return 'en';
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0 ? locale : 'en';
  } catch {
    return 'en';
  }
}

/** A tag's class, as LiquidJS registers it. */
type TagClass = new (
  token: TagToken,
  remainTokens: TopLevelToken[],
  liquid: Liquid,
  parser: Parser,
) => Tag;

/** The page a render belongs to. */
export function pageState(ctx: Context): PageState {
  return (ctx.globals as { [PAGE]: PageState })[PAGE];
}

/** A theme's files, and nothing else, as LiquidJS's file system. */
function themeFs(files: ThemeFiles): FS {
  const read = (path: string) => {
    const source = files[path];
    if (source === undefined) throw new Error(`The theme has no ${path}`);
    return source;
  };
  const inside = (root: string, path: string) =>
    path.startsWith(`${root}/`) && !path.split('/').includes('..');
  return {
    exists: (path) => Promise.resolve(files[path] !== undefined),
    existsSync: (path) => files[path] !== undefined,
    readFile: (path) => Promise.resolve(read(path)),
    readFileSync: read,
    resolve: (dir, file, ext) => `${dir}/${file.endsWith(ext) ? file : file + ext}`,
    dirname: (path) => path.split('/').slice(0, -1).join('/'),
    contains: (root, path) => Promise.resolve(inside(root, path)),
    containsSync: inside,
    sep: '/',
  };
}

// Filters: Shopify's that themes use most, and Hatti's own (04 §3.2).

function filters(theme: Theme): Record<string, FilterImplOptions> {
  const rupees = (value: unknown, grouping: 'international' | 'south-asian' = 'international') =>
    formatMoney(money(BigInt(Math.round(Number(value) || 0)), 'PKR'), { grouping });
  return {
    money: (value: unknown) => rupees(value),
    money_with_currency: (value: unknown) => `${rupees(value)} PKR`,
    money_without_trailing_zeros: (value: unknown) => rupees(value),
    money_without_currency: (value: unknown) =>
      formatMoney(money(BigInt(Math.round(Number(value) || 0)), 'PKR'), { display: 'none' }),
    /** Hatti's: lakh and crore grouping, "Rs 1,25,000". */
    money_pk: (value: unknown) => rupees(value, 'south-asian'),

    image_url: (image: unknown, ...args: unknown[]) => imageUrl(image, named(args)),
    image_tag: (url: unknown, ...args: unknown[]) => imageTag(url, named(args)),
    video_tag: (video: unknown, ...args: unknown[]) => videoTag(video, named(args)),
    external_video_url: (video: unknown, ...args: unknown[]) =>
      externalVideoUrl(video, named(args)),
    external_video_tag: (video: unknown, ...args: unknown[]) =>
      externalVideoTag(video, named(args)),
    media_tag: (media: unknown, ...args: unknown[]) => mediaTag(media, named(args)),

    t: function (this: { context: Context }, key: unknown, ...args: unknown[]) {
      return translate(theme, pageState(this.context).locale, String(key), named(args));
    },

    asset_url: (file: unknown) => `/assets/${theme.version}/${String(file)}`,
    stylesheet_tag: (url: unknown) =>
      `<link rel="stylesheet" href="${attribute(url)}" media="all">`,
    script_tag: (url: unknown) => `<script src="${attribute(url)}" defer></script>`,
    handleize: (text: unknown) => handleize(String(text ?? '')),
    handle: (text: unknown) => handleize(String(text ?? '')),
    link_to: (text: unknown, url: unknown) =>
      `<a href="${attribute(url)}">${escapeHtml(String(text ?? ''))}</a>`,

    /** Hatti's: an "Order on WhatsApp" link to the shop's number, with a message. */
    whatsapp_url: (number: unknown, message: unknown) => {
      const digits = String(number ?? '').replace(/\D/g, '');
      // A message is text, often a theme string, which `t` escaped for the page.
      const text = message ? `?text=${encodeURIComponent(unescapeHtml(String(message)))}` : '';
      return `https://wa.me/${digits}${text}`;
    },
    default_pagination: (paginate: unknown) => pagination(paginate),

    /** JSON for a script element: what shops wrote cannot end the element (`</script>`). */
    json: (value: unknown, space?: unknown) => scriptJson(value, Number(space) || 0),
    /**
     * Shopify's: a product or an article as schema.org's JSON-LD, for search engines, its
     * addresses absolute at the shop's; and Hatti's, the shop itself as its Organization and
     * WebSite (ADR-237). For a script element; nothing for anything else.
     */
    structured_data: function (this: { context: Context }, value: unknown) {
      const shop = (this.context.globals as { shop?: Record<string, unknown> }).shop;
      const origin = String(shop?.url ?? '');
      const data =
        productData(value, origin) ??
        articleData(value, origin, shop) ??
        (shop && value === shop ? shopData(shop, origin) : null);
      return data ? scriptJson(data) : '';
    },
  };
}

/** Characters JSON may hold that could end or confuse an HTML script element. */
const SCRIPT_UNSAFE = /[<>&]/g;

/** JSON safe inside `<script>`: `<`, `>` and `&` as JSON's own escapes, which parse the same. */
export function scriptJson(value: unknown, space = 0): string {
  return (JSON.stringify(value ?? null, null, space) ?? 'null').replace(
    SCRIPT_UNSAFE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** A product object as schema.org's Product, with an offer per variant; null for anything else. */
function productData(value: unknown, origin: string): Record<string, unknown> | null {
  const product = value as Record<string, unknown> | null;
  if (!product || product.object_type !== 'product') return null;
  const images = (product.images as ImageDrop[] | undefined) ?? [];
  const variants = (product.variants as Record<string, unknown>[] | undefined) ?? [];
  const text = unescapeHtml(String(product.description ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    url: `${origin}${String(product.url)}`,
    ...(text && { description: text }),
    ...(images.length > 0 && {
      image: images.map((image) => imageAddress(image.src, origin, 1200)),
    }),
    ...(product.vendor ? { brand: { '@type': 'Brand', name: product.vendor } } : {}),
    offers: variants.map((variant) => ({
      '@type': 'Offer',
      url: `${origin}${String(variant.url)}`,
      ...(variant.sku ? { sku: variant.sku } : {}),
      ...(product.has_only_default_variant ? {} : { name: variant.title }),
      price: (Number(variant.price) / 100).toFixed(2),
      priceCurrency: 'PKR',
      availability: variant.available
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
    })),
  };
}

/**
 * An article object as schema.org's BlogPosting (ADR-237), with what Google reads of one: its
 * headline, address, dates, image, and its author, else the shop, with the shop as its publisher;
 * null for anything else.
 */
function articleData(
  value: unknown,
  origin: string,
  shop: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const article = value as Record<string, unknown> | null;
  if (!article || article.object_type !== 'article') return null;
  const image = article.image as ImageDrop | null | undefined;
  const publisher = shop ? organizationData(shop, origin) : null;
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: article.title,
    url: `${origin}${String(article.url)}`,
    datePublished: article.published_at,
    dateModified: article.updated_at ?? article.published_at,
    ...(image && { image: [imageAddress(image.src, origin, 1200)] }),
    ...(article.author
      ? { author: { '@type': 'Person', name: article.author } }
      : publisher && { author: publisher }),
    ...(publisher && { publisher }),
  };
}

/**
 * The shop as schema.org's Organization and WebSite (ADR-237), for its home page: its name,
 * address and logo, and the site's name, which Google shows beside its results.
 */
function shopData(shop: Record<string, unknown>, origin: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      organizationData(shop, origin),
      {
        '@type': 'WebSite',
        name: shop.name,
        ...(origin && { url: `${origin}/` }),
        // Its home page's description for search engines, where it gave one (ADR-243).
        ...(typeof shop.description === 'string' && { description: shop.description }),
      },
    ],
  };
}

/** The shop as schema.org's Organization: its name, address, and logo, else its square logo. */
function organizationData(shop: Record<string, unknown>, origin: string): Record<string, unknown> {
  const brand = shop.brand as { logo?: ImageDrop | null; square_logo?: ImageDrop | null } | null;
  const logo = brand?.logo ?? brand?.square_logo ?? null;
  return {
    '@type': 'Organization',
    name: shop.name,
    ...(origin && { url: `${origin}/` }),
    ...(logo && { logo: imageAddress(logo.src, origin, 600) }),
  };
}

/** Filter arguments given by name (`width: 600`), which LiquidJS passes as pairs. */
function named(args: readonly unknown[]): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const arg of args) {
    if (Array.isArray(arg) && arg.length === 2 && typeof arg[0] === 'string') {
      options[arg[0]] = arg[1];
    }
  }
  return options;
}

/** An image's address at a size, as `image_url` returns it; `image_tag` makes it an `<img>`. */
class ImageUrl extends Drop {
  constructor(
    readonly image: ImageDrop,
    readonly width: number | null,
  ) {
    super();
  }

  override valueOf(): string {
    return sized(this.image.src, this.width);
  }
}

function imageUrl(image: unknown, options: Record<string, unknown>): ImageUrl | null {
  if (!(image instanceof ImageDrop)) return null;
  const width = Number(options.width) || null;
  return new ImageUrl(image, width);
}

/** At `width`, after any query an image's address by URL has, as a CDN's version. */
export function sized(src: string, width: number | null): string {
  if (!width) return src;
  return `${src}${src.includes('?') ? '&' : '?'}width=${width}`;
}

/**
 * An image's address at a width, whole: images by URL are at their own address, and those the
 * image service keeps at a path on the shop's `origin`.
 */
export function imageAddress(src: string, origin: string, width: number | null): string {
  const address = sized(src, width);
  return /^https?:\/\//.test(address) ? address : `${origin}${address}`;
}

/**
 * An `<img>` with its size, so the page does not shift as it loads, and a srcset of the widths
 * the image has, so phones fetch small ones; its focal point kept in sight as CSS fills a frame
 * with it, where the shop set one (ADR-257), as Shopify's does.
 */
function imageTag(url: unknown, options: Record<string, unknown>): string {
  if (!(url instanceof ImageUrl)) return '';
  const { image } = url;
  const focalPoint = ImageDrop.focalPointOf(image);
  const widest = url.width ?? image.width;
  const widths = String(options.widths ?? '165, 360, 533, 720, 940, 1066')
    .split(',')
    .map((width) => Number(width.trim()))
    .filter((width) => width > 0 && (image.width === 0 || width <= image.width));
  const attributes: Record<string, unknown> = {
    src: sized(image.src, url.width),
    srcset: widths.map((width) => `${sized(image.src, width)} ${width}w`).join(', ') || null,
    sizes: options.sizes ?? null,
    alt: options.alt ?? image.alt ?? '',
    width: image.width > 0 ? Math.min(widest, image.width) : null,
    height: image.width > 0 ? Math.round(Math.min(widest, image.width) / image.aspect_ratio) : null,
    loading: options.loading ?? null,
    fetchpriority: options.fetchpriority ?? null,
    class: options.class ?? null,
    style: options.style ?? (focalPoint && `object-position:${focalPoint.valueOf()}`),
  };
  const markup = Object.entries(attributes)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => `${name}="${attribute(value)}"`)
    .join(' ');
  return `<img ${markup}>`;
}

/**
 * A `<video>` for a video the shop uploaded (ADR-258), as Shopify's video_tag: its preview image
 * the poster, at `image_size`'s width; with controls, playing in its place on phones; loading no
 * more than its length until played, as shoppers pay for their data.
 */
function videoTag(video: unknown, options: Record<string, unknown>): string {
  if (!(video instanceof VideoDrop)) return '';
  const poster = sized(video.preview_image.src, widthOf(options.image_size));
  const attributes: Record<string, unknown> = {
    playsinline: 'playsinline',
    controls: options.controls === false ? null : 'controls',
    autoplay: options.autoplay ? 'autoplay' : null,
    loop: options.loop ? 'loop' : null,
    // Phones play a video by itself only without its sound.
    muted: options.muted || options.autoplay ? 'muted' : null,
    preload: 'metadata',
    poster,
    'aria-label': options.alt ?? video.alt ?? null,
    class: options.class ?? null,
  };
  const sources = video.sources
    .map(
      (source) => `<source src="${attribute(source.url)}" type="${attribute(source.mime_type)}">`,
    )
    .join('');
  const fallback = `<img src="${attribute(poster)}" alt="${attribute(video.alt ?? '')}">`;
  return `<video ${markupOf(attributes)}>${sources}${fallback}</video>`;
}

/**
 * Where a YouTube or Vimeo video plays in a page (ADR-258), as Shopify's external_video_url: its
 * host's player, YouTube's inline and without others' videos after it, and the parameters named.
 */
function externalVideoUrl(video: unknown, options: Record<string, unknown>): string {
  if (!(video instanceof ExternalVideoDrop)) return '';
  const id = encodeURIComponent(video.external_id);
  const base =
    video.host === 'youtube'
      ? `https://www.youtube.com/embed/${id}`
      : `https://player.vimeo.com/video/${id}`;
  const params = new URLSearchParams(
    video.host === 'youtube' ? { enablejsapi: '1', playsinline: '1', rel: '0' } : {},
  );
  for (const [name, value] of Object.entries(options)) {
    params.set(name, value === true ? '1' : value === false ? '0' : String(value));
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * An `<iframe>` playing a YouTube or Vimeo video, from the video or the URL external_video_url
 * gave, as Shopify's external_video_tag: loaded as the page scrolls to it.
 */
function externalVideoTag(video: unknown, options: Record<string, unknown>): string {
  const src =
    video instanceof ExternalVideoDrop
      ? externalVideoUrl(video, {})
      : typeof video === 'string' &&
          /^https:\/\/(?:www\.youtube\.com\/embed|player\.vimeo\.com\/video)\//.test(video)
        ? video
        : null;
  if (!src) return '';
  const attributes: Record<string, unknown> = {
    src,
    title: options.title ?? (video instanceof ExternalVideoDrop ? video.alt : null) ?? '',
    class: options.class ?? null,
    loading: options.loading ?? 'lazy',
    frameborder: '0',
    allow: 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture',
    allowfullscreen: 'allowfullscreen',
  };
  return `<iframe ${markupOf(attributes)}></iframe>`;
}

/** The tag a product's media shows as, by its kind, as Shopify's media_tag. */
function mediaTag(media: unknown, options: Record<string, unknown>): string {
  if (media instanceof VideoDrop) return videoTag(media, options);
  if (media instanceof ExternalVideoDrop) return externalVideoTag(media, options);
  if (media instanceof ImageDrop) {
    return imageTag(new ImageUrl(media, widthOf(options.image_size ?? options.width)), options);
  }
  return '';
}

/** "1100x", "1100x1100" or 1100: 1100; null for none. */
function widthOf(size: unknown): number | null {
  return Number.parseInt(String(size ?? ''), 10) || null;
}

/** Attributes as markup, those with no value left out. */
function markupOf(attributes: Record<string, unknown>): string {
  return Object.entries(attributes)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => `${name}="${attribute(value)}"`)
    .join(' ');
}

/**
 * A theme string in the page's language, else the theme's default one, else the key, as HTML:
 * `count` picks `one` or `other`; `{{ name }}` is filled from the arguments. As on Shopify, a
 * string is text, escaped, unless its key ends in `_html`, and what fills it is escaped either
 * way: a product's title, or what a shopper typed.
 */
function translate(
  theme: Theme,
  locale: string,
  key: string,
  values: Record<string, unknown>,
): string {
  if (!key.endsWith('_html')) return escapeHtml(translation(theme, locale, key, values) ?? key);
  const escaped = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, escapeHtml(String(value ?? ''))]),
  );
  return translation(theme, locale, key, escaped) ?? escapeHtml(key);
}

/** A theme string in the page's language, else the theme's default one; null if it has none. */
export function translation(
  theme: Theme,
  locale: string,
  key: string,
  values: Record<string, unknown>,
): string | null {
  const find = (code: string) =>
    key
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          typeof node === 'object' && node !== null && Object.hasOwn(node, part)
            ? (node as Record<string, unknown>)[part]
            : undefined,
        theme.locales.get(code),
      );
  let text = find(locale) ?? find(theme.defaultLocale);
  if (typeof text === 'object' && text !== null && 'other' in text) {
    const forms = text as Record<string, unknown>;
    text = Number(values.count) === 1 && 'one' in forms ? forms.one : forms.other;
  }
  if (typeof text !== 'string') return null;
  return text.replace(/{{\s*(\w+)\s*}}/g, (_, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : '',
  );
}

interface PaginatePart {
  title: string;
  url: string;
  is_link: boolean;
}

function pagination(paginate: unknown): string {
  if (typeof paginate !== 'object' || paginate === null) return '';
  const { pages, parts, previous, next } = paginate as {
    pages: number;
    parts?: PaginatePart[];
    previous: PaginatePart | null;
    next: PaginatePart | null;
  };
  if (pages <= 1 || !parts) return '';
  const link = (url: string, text: string) => `<a href="${attribute(url)}">${text}</a>`;
  const html: string[] = [];
  if (previous) html.push(`<span class="prev">${link(previous.url, '&larr;')}</span>`);
  for (const part of parts) {
    html.push(
      part.is_link
        ? `<span class="page">${link(part.url, escapeHtml(part.title))}</span>`
        : `<span class="page current" aria-current="page">${escapeHtml(part.title)}</span>`,
    );
  }
  if (next) html.push(`<span class="next">${link(next.url, '&rarr;')}</span>`);
  return html.join(' ');
}

function attribute(value: unknown): string {
  return escapeHtml(String(value ?? ''));
}

/** What {@link escapeHtml} escaped, as text again. */
export function unescapeHtml(html: string): string {
  return html.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_, name: string) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[
        name as 'amp' | 'lt' | 'gt' | 'quot' | '#39'
      ],
  );
}

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}

// Tags: Shopify's that sections use, over LiquidJS's own.

/** The tags of a body, up to `{% end<name> %}`. */
function bodyOf(
  name: string,
  token: TagToken,
  remainTokens: TopLevelToken[],
  each: (token: TopLevelToken) => void,
): void {
  while (remainTokens.length > 0) {
    const next = remainTokens.shift()!;
    if (TypeGuards.isTagToken(next) && next.name === `end${name}`) return;
    each(next);
  }
  throw new Error(`tag ${token.getText()} not closed`);
}

/**
 * `{% schema %}`, `{% stylesheet %}`, `{% javascript %}`: read when the theme is loaded, so they
 * render as nothing where they stand.
 */
function skippedBlock(name: string): TagClass {
  return class extends Tag {
    constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
      super(token, remainTokens, liquid);
      bodyOf(name, token, remainTokens, () => {});
    }

    render(): string {
      return '';
    }
  };
}

/**
 * LiquidJS's `{% render %}` and `{% include %}`, counting how deep snippets go: a snippet that
 * renders itself would otherwise run until the clock stopped it, and take as long to unwind.
 */
function* nested(ctx: Context, render: Generator<unknown, void, unknown>) {
  const limiter = ctx.renderLimit as unknown as Partial<WorkLimiter>;
  limiter.enter?.();
  try {
    yield* render;
  } finally {
    limiter.leave?.();
  }
}

class NestedRenderTag extends RenderTag {
  override *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    yield* nested(ctx, super.render(ctx, emitter));
  }
}

class NestedIncludeTag extends IncludeTag {
  override *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    yield* nested(ctx, super.render(ctx, emitter));
  }
}

/** `{% style %}`: CSS a section's settings can fill in, as a `<style>` element. */
class StyleTag extends Tag {
  readonly templates: Template[] = [];

  constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
    super(token, remainTokens, liquid);
    bodyOf('style', token, remainTokens, (next) => {
      this.templates.push(parser.parseToken(next, remainTokens));
    });
  }

  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    emitter.write('<style data-hatti>');
    yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
    emitter.write('</style>');
  }
}

/** `{% section 'header' %}` and `{% sections 'header-group' %}`, in a layout. */
function sectionTag(name: 'section' | 'sections'): TagClass {
  return class extends Tag {
    readonly value: ValueToken;

    constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
      super(token, remainTokens, liquid);
      this.value = this.tokenizer.readValueOrThrow();
    }

    *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
      const target = String(yield evalToken(this.value, ctx));
      const state = pageState(ctx);
      const html = name === 'section' ? state.renderSection(target) : state.renderGroup(target);
      emitter.write(yield html);
    }
  };
}

/**
 * Where forms post: the page's `routes` name the cart's, in the page's language; a path under
 * `root_url` is in it too.
 */
const FORM_ACTIONS: Record<string, string> = {
  product: 'cart_add_url',
  cart: 'cart_url',
  localization: '/localization',
  contact: '/contact',
  // Shopify's newsletter sign-ups post to /contact as well, in the page's language (ADR-189).
  customer: 'root_url:/contact',
  customer_login: '/account/login',
  storefront_password: 'root_url:/password',
};

/** A form's action, as {@link FORM_ACTIONS} names it, in the page's language. */
function formAction(type: string, routes: Record<string, string>): string {
  const action = Object.hasOwn(FORM_ACTIONS, type) ? FORM_ACTIONS[type]! : `/${handleize(type)}`;
  if (action.startsWith('/')) return action;
  const [route = '', path = ''] = action.split(':');
  const base = routes[route];
  if (base === undefined) return `/${handleize(type)}`;
  return path ? `${base === '/' ? '' : base}${path}` : base;
}

/**
 * `{% form 'product', product, id: 'form' %}`: a form that posts where Shopify's would, with the
 * fields it carries, so themes need no JavaScript to add to the cart. Inside it, `form.errors`
 * names what its last post got wrong, as for a storefront's password.
 */
class FormTag extends Tag {
  readonly type: ValueToken;
  readonly subject: ValueToken | undefined;
  readonly hash: Hash;
  readonly templates: Template[] = [];

  constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
    super(token, remainTokens, liquid);
    this.type = this.tokenizer.readValueOrThrow();
    this.tokenizer.skipBlank();
    if (this.tokenizer.peek() === ',') {
      this.tokenizer.advance();
      this.tokenizer.skipBlank();
      // A second argument that is not `key: value` is the form's subject, such as the product.
      const start = this.tokenizer.p;
      const subject = this.tokenizer.readValue();
      this.tokenizer.skipBlank();
      if (subject && this.tokenizer.peek() !== ':') this.subject = subject;
      else this.tokenizer.p = start;
    }
    this.hash = new Hash(this.tokenizer, liquid.options.keyValueSeparator);
    bodyOf('form', token, remainTokens, (next) => {
      this.templates.push(parser.parseToken(next, remainTokens));
    });
  }

  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const type = String(yield evalToken(this.type, ctx));
    const options = (yield this.hash.render(ctx)) as Record<string, unknown>;
    const routes = (ctx.globals as { routes?: Record<string, string> }).routes ?? {};
    // A comment posts to its article's address, in the page's language (ADR-220).
    const subject = this.subject ? ((yield evalToken(this.subject, ctx)) as unknown) : null;
    const commentUrl =
      type === 'new_comment' && typeof subject === 'object' && subject !== null
        ? (subject as { comment_post_url?: unknown }).comment_post_url
        : undefined;
    const root = routes.root_url && routes.root_url !== '/' ? routes.root_url : '';
    const attributes = Object.entries({
      method: 'post',
      action: typeof commentUrl === 'string' ? `${root}${commentUrl}` : formAction(type, routes),
      'accept-charset': 'UTF-8',
      ...(type === 'new_comment' && { id: 'comment_form', class: 'comment-form' }),
      ...options,
    })
      .map(([name, value]) => `${escapeHtml(name)}="${attribute(value)}"`)
      .join(' ');
    emitter.write(
      `<form ${attributes}><input type="hidden" name="form_type" value="${attribute(type)}">`,
    );
    const state = pageState(ctx);
    // A sign-up, or a comment, comes back to its page saying how it went (ADR-189, ADR-220): the
    // fields it got wrong, or that it was taken.
    const prefix = type === 'customer' ? 'customer' : type === 'new_comment' ? 'comment' : null;
    const posted = prefix === null ? {} : state.query;
    const errors =
      state.formErrors[type] ??
      posted[`${prefix}_error`]?.split(',').filter((field) => field !== '') ??
      [];
    ctx.push({
      form: {
        errors: errors.length > 0 ? [...errors] : null,
        'posted_successfully?': posted[`${prefix}_posted`] === 'true',
        // What a form shows again, as Shopify's: never what the shopper typed, which the
        // page's address does not keep.
        author: '',
        email: '',
        body: '',
      },
    });
    try {
      yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
    } finally {
      ctx.pop();
    }
    emitter.write('</form>');
  }
}

/**
 * `{% paginate collection.products by 24 %}`, or `search.results`: narrows the list to the page
 * asked for, fetching only that page, and sets `paginate` for the body, its links keeping the
 * request's query, as `q` for a search.
 */
class PaginateTag extends Tag {
  readonly owner: ValueToken;
  readonly property: string;
  readonly size: ValueToken;
  readonly templates: Template[] = [];

  constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
    super(token, remainTokens, liquid);
    const match = /^\s*([\w.[\]'"-]+)\.(\w+)\s+by\s+(.+?)\s*$/.exec(token.args);
    if (!match) throw new Error(`tag ${token.getText()}: use {% paginate x.products by 24 %}`);
    this.owner = new Tokenizer(match[1]!).readValueOrThrow();
    this.property = match[2]!;
    this.size = new Tokenizer(match[3]!).readValueOrThrow();
    bodyOf('paginate', token, remainTokens, (next) => {
      this.templates.push(parser.parseToken(next, remainTokens));
    });
  }

  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const owner = (yield evalToken(this.owner, ctx)) as
      (Paginable & Record<string, unknown>) | null;
    const size = Math.min(Math.max(Number(yield evalToken(this.size, ctx)) || 1, 1), 50);
    // A list pages when its owner says how long it is: products_count, results_count.
    const count = owner?.[`${this.property}_count`];
    const pageable = owner !== null && typeof count === 'number' && PAGINATE in owner;
    const items = pageable ? count : 0;
    const pages = Math.max(Math.ceil(items / size), 1);
    const state = pageState(ctx);
    const current = Math.min(Math.max(state.page, 1), pages);
    if (pageable) owner[PAGINATE]((current - 1) * size, size);
    const part = (page: number, title: string): PaginatePart => ({
      title,
      url: `?${new URLSearchParams({ ...state.query, page: String(page) })}`,
      is_link: page !== current,
    });
    ctx.push({
      paginate: {
        current_page: current,
        current_offset: (current - 1) * size,
        items,
        pages,
        page_size: size,
        previous: current > 1 ? part(current - 1, '&laquo; Previous') : null,
        next: current < pages ? part(current + 1, 'Next &raquo;') : null,
        parts: Array.from({ length: pages }, (_, index) => part(index + 1, String(index + 1))),
      },
    });
    try {
      yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
    } finally {
      ctx.pop();
    }
  }
}
