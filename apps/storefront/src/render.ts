import { Context, toPromise, type Liquid, type Template } from 'liquidjs';
import type { CartJson } from '@hatti/storefront-api';
import type { HandledKind, ShopDoc, StoreData } from '@hatti/storefront-data';
import { cartProducts } from './cart.js';
import { editorAttribute, editorScript, type EditorPlace } from './editor.js';
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
  predictiveSearchObject,
  productObject,
  resolveSettings,
  searchObject,
  shopObject,
  type ObjectContext,
} from './objects.js';
import { suggestedProducts, type SuggestParams } from './suggest.js';
import {
  jsonTemplate,
  sectionGroup,
  settingsOf,
  staticSection,
  type SectionList,
  type SectionPlacement,
  type SettingSchema,
  type Theme,
} from '@hatti/themes';
import { policyByHandle, policyMarkup, policyTitle, type PolicyKind } from './policies.js';

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
  /**
   * What a search for the search page found (ADR-046): what the shopper typed, and the products
   * found, best first. Absent for a search page asked for without words.
   */
  search?: { terms: string; productIds: readonly string[] } | null;
  /**
   * What a predictive search found (ADR-046), for its section: what it was asked, and the
   * products the core found, best first, more than it shows when some may be left out or put
   * last.
   */
  suggest?: { params: SuggestParams; productIds: readonly string[] } | null;
  /**
   * A theme shown through a preview link (ADR-049) rather than the shop's main theme: a bar on
   * the page names it, and ends the preview.
   */
  preview?: { name: string } | null;
  /**
   * The theme editor's frame (ADR-050): the page is in design mode, as `request.design_mode`
   * says, its sections and blocks marked for the editor, with the script that talks to it from
   * these origins.
   */
  editor?: { origins: readonly string[] } | null;
  /**
   * What a form posted to the page got wrong, by the form's type, as `form.errors` gives it: the
   * storefront's password, when it was not right (ADR-054).
   */
  formErrors?: Readonly<Record<string, readonly string[]>>;
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
  named: NamedDocument[];
  html: string;
  ms: number;
  renders: RenderStat[];
}

/**
 * A product, collection or page a page names by its handle before it renders: the one its route
 * shows, found or not, and those its settings choose. The edge keeps the page by them (ADR-047).
 */
export interface NamedDocument {
  kind: HandledKind;
  handle: string;
}

/** A page as it is written: its HTML a piece at a time, and what it took once it is all sent. */
export interface PageStream {
  status: number;
  /** What the page names, known before its body is written. */
  named: NamedDocument[];
  body: AsyncIterable<string>;
  done: Promise<{ ms: number; renders: RenderStat[] }>;
}

/**
 * A page whose shop, theme and resource are fetched, and nothing rendered yet: what it will be,
 * so that a page to be asked for elsewhere need not render.
 */
export interface ReadyPage {
  status: number;
  /** What the page names. */
  named: NamedDocument[];
  /** The shop's primary domain of its own, where shoppers are sent; empty when it has none. */
  domain: string;
  /** Renders the page, as it is written. */
  stream(): PageStream;
}

export interface RendererOptions {
  limits?: Partial<RenderLimits>;
  /** Render a page's sections side by side, so their fetches overlap (true), or in turn. */
  concurrent?: boolean;
  /** Products a list fetches at a time. */
  chunkSize?: number;
  /** Told of every render that failed; the page is sent without it. */
  onError?: (render: RenderStat, error: unknown) => void;
  /**
   * The platform's storefront address, https://hatti.pk, for shops' addresses: a shop with no
   * domain of its own is at its handle's subdomain, https://zari.hatti.pk. Pages' canonical and
   * alternate links, and what search engines and link previews are told, are absolute with it.
   */
  platformUrl?: string;
}

/** What a page's renders share, once its shop, theme and resource are known. */
interface PreparedPage {
  started: number;
  ctx: ObjectContext;
  query: Readonly<Record<string, string>>;
  /** What a form posted to the page got wrong, by the form's type. */
  formErrors: Readonly<Record<string, readonly string[]>>;
  /** Content of the platform's own instead of a template's, as a policy's page has (ADR-056). */
  builtIn: string | null;
  theme: Theme;
  template: SectionList | null;
  status: number;
  locale: string;
  layout: string | null;
  /** The layout's sections and section groups, and the groups' lists of sections. */
  parts: readonly { group: boolean; name: string }[];
  groups: ReadonlyMap<string, SectionList | null>;
  named: NamedDocument[];
  /** The shop's primary domain of its own; empty when it has none. */
  domain: string;
  preview: { name: string } | null;
  editor: { origins: readonly string[] } | null;
  /** The page's `<link rel="alternate" hreflang>`s, in its head. */
  alternates: string;
  /** The file the page's template is, such as templates/product.json. */
  templateFile: string | null;
  globals: Record<string | symbol, unknown>;
  renders: RenderStat[];
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
    predictive_search_url: `${prefix}/search/suggest`,
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
    return (await this.prepare(request, store, themeFor)).stream();
  }

  /** A page, as {@link stream} would write it, once its shop, theme and resource are known. */
  async prepare(request: PageRequest, store: StoreData, themeFor?: ThemeFor): Promise<ReadyPage> {
    const prepared = await this.#prepare(request, store, themeFor);
    const { status, named, domain } = prepared;
    return {
      status,
      named,
      domain,
      stream: () => {
        const body = new ChunkQueue();
        const done = this.#page(prepared, body).then(({ ms, renders }) => ({ ms, renders }));
        return { status, named, body, done };
      },
    };
  }

  /** A shop's address, as its pages' canonical links give it: https://zari.hatti.pk. */
  shopUrl(doc: ShopDoc): string {
    return String(shopObject(doc, this.options.platformUrl).url ?? '');
  }

  /** A page, as {@link stream} writes it, whole. A layout that fails leaves the sections alone. */
  async render(request: PageRequest, store: StoreData, themeFor?: ThemeFor): Promise<RenderedPage> {
    const page = await this.#prepare(request, store, themeFor);
    const { ms, renders, failed, content, html } = await this.#page(page);
    return failed
      ? { status: 500, named: page.named, html: content, ms, renders }
      : { status: page.status, named: page.named, html, ms, renders };
  }

  /**
   * Sections of a page, as Shopify's section rendering API gives them (`?section_id=`): each by
   * its ID on the page, else a section file of the theme's by name, placed as the theme's
   * settings place it; null for one that is neither. Without the layout, and whole.
   */
  async sections(
    request: PageRequest,
    store: StoreData,
    ids: readonly string[],
    themeFor?: ThemeFor,
  ): Promise<Map<string, string | null>> {
    const page = await this.#prepare(request, store, themeFor);
    const { theme, template, parts, groups, globals, ctx, renders, editor } = page;
    const state: PageState = {
      theme,
      locale: page.locale,
      page: Number(page.query.page) || 1,
      query: page.query,
      formErrors: page.formErrors,
      renderSection: () => Promise.resolve(''),
      renderGroup: () => Promise.resolve(''),
    };
    globals[PAGE] = state;
    const placed = new Map<string, { placement: SectionPlacement; place: EditorPlace }>();
    for (const part of parts) {
      const group = part.group ? groups.get(part.name) : undefined;
      if (!part.group) {
        placed.set(part.name, {
          placement: staticSection(theme, part.name),
          place: { file: SETTINGS_FILE, key: part.name },
        });
      }
      for (const id of group?.order ?? []) {
        placed.set(`${part.name}__${id}`, {
          placement: group!.sections[id]!,
          place: { file: `sections/${part.name}.json`, key: id },
        });
      }
    }
    for (const id of template?.order ?? []) {
      placed.set(id, {
        placement: template!.sections[id]!,
        place: { file: page.templateFile!, key: id },
      });
    }
    const rendered = await Promise.all(
      ids.map(async (id) => {
        const found =
          placed.get(id) ??
          (this.theme.files[`sections/${id}.liquid`] === undefined
            ? null
            : { placement: staticSection(theme, id), place: { file: SETTINGS_FILE, key: id } });
        const html = found
          ? await this.#section(id, found.placement, {}, globals, ctx, renders, {
              place: editor ? found.place : null,
            })
          : null;
        return [id, html] as const;
      }),
    );
    return new Map(rendered);
  }

  /** A prepared page rendered, written to `body` as it goes when there is one. */
  #page(
    prepared: PreparedPage,
    body?: ChunkQueue,
  ): Promise<{
    ms: number;
    renders: RenderStat[];
    failed: boolean;
    content: string;
    html: string;
  }> {
    const { started, ctx, query, theme, template, locale, layout } = prepared;
    const { parts, groups, globals, renders, editor, templateFile } = prepared;

    // What the page will have: the layout's sections, then the template's. Their styles go in the
    // head, and their scripts after the sections, whether they render or not.
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
      query,
      formErrors: prepared.formErrors,
      renderSection: (section) =>
        limiter.waitFor(layoutParts.get(`section:${section}`) ?? Promise.resolve('')),
      renderGroup: (group) =>
        limiter.waitFor(layoutParts.get(`group:${group}`) ?? Promise.resolve('')),
    };
    globals[PAGE] = state;

    // The layout's sections, then the template's, all under way at once.
    // In the editor's frame, each section says where its settings are kept.
    const render = (id: string, placement: SectionPlacement, place: EditorPlace) =>
      this.#section(id, placement, {}, globals, ctx, renders, { place: editor ? place : null });
    const renderList = async (list: SectionList, prefix: string, file: string) => {
      const run = (id: string) => render(`${prefix}${id}`, list.sections[id]!, { file, key: id });
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
        const file = `sections/${part.name}.json`;
        layoutParts.set(
          key,
          group ? renderList(group, `${part.name}__`, file) : Promise.resolve(''),
        );
      } else {
        const place = { file: SETTINGS_FILE, key: part.name };
        layoutParts.set(key, render(part.name, staticSection(theme, part.name), place));
      }
    }
    const content = (async () => {
      const sections = template
        ? await renderList(template, '', templateFile!)
        : (prepared.builtIn ?? '');
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
      return content.then((html) => {
        body?.push(html);
        return finish(html);
      });
    }
    const header =
      prepared.alternates +
      (styles ? `<style data-hatti-sections>${styles}</style>` : '') +
      (editor
        ? editorScript({ origins: editor.origins, template: templateFile })
        : prepared.preview
          ? previewBar(prepared.preview.name, locale)
          : '');
    const page = this.#run(
      { id: `layout/${layout}`, type: 'layout' },
      `layout/${layout}.liquid`,
      { content_for_layout: limiter.waitFor(content), content_for_header: header },
      globals,
      { limiter, onWrite: body && ((text) => body.push(text)) },
    );
    return page.then(({ html, stat }) => {
      renders.push(stat);
      return finish(stat.error === null ? html : null);
    });
  }

  /**
   * What a page's renders share: the shop and its theme, beside the resource the route shows,
   * the cart's products and a predictive search's; then the route's template, and the globals
   * of its Liquid.
   */
  async #prepare(
    request: PageRequest,
    store: StoreData,
    themeFor?: ThemeFor,
  ): Promise<PreparedPage> {
    const started = performance.now();
    const data = new RequestData(store);
    const query = request.query ?? {};
    const ctx: ObjectContext = { data, query, chunkSize: this.options.chunkSize ?? 12 };

    const found = route(request.path);
    const cart = request.cart ?? null;
    const suggest = request.suggest ?? null;
    const [{ shopDoc, theme }, shown, cartDocs, suggested] = await Promise.all([
      data.shop().then(async (shopDoc) => ({
        shopDoc,
        theme: themeFor ? await themeFor(shopDoc) : this.theme,
      })),
      resourceOf(found, ctx),
      cartProducts(cart, (ids) => data.products(ids)),
      suggest
        ? data.products(suggest.productIds).then((docs) => suggestedProducts(docs, suggest.params))
        : [],
    ]);
    const name = shown ? found.name : '404';
    const resource = shown ?? {};
    // A page may name another of the theme's templates for its kind, as page.contact.json.
    const suffix = templateSuffixOf(resource);
    let template: SectionList | null = null;
    let templateFile: string | null = null;
    for (const each of [suffix ? `${name}.${suffix}` : null, name, '404']) {
      template = each === null ? null : jsonTemplate(theme, each);
      if (template) {
        templateFile = `templates/${each}.json`;
        break;
      }
    }
    const status = name === '404' ? 404 : 200;
    const locale = theme.locales.has(request.locale ?? '') ? request.locale! : theme.defaultLocale;
    const shop = shopObject(shopDoc, this.options.platformUrl, {
      locale,
      prefix: locale === theme.defaultLocale ? '' : `/${locale}`,
    });
    // A policy's page is Shopify's own markup, in the theme's layout (ADR-056).
    let builtIn: string | null = null;
    if (name === 'policy') {
      const { kind, body } = resource.policy as { kind: PolicyKind; body: string };
      const title = policyTitle(kind, locale);
      // As Liquid sees it, as `shop.policies` gives each.
      const url = `${locale === theme.defaultLocale ? '' : `/${locale}`}/policies/${kind.handle}`;
      resource.policy = { id: kind.type, type: kind.type, title, body, url };
      builtIn = policyMarkup(title, body);
      template = null;
      templateFile = null;
    }
    // Where the page is, in each of the theme's languages: its canonical address in this one.
    const origin = String(shop.url ?? '');
    const pageNumber = Number(query.page) || 1;
    const addressIn = (code: string) => {
      const prefix = code === theme.defaultLocale ? '' : `/${code}`;
      const path = prefix && request.path === '/' ? prefix : `${prefix}${request.path}`;
      return `${origin}${path}${pageNumber > 1 ? `?page=${pageNumber}` : ''}`;
    };
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
        design_mode: Boolean(request.editor),
      },
      routes,
      canonical_url: addressIn(locale),
      cart: cartObject(cart, cartDocs, ctx, routes.cart_change_url!),
      search: searchObject(request.search ?? null, ctx),
      predictive_search: predictiveSearchObject(
        suggest && {
          terms: suggest.params.terms,
          types: suggest.params.types,
          productIds: suggested.map((doc) => doc.id),
        },
        ctx,
      ),
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
      template: {
        name,
        suffix: templateFile === `templates/${name}.${suffix}.json` ? suffix : null,
        directory: null,
      },
      page_title: pageTitle(resource, shop, name, (key) => translation(theme, locale, key, {})),
      ...lookups(ctx),
      // The page's product, collection or page is global on its template, as on Shopify:
      // snippets see it too.
      ...resource,
    };

    const parts = layout ? (theme.layoutSections.get(layout) ?? []) : [];
    const groups = new Map(
      parts.filter((part) => part.group).map((part) => [part.name, sectionGroup(theme, part.name)]),
    );
    const placements = [
      ...parts.flatMap((part) => {
        if (!part.group) return [staticSection(theme, part.name)];
        const group = groups.get(part.name);
        return group ? group.order.map((id) => group.sections[id]!) : [];
      }),
      ...(template?.order ?? []).map((id) => template!.sections[id]!),
    ];
    const named = this.#named(found, theme, placements);
    return {
      started,
      ctx,
      query,
      theme,
      template,
      status,
      locale,
      layout,
      parts,
      groups,
      named,
      domain: shopDoc.domain,
      preview: request.preview ?? null,
      formErrors: request.formErrors ?? {},
      builtIn,
      editor: request.editor ?? null,
      templateFile,
      // Its address in the theme's other languages, for search engines: pages that are found,
      // absolute, and neither previews nor in the editor.
      alternates:
        origin && status === 200 && theme.locales.size > 1 && !request.preview && !request.editor
          ? alternateLinks([...theme.locales.keys()], theme.defaultLocale, addressIn)
          : '',
      globals,
      renders,
    };
  }

  /**
   * The products, collections and pages a page names before it renders: its route's, and those
   * the theme's settings and its sections' and blocks' choose.
   */
  #named(
    found: { name: string; handle: string | null },
    theme: Theme,
    placements: readonly SectionPlacement[],
  ): NamedDocument[] {
    const named = new Map<string, NamedDocument>();
    const add = (kind: string, handle: unknown) => {
      if (!Object.hasOwn(NAMING, kind) || typeof handle !== 'string' || handle === '') return;
      named.set(`${kind}:${handle}`, { kind: NAMING[kind]!, handle });
    };
    const addSettings = (
      schema: readonly SettingSchema[] | undefined,
      values: Readonly<Record<string, unknown>>,
    ) => {
      for (const setting of schema ?? []) if (setting.id) add(setting.type, values[setting.id]);
    };
    if (found.handle) add(found.name, found.handle);
    addSettings(theme.settingsSchema, theme.settings);
    for (const placement of placements) {
      if (placement.disabled) continue;
      const schema = this.theme.schemas.get(placement.type);
      addSettings(schema?.settings, settingsOf(schema?.settings, placement.settings));
      for (const block of Object.values(placement.blocks ?? {})) {
        if (block.disabled) continue;
        const blockSchema = schema?.blocks?.find((each) => each.type === block.type);
        addSettings(blockSchema?.settings, settingsOf(blockSchema?.settings, block.settings));
      }
    }
    return [...named.values()];
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
    /** Where its settings are kept, in the editor's frame; null elsewhere. */
    editor: { place: EditorPlace | null } = { place: null },
  ): Promise<string> {
    const { place } = editor;
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
          // What the theme editor finds the block by: nothing outside it, as on Shopify.
          shopify_attributes: place
            ? editorAttribute('data-hatti-editor-block', { id: blockId, type: block.type })
            : '',
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
    const marked = place
      ? ` ${editorAttribute('data-hatti-editor-section', { id, type: placement.type, ...place })}`
      : '';
    return (
      `<div id="hatti-section-${escapeHtml(id)}" class="hatti-section ` +
      `section-${escapeHtml(placement.type)}"${marked}>${result.html}</div>`
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

/**
 * Links to a page in each of the theme's languages, as search engines read them, the default
 * language's for any other.
 */
function alternateLinks(
  locales: readonly string[],
  defaultLocale: string,
  addressIn: (code: string) => string,
): string {
  const link = (hreflang: string, href: string) =>
    `<link rel="alternate" hreflang="${escapeHtml(hreflang)}" href="${escapeHtml(href)}">`;
  return (
    locales.map((code) => link(code, addressIn(code))).join('') +
    link('x-default', addressIn(defaultLocale))
  );
}

/** Where static sections' settings are kept, as on Shopify: under `current.sections`. */
const SETTINGS_FILE = 'config/settings_data.json';

/** The words of the bar a previewed page carries, in the page's language. */
const PREVIEW_WORDS: Readonly<Record<string, { label: string; stop: string }>> = {
  en: { label: 'Preview', stop: 'Stop previewing' },
  ur: { label: 'پیش منظر', stop: 'پیش منظر بند کریں' },
};

/**
 * The bar a previewed page carries (ADR-049): the theme's name, and a link that ends the
 * preview. It comes in the head, which every layout writes, and a script puts it at the end of
 * the page's body.
 */
function previewBar(name: string, locale: string): string {
  const words = PREVIEW_WORDS[locale] ?? PREVIEW_WORDS.en!;
  return (
    '<template id="hatti-preview-bar">' +
    `<div class="hatti-preview-bar" role="region" aria-label="${words.label}">` +
    `<span>${words.label}: <strong>${escapeHtml(name)}</strong></span> ` +
    `<a href="?preview=">${words.stop}</a></div></template>` +
    '<style>.hatti-preview-bar{position:fixed;inset-inline:0;bottom:0;z-index:2147483647;' +
    'display:flex;gap:1rem;justify-content:space-between;align-items:center;' +
    'padding:.75rem 1rem calc(.75rem + env(safe-area-inset-bottom));background:#1c1917;' +
    'color:#fafaf9;font:14px/1.4 system-ui,sans-serif}' +
    '.hatti-preview-bar a{color:inherit;font-weight:600}</style>' +
    '<script>addEventListener("DOMContentLoaded",function(){' +
    'var bar=document.getElementById("hatti-preview-bar");if(bar)document.body.append(bar.content)' +
    '})</script>'
  );
}

/** Setting types, and templates, that name a document by its handle. */
const NAMING: Readonly<Record<string, HandledKind>> = {
  product: 'product',
  collection: 'collection',
  page: 'page',
};

const RESOURCE_TEMPLATES: Readonly<Record<string, string>> = {
  products: 'product',
  collections: 'collection',
  pages: 'page',
};

/** The template for a path, and the handle it names. */
function route(path: string): { name: string; handle: string | null } {
  if (path === '/' || path === '') return { name: 'index', handle: null };
  if (path === '/cart' || path === '/cart/') return { name: 'cart', handle: null };
  if (path === '/search' || path === '/search/') return { name: 'search', handle: null };
  // The storefront sends shoppers here while the shop is closed behind its password (ADR-054).
  if (path === '/password') return { name: 'password', handle: null };
  const policy = /^\/policies\/([a-z-]+)\/?$/.exec(path);
  if (policy) return { name: 'policy', handle: policy[1]! };
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
  if (found.name === 'policy') {
    const kind = found.handle ? policyByHandle(found.handle) : null;
    const body = kind && (await ctx.data.policy(kind.type));
    // Its title is in the page's language, once that is known.
    return body ? { policy: { kind, body } } : null;
  }
  return {};
}

function pageTitle(
  resource: Record<string, unknown>,
  shop: Record<string, unknown>,
  name: string,
  words: (key: string) => string | null,
): string {
  const titled = (resource.product ?? resource.collection ?? resource.page ?? resource.policy) as
    { title?: string } | undefined;
  if (titled?.title) return titled.title;
  if (name === 'cart') return words('sections.cart.title') ?? 'Your cart';
  if (name === 'search') return words('sections.search.title') ?? 'Search';
  return name === '404' ? 'Page not found' : String(shop.name);
}
