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
import { ImageDrop, PAGINATE, handleize, type Paginable } from './objects.js';
import type { Theme, ThemeFiles } from '@hatti/themes';

/**
 * What filters and tags need from the page they render: its language, and how to render the
 * sections a layout names. Kept in the render's globals under a symbol, which no template can
 * name.
 */
export interface PageState {
  theme: Theme;
  locale: string;
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
    // Dates, as articles' (ADR-177), print in Pakistan's time, where Hatti's shops are.
    timezoneOffset: 'Asia/Karachi',
  });
  for (const [name, filter] of Object.entries(filters(theme))) liquid.registerFilter(name, filter);
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
     * Shopify's: a product as schema.org's JSON-LD, for search engines, its addresses absolute at
     * the shop's; for a script element. Nothing for anything else.
     */
    structured_data: function (this: { context: Context }, value: unknown) {
      const shop = (this.context.globals as { shop?: { url?: unknown } }).shop;
      const data = productData(value, String(shop?.url ?? ''));
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
 * the image has, so phones fetch small ones.
 */
function imageTag(url: unknown, options: Record<string, unknown>): string {
  if (!(url instanceof ImageUrl)) return '';
  const { image } = url;
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
  };
  const markup = Object.entries(attributes)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => `${name}="${attribute(value)}"`)
    .join(' ');
  return `<img ${markup}>`;
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
    const attributes = Object.entries({
      method: 'post',
      action: formAction(type, routes),
      'accept-charset': 'UTF-8',
      ...options,
    })
      .map(([name, value]) => `${escapeHtml(name)}="${attribute(value)}"`)
      .join(' ');
    emitter.write(
      `<form ${attributes}><input type="hidden" name="form_type" value="${attribute(type)}">`,
    );
    const errors = pageState(ctx).formErrors[type] ?? [];
    ctx.push({ form: { errors: errors.length > 0 ? [...errors] : null } });
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
