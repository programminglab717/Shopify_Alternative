import { Context, toPromise, type Liquid, type Template } from 'liquidjs';
import type { ShopDoc, StoreData } from '@hatti/storefront-data';
import { PAGE, createEngine, escapeHtml, type PageState } from './liquid.js';
import {
  CappedEmitter,
  DEFAULT_LIMITS,
  WorkLimiter,
  limitOf,
  type LimitKind,
  type RenderLimits,
} from './limits.js';
import {
  RequestData,
  collectionObject,
  lookups,
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
} from './theme.js';

export interface PageRequest {
  /** The path asked for: "/", "/products/lawn-3pc", "/collections/eid". */
  path: string;
  query?: Readonly<Record<string, string>>;
  /** "en" or "ur"; the theme's default when it has no such locale. */
  locale?: string;
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

const ROUTES = {
  root_url: '/',
  cart_url: '/cart',
  cart_add_url: '/cart/add',
  collections_url: '/collections',
  all_products_collection_url: '/collections/all',
  search_url: '/search',
  account_url: '/account',
};

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

  /** A page of the shop `store` holds, in the theme `themeFor` gives, or the platform theme. */
  async render(request: PageRequest, store: StoreData, themeFor?: ThemeFor): Promise<RenderedPage> {
    const started = performance.now();
    const data = new RequestData(store);
    const query = request.query ?? {};
    const ctx: ObjectContext = { data, query, chunkSize: this.options.chunkSize ?? 12 };

    // The shop and its theme, beside the resource the route shows; then the route's template.
    const found = route(request.path);
    const [{ shopDoc, theme }, shown] = await Promise.all([
      data.shop().then(async (shopDoc) => ({
        shopDoc,
        theme: themeFor ? await themeFor(shopDoc) : this.theme,
      })),
      resourceOf(found, ctx),
    ]);
    const name = shown ? found.name : '404';
    const resource = shown ?? {};
    const template = jsonTemplate(theme, name) ?? jsonTemplate(theme, '404');
    const status = name === '404' ? 404 : 200;
    const locale = theme.locales.has(request.locale ?? '') ? request.locale! : theme.defaultLocale;
    const shop = shopObject(shopDoc);
    const layout = template?.layout === false ? null : (template?.layout ?? 'theme');

    const renders: RenderStat[] = [];
    const localeInfo = LOCALE_NAMES[locale] ?? { name: locale, endonym: locale, rtl: false };
    const globals: Record<string | symbol, unknown> = {
      shop,
      settings: resolveSettings(theme.settings, theme.settingsSchema, ctx),
      request: {
        locale: { iso_code: locale, name: localeInfo.name, endonym_name: localeInfo.endonym },
        page_type: name,
        path: request.path,
        design_mode: false,
      },
      routes: ROUTES,
      cart: { item_count: 0, items: [], total_price: 0, currency: { iso_code: 'PKR' } },
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
      template: { name, suffix: null, directory: null },
      page_title: pageTitle(resource, shop, name),
      ...lookups(ctx),
      // The page's product or collection is global on its template, as on Shopify: snippets see
      // it too.
      ...resource,
    };

    // The layout's own sections, then the template's, all under way at once.
    const layoutParts = new Map<string, Promise<string>>();
    const render = (id: string, placement: SectionPlacement, env: Record<string, unknown>) =>
      this.#section(id, placement, env, globals, ctx, renders);
    const renderList = async (list: SectionList, prefix: string) => {
      const run = (id: string) => render(`${prefix}${id}`, list.sections[id]!, {});
      if (this.options.concurrent === false) {
        const parts: string[] = [];
        for (const id of list.order) parts.push(await run(id));
        return parts.join('');
      }
      return (await Promise.all(list.order.map(run))).join('');
    };
    for (const part of layout ? (theme.layoutSections.get(layout) ?? []) : []) {
      const key = `${part.group ? 'group' : 'section'}:${part.name}`;
      if (layoutParts.has(key)) continue;
      if (part.group) {
        const group = sectionGroup(theme, part.name);
        layoutParts.set(key, group ? renderList(group, `${part.name}__`) : Promise.resolve(''));
      } else {
        layoutParts.set(key, render(part.name, staticSection(theme, part.name), {}));
      }
    }
    const state: PageState = {
      theme,
      locale,
      page: Number(query.page) || 1,
      renderSection: (section) => layoutParts.get(`section:${section}`) ?? Promise.resolve(''),
      renderGroup: (group) => layoutParts.get(`group:${group}`) ?? Promise.resolve(''),
    };
    globals[PAGE] = state;

    let content = template ? await renderList(template, '') : '';
    await Promise.all(layoutParts.values());
    const used = new Set(renders.map((stat) => stat.type));
    const scripts = [...used]
      .map((type) => theme.assets.get(type)?.js)
      .filter(Boolean)
      .map((js) => `<script type="module">${js}</script>`)
      .join('');
    content += scripts;
    if (!layout) return { status, html: content, ms: performance.now() - started, renders };

    const styles = [...used]
      .map((type) => theme.assets.get(type)?.css)
      .filter(Boolean)
      .join('\n');
    const header = styles ? `<style data-hatti-sections>${styles}</style>` : '';
    const page = await this.#run(
      { id: `layout/${layout}`, type: 'layout' },
      `layout/${layout}.liquid`,
      { content_for_layout: content, content_for_header: header },
      globals,
    );
    renders.push(page.stat);
    const html = page.stat.error ? content : page.html;
    return {
      status: page.stat.error ? 500 : status,
      html,
      ms: performance.now() - started,
      renders,
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
  ): Promise<{ html: string; stat: RenderStat }> {
    const started = performance.now();
    const limiter = new WorkLimiter(this.#limits);
    const emitter = new CappedEmitter(this.#limits.output);
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

/** The template for a path, and the handle it names. */
function route(path: string): { name: string; handle: string | null } {
  if (path === '/' || path === '') return { name: 'index', handle: null };
  const match = /^\/(products|collections)\/([\w-]+)\/?$/.exec(path);
  if (!match) return { name: '404', handle: null };
  return { name: match[1] === 'products' ? 'product' : 'collection', handle: match[2]! };
}

/**
 * The product or collection a route shows, as its template's globals: none for other routes, and
 * null when the shop has none by the handle.
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
  return {};
}

function pageTitle(
  resource: Record<string, unknown>,
  shop: Record<string, unknown>,
  name: string,
): string {
  const titled = (resource.product ?? resource.collection) as { title?: string } | undefined;
  if (titled?.title) return titled.title;
  return name === '404' ? 'Page not found' : String(shop.name);
}
