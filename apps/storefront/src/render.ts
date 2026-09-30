import { Context, toPromise, type Liquid, type Template } from 'liquidjs';
import type { CartJson } from '@hatti/storefront-api';
import type { ShopDoc, StoreData } from '@hatti/storefront-data';
import { cartProducts } from './cart.js';
import { PAGE, createEngine, escapeHtml, translation, type PageState } from './liquid.js';
import {
  CappedEmitter,
  DEFAULT_LIMITS,
  WorkLimiter,
  limitOf,
  type LimitKind,
  type RenderLimits,
} from './limits.js';
import { ChunkQueue } from './stream.js';
import {
  RequestData,
  cartObject,
  collectionObject,
  deliveryObject,
  lookups,
  pageObject,
  productObject,
  resolveSettings,
  shopObject,
  type ObjectContext,
} from './objects.js';
import {
  jsonTemplate,
  sectionGroup,
  settingsOf,
  staticSection,
  type SectionList,
  type SectionPlacement,
  type Theme,
} from '@hatti/themes';

export interface PageRequest {
  /** The path asked for: "/", "/products/lawn-3pc", "/collections/eid", "/pages/about-us". */
  path: string;
  query?: Readonly<Record<string, string>>;
  /** "en" or "ur"; the theme's default when it has no such locale. */
  locale?: string;
  /**
   * The shopper's cart, for the cart page, which alone shows it: other pages are the same for
   * everyone, and scripts show the cart's count on them. Null for no cart.
   */
  cart?: CartJson | null;
  /** Why a change to the cart was refused, in the page's language, for the cart page to say. */
  cartError?: string | null;
}

/**
 * The theme a shop's pages are rendered with, from its document: the platform theme with the
 * shop's own files over it (ADR-039).
 */
export type ThemeFor = (shop: ShopDoc) => Theme | Promise<Theme>;

/** What one render did: a section, a section of the layout's, or the layout itself. */
export interface RenderStat {
  id: string;
  type: string;
  ms: number;
  nodes: number;
  chars: number;
  /** The limit it went over, or "error" for a template error; null when it rendered. */
  error: LimitKind | 'error' | null;
}

export interface RenderedPage {
  status: number;
  html: string;
  ms: number;
  renders: RenderStat[];
}

/** A page as it is written: its HTML a piece at a time, and what it took once it is all sent. */
export interface PageStream {
  status: number;
  body: AsyncIterable<string>;
  done: Promise<{ ms: number; renders: RenderStat[] }>;
}

export interface RendererOptions {
  limits?: Partial<RenderLimits>;
  /** Render a page's sections side by side, so their fetches overlap (true), or in turn. */
  concurrent?: boolean;
  /** Products a list fetches at a time. */
  chunkSize?: number;
  /** Told of every render that failed; the page is sent without it. */
  onError?: (render: RenderStat, error: unknown) => void;
}

const LOCALE_NAMES: Record<string, { name: string; endonym: string; rtl: boolean }> = {
  en: { name: 'English', endonym: 'English', rtl: false },
  ur: { name: 'Urdu', endonym: 'اردو', rtl: true },
};

/** Shopify's `routes`, under `prefix`: `/ur` for Urdu pages, so their forms stay in Urdu. */
function routesFor(prefix: string): Record<string, string> {
  return {
    root_url: prefix || '/',
    cart_url: `${prefix}/cart`,
    cart_add_url: `${prefix}/cart/add`,
    cart_change_url: `${prefix}/cart/change`,
    cart_update_url: `${prefix}/cart/update`,
    cart_clear_url: `${prefix}/cart/clear`,
    collections_url: `${prefix}/collections`,
    all_products_collection_url: `${prefix}/collections/all`,
    search_url: `${prefix}/search`,
    account_url: `${prefix}/account`,
  };
}

/**
 * Renders a theme's pages (04 §3.3): the route picks a JSON template; its sections, and those the
 * layout names, render side by side, each within its own limits, a failing one leaving a gap
 * rather than breaking the page; the layout renders last, around them. Parsed templates are kept
 * for the theme's version. A shop's own theme changes only JSON, so its pages share the platform
 * theme's parsed Liquid.
 */
export class PageRenderer {
  readonly engine: Liquid;
  readonly #limits: RenderLimits;
  readonly #parsed = new Map<string, Template[]>();

  constructor(
    readonly theme: Theme,
    private readonly options: RendererOptions = {},
  ) {
    this.engine = createEngine(theme);
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  /**
   * A page of the shop `store` holds, in the theme `themeFor` gives or the platform theme, as it
   * is written (04 §3.3): its status once its shop, theme and resource are known, then its HTML as
   * the layout writes it, up to each place it waits for sections, so that a phone has the head
   * while the sections render. A layout that fails once the page is under way ends it there.
   */
  async stream(request: PageRequest, store: StoreData, themeFor?: ThemeFor): Promise<PageStream> {
    const body = new ChunkQueue();
    const { status, done } = await this.#page(request, store, themeFor, body);
    return { status, body, done: done.then(({ ms, renders }) => ({ ms, renders })) };
  }

  /** A page, as {@link stream} writes it, whole. A layout that fails leaves the sections alone. */
  async render(request: PageRequest, store: StoreData, themeFor?: ThemeFor): Promise<RenderedPage> {
    const page = await this.#page(request, store, themeFor);
    const { ms, renders, failed, content, html } = await page.done;
    return failed
      ? { status: 500, html: content, ms, renders }
      : { status: page.status, html, ms, renders };
  }

  /** A page, written to `body` as it goes when there is one. */
  async #page(
    request: PageRequest,
    store: StoreData,
    themeFor?: ThemeFor,
    body?: ChunkQueue,
  ): Promise<{
    status: number;
    done: Promise<{
      ms: number;
      renders: RenderStat[];
      failed: boolean;
      content: string;
      html: string;
    }>;
  }> {
    const started = performance.now();
    const data = new RequestData(store);
    const query = request.query ?? {};
    const ctx: ObjectContext = { data, query, chunkSize: this.options.chunkSize ?? 12 };

    // The shop and its theme, beside the resource the route shows and the cart's products; then
    // the route's template.
    const found = route(request.path);
    const cart = request.cart ?? null;
    const [{ shopDoc, theme }, shown, cartDocs] = await Promise.all([
      data.shop().then(async (shopDoc) => ({
        shopDoc,
        theme: themeFor ? await themeFor(shopDoc) : this.theme,
      })),
      resourceOf(found, ctx),
      cartProducts(cart, (ids) => data.products(ids)),
    ]);
    const name = shown ? found.name : '404';
    const resource = shown ?? {};
    // A page may name another of the theme's templates for its kind, as page.contact.json.
    const suffix = templateSuffixOf(resource);
    const suffixed = suffix ? jsonTemplate(theme, `${name}.${suffix}`) : null;
    const template = suffixed ?? jsonTemplate(theme, name) ?? jsonTemplate(theme, '404');
    const status = name === '404' ? 404 : 200;
    const locale = theme.locales.has(request.locale ?? '') ? request.locale! : theme.defaultLocale;
    const shop = shopObject(shopDoc);
    const layout = template?.layout === false ? null : (template?.layout ?? 'theme');

    const renders: RenderStat[] = [];
    const localeInfo = LOCALE_NAMES[locale] ?? { name: locale, endonym: locale, rtl: false };
    const routes = routesFor(locale === theme.defaultLocale ? '' : `/${locale}`);
    const globals: Record<string | symbol, unknown> = {
      shop,
      settings: resolveSettings(theme.settings, theme.settingsSchema, ctx),
      request: {
        locale: { iso_code: locale, name: localeInfo.name, endonym_name: localeInfo.endonym },
        page_type: name,
        path: request.path,
        design_mode: false,
      },
      routes,
      cart: cartObject(cart, cartDocs, ctx, routes.cart_change_url!),
      // Hatti's: why a change to the cart was refused.
      cart_error: request.cartError ?? null,
      localization: {
        language: { iso_code: locale, name: localeInfo.name, endonym_name: localeInfo.endonym },
        available_languages: [...theme.locales.keys()].map((code) => ({
          iso_code: code,
          name: LOCALE_NAMES[code]?.name ?? code,
          endonym_name: LOCALE_NAMES[code]?.endonym ?? code,
        })),
        country: { iso_code: 'PK', name: 'Pakistan', currency: { iso_code: 'PKR', symbol: 'Rs' } },
      },
      // Hatti's own (04 §3.2).
      direction: localeInfo.rtl ? 'rtl' : 'ltr',
      cod: { available: shopDoc.cod.available, fee: shopDoc.cod.fee, limit: shopDoc.cod.limit },
      delivery: deliveryObject(shopDoc),
      template: { name, suffix: suffixed ? suffix : null, directory: null },
      page_title: pageTitle(resource, shop, name, (key) => translation(theme, locale, key, {})),
      ...lookups(ctx),
      // The page's product, collection or page is global on its template, as on Shopify:
      // snippets see it too.
      ...resource,
    };

    // What the page will have: the layout's sections, then the template's. Their styles go in the
    // head, and their scripts after the sections, whether they render or not.
    const parts = layout ? (theme.layoutSections.get(layout) ?? []) : [];
    const groups = new Map(
      parts.filter((part) => part.group).map((part) => [part.name, sectionGroup(theme, part.name)]),
    );
    const types = new Set<string>();
    const plan = (placement: SectionPlacement) => {
      if (!placement.disabled) types.add(placement.type);
    };
    for (const part of parts) {
      const group = part.group ? groups.get(part.name) : undefined;
      if (!part.group) plan(staticSection(theme, part.name));
      for (const id of group?.order ?? []) plan(group!.sections[id]!);
    }
    for (const id of template?.order ?? []) plan(template!.sections[id]!);
    const assets = [...types].map((type) => theme.assets.get(type));
    const scripts = assets
      .map((asset) => asset?.js)
      .filter(Boolean)
      .map((js) => `<script type="module">${js}</script>`)
      .join('');
    const styles = assets
      .map((asset) => asset?.css)
      .filter(Boolean)
      .join('\n');

    // The layout waits for its sections without the wait counting against its time: each has
    // time of its own.
    const layoutParts = new Map<string, Promise<string>>();
    const limiter = new WorkLimiter(this.#limits);
    const state: PageState = {
      theme,
      locale,
      page: Number(query.page) || 1,
      renderSection: (section) =>
        limiter.waitFor(layoutParts.get(`section:${section}`) ?? Promise.resolve('')),
      renderGroup: (group) =>
        limiter.waitFor(layoutParts.get(`group:${group}`) ?? Promise.resolve('')),
    };
    globals[PAGE] = state;

    // The layout's sections, then the template's, all under way at once.
    const render = (id: string, placement: SectionPlacement, env: Record<string, unknown>) =>
      this.#section(id, placement, env, globals, ctx, renders);
    const renderList = async (list: SectionList, prefix: string) => {
      const run = (id: string) => render(`${prefix}${id}`, list.sections[id]!, {});
      if (this.options.concurrent === false) {
        const done: string[] = [];
        for (const id of list.order) done.push(await run(id));
        return done.join('');
      }
      return (await Promise.all(list.order.map(run))).join('');
    };
    for (const part of parts) {
      const key = `${part.group ? 'group' : 'section'}:${part.name}`;
      if (layoutParts.has(key)) continue;
      const group = groups.get(part.name);
      if (part.group) {
        layoutParts.set(key, group ? renderList(group, `${part.name}__`) : Promise.resolve(''));
      } else {
        layoutParts.set(key, render(part.name, staticSection(theme, part.name), {}));
      }
    }
    const content = (async () => {
      const sections = template ? await renderList(template, '') : '';
      await Promise.all(layoutParts.values());
      return sections + scripts;
    })();

    const finish = async (html: string | null) => {
      body?.close();
      const sections = await content;
      const ms = performance.now() - started;
      return { ms, renders, failed: html === null, content: sections, html: html ?? sections };
    };
    if (!layout) {
      return {
        status,
        done: content.then((html) => {
          body?.push(html);
          return finish(html);
        }),
      };
    }
    const header = styles ? `<style data-hatti-sections>${styles}</style>` : '';
    const page = this.#run(
      { id: `layout/${layout}`, type: 'layout' },
      `layout/${layout}.liquid`,
      { content_for_layout: limiter.waitFor(content), content_for_header: header },
      globals,
      { limiter, onWrite: body && ((text) => body.push(text)) },
    );
    return {
      status,
      done: page.then(({ html, stat }) => {
        renders.push(stat);
        return finish(stat.error === null ? html : null);
      }),
    };
  }

  /** Parses every template of the theme, as publishing it would: errors name their file. */
  check(): { file: string; message: string }[] {
    const errors: { file: string; message: string }[] = [];
    for (const [file, source] of Object.entries(this.theme.files)) {
      if (!file.endsWith('.liquid')) continue;
      try {
        this.engine.parse(source, file);
      } catch (error) {
        errors.push({ file, message: (error as Error).message });
      }
    }
    return errors;
  }

  /** A section, wrapped as themes' CSS and the theme editor expect; nothing if it fails. */
  async #section(
    id: string,
    placement: SectionPlacement,
    env: Record<string, unknown>,
    globals: Record<string | symbol, unknown>,
    ctx: ObjectContext,
    renders: RenderStat[],
  ): Promise<string> {
    const schema = this.theme.schemas.get(placement.type) ?? {};
    if (placement.disabled) return '';
    const order = placement.block_order ?? Object.keys(placement.blocks ?? {});
    const blocks = order.flatMap((blockId) => {
      const block = placement.blocks?.[blockId];
      if (!block || block.disabled) return [];
      const blockSchema = schema.blocks?.find((each) => each.type === block.type);
      return [
        {
          id: blockId,
          type: block.type,
          settings: resolveSettings(
            settingsOf(blockSchema?.settings, block.settings),
            blockSchema?.settings,
            ctx,
          ),
          shopify_attributes: '',
        },
      ];
    });
    const section = {
      id,
      type: placement.type,
      settings: resolveSettings(
        settingsOf(schema.settings, placement.settings),
        schema.settings,
        ctx,
      ),
      blocks,
    };
    // In the order sections start, not finish, so their assets come in the same order each time.
    const at = renders.push({ id, type: placement.type, ms: 0, nodes: 0, chars: 0, error: null });
    const result = await this.#run(
      { id, type: placement.type },
      `sections/${placement.type}.liquid`,
      { ...env, section },
      globals,
    );
    renders[at - 1] = result.stat;
    if (result.stat.error) return `<!-- ${escapeHtml(id)}: not shown -->`;
    return (
      `<div id="hatti-section-${escapeHtml(id)}" class="hatti-section ` +
      `section-${escapeHtml(placement.type)}">${result.html}</div>`
    );
  }

  /** Renders one template file within the limits, reporting what it took. */
  async #run(
    what: { id: string; type: string },
    file: string,
    env: Record<string, unknown>,
    globals: Record<string | symbol, unknown>,
    options: { limiter?: WorkLimiter; onWrite?: (text: string) => void } = {},
  ): Promise<{ html: string; stat: RenderStat }> {
    const started = performance.now();
    const limiter = options.limiter ?? new WorkLimiter(this.#limits);
    const emitter = new CappedEmitter(this.#limits.output, options.onWrite);
    let error: unknown = null;
    try {
      const templates = this.#parse(file);
      const ctx = new Context(
        env,
        this.engine.options,
        { globals, memoryLimit: this.#limits.memory },
        { renderLimit: limiter, liquid: this.engine } as unknown as ConstructorParameters<
          typeof Context
        >[3],
      );
      await toPromise(this.engine.renderer.renderTemplates(templates, ctx, emitter));
    } catch (caught) {
      error = caught;
    }
    const stat: RenderStat = {
      ...what,
      ms: performance.now() - started,
      nodes: limiter.nodes,
      chars: emitter.buffer.length,
      error: error === null ? null : (limitOf(error) ?? 'error'),
    };
    if (error !== null) this.options.onError?.(stat, error);
    return { html: error === null ? emitter.buffer : '', stat };
  }

  #parse(file: string): Template[] {
    let templates = this.#parsed.get(file);
    if (!templates) {
      const source = this.theme.files[file];
      if (source === undefined) throw new Error(`The theme has no ${file}`);
      templates = this.engine.parse(source, file);
      this.#parsed.set(file, templates);
    }
    return templates;
  }
}

const RESOURCE_TEMPLATES: Readonly<Record<string, string>> = {
  products: 'product',
  collections: 'collection',
  pages: 'page',
};

/** The template for a path, and the handle it names. */
function route(path: string): { name: string; handle: string | null } {
  if (path === '/' || path === '') return { name: 'index', handle: null };
  if (path === '/cart' || path === '/cart/') return { name: 'cart', handle: null };
  const match = /^\/(products|collections|pages)\/([\w-]+)\/?$/.exec(path);
  if (!match) return { name: '404', handle: null };
  return { name: RESOURCE_TEMPLATES[match[1]!]!, handle: match[2]! };
}

/** The template suffix the route's resource asks for: a page's, such as "contact". */
function templateSuffixOf(resource: Record<string, unknown>): string | null {
  const page = resource.page as { template_suffix?: string | null } | undefined;
  return page?.template_suffix ?? null;
}

/**
 * The product, collection or page a route shows, as its template's globals: none for other
 * routes, and null when the shop has none by the handle.
 */
async function resourceOf(
  found: { name: string; handle: string | null },
  ctx: ObjectContext,
): Promise<Record<string, unknown> | null> {
  if (found.name === 'product' && found.handle) {
    const doc = await ctx.data.productByHandle(found.handle);
    return doc ? { product: productObject(doc, ctx) } : null;
  }
  if (found.name === 'collection' && found.handle) {
    const doc = await ctx.data.collection(found.handle);
    return doc ? { collection: collectionObject(doc, ctx) } : null;
  }
  if (found.name === 'page' && found.handle) {
    const doc = await ctx.data.page(found.handle);
    return doc ? { page: pageObject(doc) } : null;
  }
  return {};
}

function pageTitle(
  resource: Record<string, unknown>,
  shop: Record<string, unknown>,
  name: string,
  words: (key: string) => string | null,
): string {
  const titled = (resource.product ?? resource.collection ?? resource.page) as
    { title?: string } | undefined;
  if (titled?.title) return titled.title;
  if (name === 'cart') return words('sections.cart.title') ?? 'Your cart';
  return name === '404' ? 'Page not found' : String(shop.name);
}
