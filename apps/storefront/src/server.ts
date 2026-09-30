import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { checkPassword } from '@hatti/crypto';
import {
  MemoryStore,
  RedisStore,
  ShopDirectory,
  StoreMissingError,
  StorefrontKeys,
  handleTag,
  pathTag,
  redirectKey,
  shopTag,
  type ShopDoc,
  type StoreData,
  type ThemeDoc,
} from '@hatti/storefront-data';
import { RateLimiter } from '@hatti/ratelimit';
import {
  SEARCH_TERMS_MAX,
  StorefrontApiError,
  checkoutPagePath,
  type CartJson,
  type ThemePreviewResponse,
} from '@hatti/storefront-api';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import {
  CART_COOKIE,
  ajaxCart,
  ajaxLineItem,
  cartBody,
  cartCookies,
  cartCountCookie,
  cartErrorMessage,
  cartErrorStatus,
  cartProducts,
  cartRoute,
  cookieOf,
  parseForm,
  type CoreBackend,
} from './cart.js';
import { sampleStore } from './fixtures.js';
import { PASSWORD_COOKIE, isPasswordPass, passwordCookie, passwordPass } from './password.js';
import { translation } from './liquid.js';
import type { NamedDocument, PageRenderer, PageRequest } from './render.js';
import {
  SITEMAP_KINDS,
  robotsTxt,
  sitemapIndex,
  sitemapOf,
  sitemapPage,
  sitemapPages,
} from './sitemap.js';
import { suggestJson, suggestParams, suggestWanted, suggestedProducts } from './suggest.js';
import { overlayTheme, type Theme, type ThemeError } from '@hatti/themes';

export interface StorefrontServerOptions {
  theme: Theme;
  renderer: PageRenderer;
  /** The platform's domain, without a port: each shop answers at {handle}.{domain}. */
  domain: string;
  /** Where published shops' documents are. Without it, only the sample shop is served. */
  redis?: Redis;
  keys?: StorefrontKeys;
  /** What the platform's domain itself serves: the sample shop, in development. */
  sample?: MemoryStore;
  /** Draws placeholder images under /images/, which sample data points at. */
  placeholders?: boolean;
  /** Told of each file of a shop's theme left out, the platform theme's showing instead. */
  onThemeFileRejected?: (shopId: string, error: ThemeError) => void;
  /**
   * The core's storefront API, which keeps shoppers' carts (ADR-042) and checkouts (ADR-044).
   * Without it, carts cannot change.
   */
  core?: CoreBackend;
  /** Cookies only over HTTPS, as in production. */
  secureCookies?: boolean;
  /** Behind a proxy, such as the edge, which says who the shopper is. */
  trustProxy?: boolean;
  /**
   * Where the theme editor is, such as https://admin.hatti.pk (ADR-050): only these may frame a
   * preview, whose page is then in design mode, and talk to it. Without them, previews have no
   * design mode.
   */
  editorOrigins?: readonly string[];
}

/**
 * Pages, as the edge keeps them (ADR-047): five minutes unless the publisher purges them sooner,
 * then shown while fetched again, and for a week while the storefront cannot answer. Browsers
 * ask each time, as they cannot be told to forget.
 */
const PAGE_CACHE =
  'public, max-age=0, s-maxage=300, stale-while-revalidate=86400, stale-if-error=604800';

/** Search results and suggestions: a minute, as nothing purges them. */
const SEARCH_CACHE = 'public, max-age=0, s-maxage=60';

/** robots.txt and sitemaps: an hour at the edge, or until the shop's document changes. */
const CRAWLER_CACHE = 'public, max-age=0, s-maxage=3600';

/** Theme assets, whose address names the theme's version. */
const ASSET_CACHE = 'public, max-age=31536000, immutable';

/** Changes to carts an address may make a minute: more than a shopper would, fewer than a script. */
const CART_CHANGES = { name: 'cart-changes', limit: 120, windowMs: 60_000 };

/**
 * Searches an address may ask the core for a minute, suggestions as a shopper types among them:
 * room for many shoppers behind one mobile network's address, but not for a script.
 */
const SEARCHES = { name: 'searches', limit: 240, windowMs: 60_000 };

/**
 * Tries at a closed shop's password an address may make a minute (ADR-054): enough for shoppers
 * behind one mobile network's address to mistype, too few to guess.
 */
const PASSWORD_TRIES = { name: 'password-tries', limit: 10, windowMs: 60_000 };

/** The longest password a shopper's try is checked for: shops' are at most 100 characters. */
const PASSWORD_TYPED_MAX = 200;

/** Routes a closed shop answers to everyone: its password page, and what crawlers and pages load. */
const OPEN_ROUTES = new Set([
  '/password',
  '/ur/password',
  '/robots.txt',
  '/assets/:version/:file',
  '/images/*',
]);

/** What a previewed page is: the shopper's own, never kept, and not for search engines. */
const PREVIEWED = 'private, no-store';

/**
 * The token of the preview link the shopper followed (ADR-049), which the core opens: the theme
 * it shows is shown on every page here until the link ends.
 */
const PREVIEW_COOKIE = 'hatti_preview';

/** Tokens the core seals: anything else is not sent to it. */
const PREVIEW_TOKEN = /^[\w.-]{16,512}$/;

/** A section's ID, as themes may name one (the themes package's rule). */
const SECTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The most sections one request may ask for, as on Shopify. */
const SECTIONS_MAX = 5;

// A shop's handle: a DNS label, as control.shops checks it.
const HANDLE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * The handle a host names on the platform's domain: "zari" for zari.hatti.pk (or with a port).
 * Null for the domain itself; undefined for any other host, such as a shop's own domain.
 */
export function handleOf(host: string, domain: string): string | null | undefined {
  const name = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (name === domain) return null;
  if (!name.endsWith(`.${domain}`)) return undefined;
  const label = name.slice(0, -domain.length - 1);
  return HANDLE.test(label) && !label.includes('--') ? label : undefined;
}

/**
 * Shops by handle, from the directory, each answer kept for a few seconds: every page asks, and
 * handles seldom change. A shop just published shows within that time.
 */
export class ShopResolver {
  readonly #answers = new Map<string, { shopId: string | null; until: number }>();

  constructor(
    private readonly directory: Pick<ShopDirectory, 'find'>,
    private readonly ttlMs = 5_000,
    private readonly size = 10_000,
  ) {}

  async find(handle: string): Promise<string | null> {
    const now = Date.now();
    const known = this.#answers.get(handle);
    if (known && known.until > now) return known.shopId;
    const shopId = await this.directory.find(handle);
    this.#answers.delete(handle);
    if (this.#answers.size >= this.size) {
      this.#answers.delete(this.#answers.keys().next().value!);
    }
    this.#answers.set(handle, { shopId, until: now + this.ttlMs });
    return shopId;
  }
}

/** A theme a preview link shows (ADR-049), and its name, for the bar on its pages. */
interface Preview {
  name: string;
  theme: Theme;
}

/**
 * The shop a request is for, where its documents are, the theme it previews, if any, and whether
 * the preview is in the theme editor's frame.
 */
interface Found {
  shopId: string;
  store: StoreData;
  preview: Preview | null;
  editor: boolean;
}

/**
 * A shop closed behind its password (ADR-054), as a request finds it: what the password page
 * checks and says, and whether this shopper may see the shop anyway, having given the password,
 * or being its staff in a preview.
 */
interface Lock {
  password: { verifier: string; message: string };
  passed: boolean;
}

/** The most sections the editor has rendered at once, and files it sends over the theme's. */
const EDITOR_SECTIONS_MAX = 5;
const EDITOR_FILES_MAX = 50;

/**
 * What the theme editor asks to have rendered (ADR-050): a path on the shop, the sections of its
 * page, and the theme's files it has not saved; null when the body is not that.
 */
function editorAsk(
  body: unknown,
): { page: string; sections: string[]; files: Record<string, string> } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { page, sections, files } = body as Record<string, unknown>;
  if (typeof page !== 'string' || !/^\/(?!\/)/.test(page) || page.length > 2_000) return null;
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > EDITOR_SECTIONS_MAX)
    return null;
  if (!sections.every((id) => typeof id === 'string' && SECTION_ID.test(id))) return null;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return null;
  const entries = Object.entries(files);
  if (entries.length > EDITOR_FILES_MAX) return null;
  if (!entries.every(([, source]) => typeof source === 'string')) return null;
  return { page, sections, files: Object.fromEntries(entries) as Record<string, string> };
}

/**
 * The cookie that keeps a preview link's token until the link ends; a null token forgets it. In
 * the theme editor's frame it is the frame's alone (`Partitioned`), and sent there though the
 * editor is another site, as in development (ADR-050).
 */
function previewCookie(
  token: string | null,
  seconds: number,
  options: { secure: boolean; framed: boolean },
): string {
  const attributes = options.framed
    ? 'Path=/; SameSite=None; Secure; Partitioned; HttpOnly'
    : `Path=/; SameSite=Lax; HttpOnly${options.secure ? '; Secure' : ''}`;
  return token === null
    ? `${PREVIEW_COOKIE}=; Max-Age=0; ${attributes}`
    : `${PREVIEW_COOKIE}=${token}; Max-Age=${Math.max(seconds, 0)}; ${attributes}`;
}

/**
 * An answer showing a preview: the shopper's own, never kept, not for search engines, and framed
 * only by the theme editor.
 */
function previewedAnswer(reply: FastifyReply, editorOrigins: readonly string[]): FastifyReply {
  const ancestors = editorOrigins.length > 0 ? editorOrigins.join(' ') : "'none'";
  return reply
    .header('cache-control', PREVIEWED)
    .header('x-robots-tag', 'noindex')
    .header('content-security-policy', `frame-ancestors ${ancestors}`);
}

/**
 * Shops' themes, each laid over the platform theme once per version and kept for the pages after,
 * the least recently used let go first once their files pass `maxBytes`. A shop's document names
 * the version to show; the theme's document is fetched only when that one is not at hand.
 */
export class ShopThemes {
  readonly #themes = new Map<string, { theme: Theme; bytes: number }>();
  readonly #loading = new Map<string, Promise<Theme>>();
  #bytes = 0;

  constructor(
    private readonly base: Theme,
    private readonly options: {
      maxBytes?: number;
      onRejected?: (shopId: string, error: ThemeError) => void;
    } = {},
  ) {}

  /** The theme `shop`'s pages are rendered with: its own, or the platform theme. */
  async for(shopId: string, shop: ShopDoc, store: StoreData): Promise<Theme> {
    // Documents written before shops had themes have none.
    const wanted = shop.theme ?? null;
    if (!wanted) return this.base;
    const key = `${shopId}:${wanted.id}:${wanted.version}`;
    const kept = this.#kept(key);
    if (kept) return kept;
    let loading = this.#loading.get(key);
    if (!loading) {
      loading = this.#load(shopId, wanted, store, key).finally(() => this.#loading.delete(key));
      this.#loading.set(key, loading);
    }
    return loading;
  }

  async #load(
    shopId: string,
    wanted: { id: string; version: number },
    store: StoreData,
    key: string,
  ): Promise<Theme> {
    const doc = await store.theme();
    if (!doc) return this.base;
    // Written since the shop's document was read, or not yet: shown, but not kept as the version
    // the shop's document names.
    if (doc.id !== wanted.id || doc.version !== wanted.version) return this.#overlay(shopId, doc);
    return this.#keep(shopId, key, doc);
  }

  /**
   * A theme a preview link shows (ADR-049), from the core's copy of its files: laid over the
   * platform theme once per version, and kept with main themes.
   */
  preview(shopId: string, doc: ThemeDoc): Theme {
    const key = `${shopId}:${doc.id}:${doc.version}`;
    return this.#kept(key) ?? this.#keep(shopId, key, doc);
  }

  /** The theme kept under `key`, now the most recently used. */
  #kept(key: string): Theme | null {
    const kept = this.#themes.get(key);
    if (!kept) return null;
    // Last in the map is the most recently used, so the first is the one to let go.
    this.#themes.delete(key);
    this.#themes.set(key, kept);
    return kept.theme;
  }

  #overlay(shopId: string, doc: ThemeDoc): Theme {
    return overlayTheme(this.base, doc.files, (error) => this.options.onRejected?.(shopId, error));
  }

  /** `doc` laid over the platform theme, and kept as `key` while there is room. */
  #keep(shopId: string, key: string, doc: ThemeDoc): Theme {
    const theme = this.#overlay(shopId, doc);
    const bytes = Object.values(doc.files).reduce((sum, source) => sum + source.length, 0);
    const maxBytes = this.options.maxBytes ?? 64 * 1024 * 1024;
    if (bytes > maxBytes) return theme;
    this.#themes.set(key, { theme, bytes });
    this.#bytes += bytes;
    for (const [oldest, { bytes: size }] of this.#themes) {
      if (this.#bytes <= maxBytes) break;
      this.#themes.delete(oldest);
      this.#bytes -= size;
    }
    return theme;
  }
}

/**
 * Renders the sample shop's pages once, a page of each template in both languages: the first
 * render parses the theme and runs the renderer's code for the first time, which is slow enough
 * to put a section over its time limit on a busy machine. Before listening, it spares the first
 * visitors that.
 */
export async function warmUp(renderer: PageRenderer): Promise<void> {
  const documents = sampleStore();
  const store = new MemoryStore(documents);
  const requests: PageRequest[] = [
    { path: '/' },
    { path: '/', locale: 'ur' },
    { path: `/collections/${documents.collections[0]!.handle}` },
    { path: `/products/${documents.products[0]!.handle}` },
    { path: '/cart', cart: null },
    {
      path: '/search',
      query: { q: 'lawn' },
      search: { terms: 'lawn', productIds: documents.products.slice(0, 4).map((p) => p.id) },
    },
    { path: `/pages/${documents.pages![0]!.handle}` },
    { path: '/pages/none' },
  ];
  for (const request of requests) await renderer.render(request, store.fresh());
  const suggest = suggestParams(new URLSearchParams({ q: 'lawn' }));
  const productIds = documents.products.slice(0, 20).map((p) => p.id);
  await renderer.sections(
    { path: '/search', suggest: { params: suggest, productIds } },
    store.fresh(),
    ['predictive-search'],
  );
}

/**
 * The storefront's HTTP server: each request's host names a shop, whose documents the page is
 * rendered from, and sent as it is written. Urdu pages are under /ur/. It warms up before it
 * listens.
 */
export function createStorefrontServer(options: StorefrontServerOptions): FastifyInstance {
  const { theme, renderer, domain, redis, sample } = options;
  const keys = options.keys ?? new StorefrontKeys();
  const directory = redis ? new ShopDirectory(redis, keys) : null;
  const shops = directory ? new ShopResolver(directory) : null;
  // Shops' own domains (ADR-048), found as handles are.
  const domainShops = directory
    ? new ShopResolver({ find: (host) => directory.findDomain(host) })
    : null;
  const themes = new ShopThemes(theme, { onRejected: options.onThemeFileRejected });
  const limiter = redis ? new RateLimiter(redis, keys.rateLimits()) : null;
  const core = options.core;
  const secure = options.secureCookies ?? false;
  const editorOrigins = options.editorOrigins ?? [];
  const previewed = (reply: FastifyReply) => previewedAnswer(reply, editorOrigins);
  const app = Fastify({ trustProxy: options.trustProxy ?? false });
  app.addHook('onReady', () => warmUp(renderer));
  // An answer that sets a cookie is the shopper's own, whatever its handler said: never kept.
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.hasHeader('set-cookie') && /^public/.test(String(reply.getHeader('cache-control')))) {
      reply.header('cache-control', 'private, no-store').removeHeader('cache-tag');
    }
    // A shop closed behind its password (ADR-054): nothing is kept at the edge, which would show
    // it to everyone, or indexed, while it is closed.
    if (await locks.get(request)?.catch(() => null)) {
      reply
        .header('cache-control', 'private, no-store')
        .header('x-robots-tag', 'noindex')
        .removeHeader('cache-tag');
    }
    return payload;
  });
  // Shopify's cart forms post as forms; its Ajax cart, as forms or JSON.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_request, body, done) => done(null, parseForm(body as string)),
  );

  /**
   * The theme a preview link shows here (ADR-049), from `?preview=` or the cookie it leaves, as
   * the core has it saved now: null when there is none, or the link shows none any more, whose
   * cookie then goes. `?preview=` with nothing ends a preview.
   */
  const previewFor = async (
    request: FastifyRequest,
    reply: FastifyReply,
    shopId: string,
  ): Promise<Preview | null> => {
    const asked = (request.query as Record<string, unknown> | undefined)?.preview;
    const kept = cookieOf(request.headers.cookie, PREVIEW_COOKIE);
    const token = typeof asked === 'string' ? asked : kept;
    const cookie = { secure, framed: request.headers['sec-fetch-dest'] === 'iframe' };
    const forget = () => {
      if (kept !== null) reply.header('set-cookie', previewCookie(null, 0, cookie));
      return null;
    };
    if (!token || !core || !PREVIEW_TOKEN.test(token)) return forget();
    let found: ThemePreviewResponse | null;
    try {
      found = await core.themePreview(shopId, token);
    } catch (error) {
      // The core cannot say what the link shows just now: the shop's own theme, until it can.
      request.log.warn({ err: error }, 'theme preview not reached');
      return null;
    }
    if (!found) return forget();
    if (token !== kept) {
      const seconds = Math.floor((Date.parse(found.expiresAt) - Date.now()) / 1000);
      reply.header('set-cookie', previewCookie(token, seconds, cookie));
    }
    return { name: found.theme.name, theme: themes.preview(shopId, found.theme) };
  };

  /**
   * The shop a request's host names, by its handle or as a domain of the shop's own, the
   * documents its pages are made from, and the theme a preview link shows there, if any; null if
   * no shop answers.
   */
  const requestShops = new WeakMap<FastifyRequest, Promise<Found | null>>();
  /** Found once a request: its hooks and its handler ask. */
  const shopFor = (request: FastifyRequest, reply: FastifyReply): Promise<Found | null> => {
    let shop = requestShops.get(request);
    if (!shop) {
      shop = findShop(request, reply);
      requestShops.set(request, shop);
    }
    return shop;
  };
  const findShop = async (request: FastifyRequest, reply: FastifyReply): Promise<Found | null> => {
    const host = request.headers.host ?? '';
    const handle = handleOf(host, domain);
    let found: { shopId: string; store: StoreData } | null = null;
    if (handle === null) {
      found = sample ? { shopId: 'sample', store: sample.fresh() } : null;
    } else if (shops && domainShops && redis) {
      const shopId =
        handle === undefined ? await domainShops.find(hostName(host)) : await shops.find(handle);
      found = shopId ? { shopId, store: new RedisStore(redis, shopId, keys) } : null;
    }
    if (!found) return null;
    const preview = await previewFor(request, reply, found.shopId);
    // Framed, a preview is in the theme editor, which alone may frame it.
    const framed = request.headers['sec-fetch-dest'] === 'iframe';
    return { ...found, preview, editor: preview !== null && framed && editorOrigins.length > 0 };
  };

  const locks = new WeakMap<FastifyRequest, Promise<Lock | null>>();
  /** The request's shop's lock, if it is closed behind its password (ADR-054); worked out once. */
  const lockOf = (request: FastifyRequest, shop: Found): Promise<Lock | null> => {
    let lock = locks.get(request);
    if (!lock) {
      lock = (async () => {
        let doc: ShopDoc;
        try {
          doc = await shop.store.shop();
        } catch (error) {
          // Not published: the handler says so.
          if (error instanceof StoreMissingError) return null;
          throw error;
        }
        if (!doc.password) return null;
        const pass = cookieOf(request.headers.cookie, PASSWORD_COOKIE);
        // Its staff see it as it will be, through a preview.
        const passed =
          shop.preview !== null ||
          (pass !== null && isPasswordPass(pass, shop.shopId, doc.password.verifier));
        return { password: doc.password, passed };
      })();
      locks.set(request, lock);
    }
    return lock;
  };

  // A shop closed behind its password shows shoppers without it nothing but the password page:
  // a page sends them there, and a script is told the shop is not open.
  app.addHook('preHandler', async (request, reply) => {
    if (OPEN_ROUTES.has(request.routeOptions.url ?? '')) return;
    const shop = await shopFor(request, reply);
    const lock = shop && (await lockOf(request, shop));
    if (!lock || lock.passed) return;
    const url = new URL(request.url, 'http://storefront');
    const urdu = url.pathname === '/ur' || url.pathname.startsWith('/ur/');
    reply.header('cache-control', 'private, no-store');
    const page =
      (request.method === 'GET' || request.method === 'HEAD') &&
      !fromScript(request) &&
      !asksForSections(url) &&
      !/\.(js|json)$/.test(url.pathname);
    if (page) return reply.redirect(urdu ? '/ur/password' : '/password', 302);
    return reply.code(401).type('text/plain; charset=utf-8').send('This shop is not open yet.\n');
  });

  /** The theme the shop's pages are rendered in: the one previewed, else its main theme. */
  const themeFor =
    (shop: Found) =>
    (doc: ShopDoc): Theme | Promise<Theme> =>
      shop.preview?.theme ?? themes.for(shop.shopId, doc, shop.store);

  /**
   * The shop's address, as search engines are told it (OS-09): its primary domain, else its
   * handle's subdomain; the request's own where the renderer knows neither, as in tests.
   */
  const originOf = async (request: FastifyRequest, found: Found): Promise<string> =>
    renderer.shopUrl(await found.store.shop()) ||
    `${secure ? 'https' : 'http'}://${request.headers.host ?? ''}`;
  const languages = { locales: [...theme.locales.keys()], defaultLocale: theme.defaultLocale };

  /** What crawlers read: kept at the edge for an hour, and forgotten with the shop's document. */
  const crawlers = async (
    request: FastifyRequest,
    reply: FastifyReply,
    type: string,
    body: (found: Found, origin: string) => Promise<string | null>,
  ) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    try {
      const sent = await body(found, await originOf(request, found));
      if (sent === null) return await notFound(reply, 'The shop has no such sitemap.');
      return await reply
        .header('cache-control', CRAWLER_CACHE)
        .header('cache-tag', shopTag(found.shopId))
        .type(type)
        .send(sent);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      throw error;
    }
  };

  app.get('/robots.txt', (request, reply) =>
    crawlers(request, reply, 'text/plain; charset=utf-8', async (found, origin) =>
      // Closed behind its password: nothing to crawl yet.
      (await lockOf(request, found))
        ? 'User-agent: *\nDisallow: /\n'
        : robotsTxt(origin, languages),
    ),
  );

  /** The index of the shop's sitemaps, one for each 5,000 of its products, collections or pages. */
  app.get('/sitemap.xml', (request, reply) =>
    crawlers(request, reply, 'application/xml; charset=utf-8', async (found, origin) => {
      const counts = await Promise.all(
        SITEMAP_KINDS.map(async (kind) => [kind, (await found.store.handles(kind)).length]),
      );
      return sitemapIndex(origin, Object.fromEntries(counts));
    }),
  );

  app.get('/sitemaps/:name', (request, reply) =>
    crawlers(request, reply, 'application/xml; charset=utf-8', async (found, origin) => {
      const asked = sitemapOf((request.params as { name: string }).name);
      if (!asked) return null;
      // In the same order each time, so a handle stays in its file.
      const handles = (await found.store.handles(asked.kind)).sort();
      if (asked.page > Math.max(sitemapPages(handles.length), 1)) return null;
      return sitemapPage(origin, asked.kind, handles, asked.page, languages);
    }),
  );

  app.get('/assets/:version/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    const source = theme.files[`assets/${file}`];
    if (source === undefined) return reply.code(404).send();
    const type = file.endsWith('.css') ? 'text/css' : 'application/javascript';
    return reply.type(`${type}; charset=utf-8`).header('cache-control', ASSET_CACHE).send(source);
  });

  if (options.placeholders) {
    app.get('/images/*', async (request, reply) => {
      const path = (request.params as { '*': string })['*'];
      const hue = createHash('sha256').update(path).digest()[0]! * 1.4;
      const [width, height] = path.startsWith('banners/') ? [5, 3] : [4, 5];
      const label = path
        .split('/')
        .at(-1)!
        .replace(/\.\w+$/, '')
        .replace(/-/g, ' ')
        .slice(0, 28);
      return reply
        .type('image/svg+xml')
        .header('cache-control', 'public, max-age=86400')
        .send(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width * 100} ${height * 100}">` +
            `<rect width="100%" height="100%" fill="hsl(${hue} 45% 78%)"/>` +
            `<text x="50%" y="50%" text-anchor="middle" font-family="sans-serif" font-size="14" ` +
            `fill="hsl(${hue} 40% 30%)">${label}</text></svg>`,
        );
    });
  }

  /**
   * Sends the shopper to a new checkout of the cart `token` names, on the shop's own address; or
   * to the cart again when it has nothing to order.
   */
  const toCheckout = async (
    reply: FastifyReply,
    shopId: string,
    token: string | null,
    urdu: boolean,
  ) => {
    if (!core) throw new StorefrontApiError(503, 'This storefront keeps no carts');
    const started = await core.startCheckout(shopId, token);
    return reply.redirect(started.ok ? started.path : `${urdu ? '/ur' : ''}/cart`, 303);
  };

  /** The core could not be reached, as when it restarts: said so, rather than failing. */
  const unreachable = (request: FastifyRequest, error: unknown): boolean => {
    if (!(error instanceof StorefrontApiError) && !isNetworkError(error)) return false;
    request.log.warn({ err: error }, 'core not reached');
    return true;
  };

  /**
   * A page of the shop's, sent as it is written: the head goes while the sections render. A page
   * showing a preview is the shopper's alone, with a bar that names the theme.
   */
  const sendPage = async (
    reply: FastifyReply,
    request: PageRequest,
    shop: Found,
    status?: number,
    /**
     * The request, for a page that sends shoppers on: to the shop's primary domain, or where the
     * shop's URL redirect from its path points.
     */
    asked?: FastifyRequest,
  ) => {
    const preview = shop.preview && { name: shop.preview.name };
    const editor = shop.editor ? { origins: editorOrigins } : null;
    const ready = await renderer.prepare(
      { ...request, preview, editor },
      shop.store,
      themeFor(shop),
    );
    // Asked for at another of the shop's addresses: the same page at its primary domain, which
    // renders there (ADR-048). A preview stays where its link opened it.
    const host = asked?.headers.host ?? '';
    if (asked && !preview && ready.domain !== '' && hostName(host) !== ready.domain) {
      const port = secure ? '' : (/:\d+$/.exec(host)?.[0] ?? '');
      const to = `${secure ? 'https' : 'http'}://${ready.domain}${port}${asked.url}`;
      return reply.header('cache-control', PAGE_CACHE).redirect(to, 301);
    }
    // Nothing at the path: the shop may send shoppers on from it (ADR-052). The editor shows its
    // 404 page, to change it.
    const notFoundAt =
      ready.status === 404 && status === undefined ? redirectKey(request.path) : null;
    if (notFoundAt !== null && asked && !editor) {
      const target = await shop.store.redirect(notFoundAt);
      if (target !== null) {
        if (preview) previewed(reply);
        else {
          reply
            .header('cache-control', PAGE_CACHE)
            .header('cache-tag', cacheTags(shop.shopId, ready.named, notFoundAt));
        }
        return reply.redirect(redirectedTo(target, request.locale === 'ur', asked.url), 301);
      }
    }
    const page = ready.stream();
    // Kept at the edge by the documents it names, unless a handler said otherwise (ADR-047).
    if (preview) previewed(reply);
    else if (!reply.hasHeader('cache-control')) reply.header('cache-control', PAGE_CACHE);
    if (String(reply.getHeader('cache-control')).startsWith('public')) {
      reply.header('cache-tag', cacheTags(shop.shopId, page.named, notFoundAt));
    }
    return reply
      .code(status ?? page.status)
      .type('text/html; charset=utf-8')
      .send(Readable.from(page.body));
  };

  /**
   * Sections of `page`, as Shopify's section rendering API gives them: each by its ID, rendered
   * with the shopper's cart, or null when neither the page nor the theme has it.
   */
  const sectionsOf = async (
    shop: Found,
    page: URL,
    ids: readonly string[],
    cart: CartJson | null,
    /** The theme editor's, with the theme it has unsaved over the one previewed. */
    editing?: { theme: Theme },
  ): Promise<Record<string, string | null>> => {
    if (ids.length === 0) return {};
    const urdu = page.pathname === '/ur' || page.pathname.startsWith('/ur/');
    const request: PageRequest = {
      path: urdu ? page.pathname.slice(3) || '/' : page.pathname,
      query: Object.fromEntries(page.searchParams),
      locale: urdu ? 'ur' : 'en',
      cart,
      editor: editing ? { origins: editorOrigins } : null,
    };
    const theme = editing ? () => editing.theme : themeFor(shop);
    const rendered = await renderer.sections(request, shop.store, ids, theme);
    return Object.fromEntries(ids.map((id) => [id, rendered.get(id) ?? null]));
  };

  /**
   * Sections rendered for the theme editor (ADR-050): `POST /editor/sections` with
   * `{ page, sections, files }` renders those sections of that page in design mode, with the
   * theme's files the editor has not saved over the previewed theme's, and says what in them the
   * storefront could not use. Only the editor's script asks: a preview of the shop's, its own
   * header, and a request from the page itself.
   */
  app.post('/editor/sections', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const refuse = (status: number, message: string) => reply.code(status).send({ message });
    if (
      !found.preview ||
      editorOrigins.length === 0 ||
      request.headers['x-hatti-editor'] !== '1' ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      return refuse(403, 'Only the theme editor renders settings it has not saved, in a preview.');
    }
    const asked = editorAsk(request.body);
    if (!asked) {
      return refuse(
        400,
        `Send { page, sections, files }: a path on the shop, up to ${EDITOR_SECTIONS_MAX} ` +
          `section IDs, and up to ${EDITOR_FILES_MAX} of the theme's files by name.`,
      );
    }
    // Over the previewed theme as saved, so a file the storefront cannot use leaves the saved one.
    const problems: string[] = [];
    const edited = overlayTheme(found.preview.theme, asked.files, (error) =>
      problems.push(error.message),
    );
    try {
      const token = cookieOf(request.headers.cookie, CART_COOKIE);
      const cart = token && core ? await core.read(found.shopId, token) : null;
      const page = new URL(asked.page, 'http://storefront');
      const sections = await sectionsOf(found, page, asked.sections, cart, { theme: edited });
      return await reply.send({ sections, problems });
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return refuse(503, 'The cart cannot be reached just now. Please try again in a minute.');
    }
  });

  /**
   * Shopify's section rendering API on a page: `?section_id=` gives one of the page's sections as
   * HTML, `?sections=` up to five as JSON, rendered with the shopper's cart, so never kept.
   */
  const sendSections = async (
    reply: FastifyReply,
    shop: Found,
    url: URL,
    cart: CartJson | null,
  ) => {
    const one = url.searchParams.get('section_id');
    const ids =
      one === null
        ? sectionIdsOf(url.searchParams.get('sections'))
        : SECTION_ID.test(one)
          ? [one]
          : [];
    const page = new URL(`${url.pathname}${url.search}`, 'http://storefront');
    page.searchParams.delete('section_id');
    page.searchParams.delete('sections');
    const rendered = await sectionsOf(shop, page, ids, cart);
    reply.header('cache-control', 'private, no-store');
    if (one === null) return reply.send(rendered);
    const html = ids[0] === undefined ? null : rendered[ids[0]];
    if (!html) return notFound(reply, 'The theme has no such section.');
    return reply.type('text/html; charset=utf-8').send(html);
  };

  /**
   * The cart (ADR-042): `/cart` shows it and `/cart.js` gives it to scripts; `/cart/add`,
   * `/change`, `/update` and `/clear` change it, as Shopify's do, through the core. A form is
   * sent back to the cart page, a script gets JSON. Changes come from the shop's own pages, at
   * most {@link CART_CHANGES} a minute from an address.
   */
  const cart = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const url = new URL(request.url, 'http://storefront');
    const urdu = url.pathname.startsWith('/ur/');
    const locale = urdu ? 'ur' : 'en';
    const path = urdu ? url.pathname.slice(3) : url.pathname;
    const route = cartRoute(path);
    if (!route) return sendPage(reply, { path, locale }, found);
    const json = route.json || fromScript(request);
    const token = cookieOf(request.headers.cookie, CART_COOKIE);
    const words = (key: string, values: Record<string, unknown>) =>
      translation(theme, locale, key, values);
    const refuse = (status: number, message: string) =>
      json
        ? reply.code(status).send(ajaxError(status, message))
        : reply.code(status).type('text/plain; charset=utf-8').send(`${message}\n`);
    /** The cookies that keep the cart the shopper has now: none once it names no cart. */
    const keep = (kept: string | null, shown: CartJson | null) => {
      if (kept !== null || token !== null) {
        reply.header('set-cookie', cartCookies(kept, shown?.itemCount ?? 0, { secure }));
      }
    };
    reply.header('cache-control', 'private, no-store');
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const reading = method === 'GET' && route.action === 'show';
    // Themes' remove links (`line_item.url_to_remove`) change the cart by GET.
    if (!reading && method !== 'POST' && route.action !== 'change') {
      return reply.code(405).header('allow', 'POST').send();
    }
    try {
      if (reading) {
        const shown = token && core ? await core.read(found.shopId, token) : null;
        if (core) keep(shown ? token : null, shown);
        if (asksForSections(url)) return await sendSections(reply, found, url, shown);
        if (json) return await reply.send(await ajax(shown, found.store));
        return await sendPage(reply, { path: '/cart', locale, cart: shown }, found);
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') {
        return await refuse(403, 'Carts change from the shop itself.');
      }
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no carts');
      if (limiter && !(await limiter.hit(CART_CHANGES, request.ip)).allowed) {
        return await refuse(429, 'Too many changes to the cart. Please wait a moment.');
      }
      const action = route.action === 'show' ? 'update' : route.action;
      const params = method === 'GET' ? parseForm(url.search.slice(1)) : paramsOf(request);
      const { body, single } = cartBody(action, params);
      const result = await core.act(found.shopId, token, action, body);
      if (!result.ok) {
        const message = cartErrorMessage(result.error, words);
        const status = cartErrorStatus(result.error);
        if (json) return await reply.code(status).send(ajaxError(status, message));
        // The cart page again, saying why, as the cart is.
        const shown = token ? await core.read(found.shopId, token) : null;
        const page = { path: '/cart', locale, cart: shown, cartError: message };
        return await sendPage(reply, page, found, status);
      }
      keep(result.token, result.cart);
      // The cart form's checkout button: its quantities and note saved, on to checkout.
      if (!json && route.action === 'show' && params.checkout !== undefined) {
        return await toCheckout(reply, found.shopId, result.token, urdu);
      }
      if (!json) return await reply.redirect(returnTo(params) ?? `${urdu ? '/ur' : ''}/cart`, 303);
      // Shopify's bundled section rendering: the sections asked for, with the cart as it is now.
      const asked = sectionIdsOf(params.sections);
      const withSections = async (answer: Record<string, unknown>) =>
        asked.length === 0
          ? answer
          : {
              ...answer,
              sections: await sectionsOf(found, sectionsPage(params, request), asked, result.cart),
            };
      if (action !== 'add') {
        return await reply.send(await withSections(await ajax(result.cart, found.store)));
      }
      const products = await cartProducts(result.cart, (ids) => found.store.products(ids));
      const added = result.added.flatMap((key) => {
        const line = result.cart.items.find((item) => item.key === key);
        return line ? [ajaxLineItem(line, products.get(line.productId))] : [];
      });
      return await reply.send(await withSections(single ? (added[0] ?? {}) : { items: added }));
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return refuse(503, 'Your cart cannot be reached just now. Please try again in a minute.');
    }
  };
  for (const path of ['/cart', '/cart.js', '/cart.json', '/cart/:action']) {
    app.route({ method: ['GET', 'POST'], url: path, handler: cart });
    app.route({ method: ['GET', 'POST'], url: `/ur${path}`, handler: cart });
  }

  /**
   * `/checkout`, as Shopify has it, for themes' checkout links and `return_to`: a new checkout of
   * the shopper's cart, or the cart again when it has nothing to order.
   */
  const checkout = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    reply.header('cache-control', 'private, no-store');
    const urdu = request.url.startsWith('/ur/');
    const token = cookieOf(request.headers.cookie, CART_COOKIE);
    try {
      if (token && limiter && !(await limiter.hit(CART_CHANGES, request.ip)).allowed) {
        return await tooMany(reply);
      }
      return await toCheckout(reply, found.shopId, token, urdu);
    } catch (error) {
      if (!unreachable(request, error)) throw error;
      return unavailable(reply);
    }
  };
  for (const path of ['/checkout', '/ur/checkout']) {
    app.route({ method: ['GET', 'POST'], url: path, handler: checkout });
  }

  /**
   * A checkout's page (ADR-044), on the shop's own address: the core renders it, for this shop's
   * checkouts only, and the storefront sends it. Placing the order empties the cart, so the count
   * pages show goes to 0.
   */
  const checkoutPage = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const { token } = request.params as { token: string };
    const posted = request.method === 'POST';
    reply.header('cache-control', 'no-store');
    try {
      if (!core) throw new StorefrontApiError(503, 'This storefront keeps no carts');
      if (posted && request.headers['sec-fetch-site'] === 'cross-site') {
        return await reply
          .code(403)
          .type('text/plain; charset=utf-8')
          .send('Orders are placed from the shop itself.\n');
      }
      if (posted && limiter && !(await limiter.hit(CART_CHANGES, request.ip)).allowed) {
        return await tooMany(reply);
      }
      const form = posted ? textFields(paramsOf(request)) : null;
      const page = await core.checkoutPage(found.shopId, token, form);
      if (page.placed) {
        reply.header('set-cookie', cartCountCookie(0, { secure }));
        return await reply.redirect(checkoutPagePath(token), 303);
      }
      return await reply.code(page.status).headers(page.headers).send(page.html);
    } catch (error) {
      if (!unreachable(request, error)) throw error;
      return unavailable(reply);
    }
  };
  app.route({ method: ['GET', 'POST'], url: '/checkouts/:token', handler: checkoutPage });

  /** Whether the address has asked for more searches this minute than {@link SEARCHES} allows. */
  const searchedTooMuch = async (request: FastifyRequest): Promise<boolean> =>
    limiter !== null && !(await limiter.hit(SEARCHES, request.ip)).allowed;

  /**
   * Search (ADR-046): `/search?q=` finds the shop's products through the core, and the theme's
   * search page shows them, a page at a time. Without words, the page asks for some. With
   * Shopify's `options[prefix]=last`, the last word may be cut short.
   */
  const search = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const url = new URL(request.url, 'http://storefront');
    const urdu = url.pathname.startsWith('/ur/');
    const query = Object.fromEntries(url.searchParams);
    const terms = (query.q ?? '').trim().slice(0, SEARCH_TERMS_MAX);
    let productIds: string[] = [];
    try {
      if (terms !== '') {
        if (!core) throw new StorefrontApiError(503, 'This storefront has no search');
        if (await searchedTooMuch(request)) {
          return await reply
            .code(429)
            .header('cache-control', 'no-store')
            .type('text/plain; charset=utf-8')
            .send('Too many searches. Please wait a moment.\n');
        }
        const prefix = query['options[prefix]'] === 'last' ? 'last' : 'none';
        productIds = await core.search(found.shopId, terms, { prefix });
      }
      const page = {
        path: '/search',
        query,
        locale: urdu ? 'ur' : 'en',
        search: { terms, productIds },
      };
      reply.header('cache-control', SEARCH_CACHE);
      return await sendPage(reply, page, found, undefined, request);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return reply
        .code(503)
        .header('cache-control', 'no-store')
        .type('text/plain; charset=utf-8')
        .send('Search cannot be reached just now. Please try again in a minute.\n');
    }
  };
  for (const path of ['/search', '/ur/search']) app.get(path, search);

  /**
   * Predictive search (ADR-046), as Shopify's: the products that could be what a shopper is
   * typing, the last word taken as cut short. `/search/suggest.json?q=` gives them as JSON;
   * `/search/suggest?q=&section_id=` renders that section of the theme's with them, as
   * `predictive_search`, for a script to show under a search box.
   */
  const suggest = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const url = new URL(request.url, 'http://storefront');
    const json = url.pathname.endsWith('.json');
    const sectionId = url.searchParams.get('section_id') ?? '';
    if (!json && !SECTION_ID.test(sectionId)) {
      return notFound(reply, 'Ask for the section to render: ?section_id=');
    }
    const params = suggestParams(url.searchParams);
    const wanted = suggestWanted(params);
    const refuse = (status: number, message: string, description: string) => {
      reply.code(status).header('cache-control', 'no-store');
      return json
        ? reply.send({ status, message, description })
        : reply.type('text/plain; charset=utf-8').send(`${description}\n`);
    };
    try {
      let productIds: string[] = [];
      if (wanted > 0) {
        if (!core) throw new StorefrontApiError(503, 'This storefront has no search');
        if (await searchedTooMuch(request)) {
          return await refuse(429, 'Too Many Requests', 'Too many searches. Please wait a moment.');
        }
        productIds = await core.search(found.shopId, params.terms, {
          prefix: 'last',
          limit: wanted,
        });
      }
      if (found.preview) previewed(reply);
      else reply.header('cache-control', SEARCH_CACHE).header('cache-tag', shopTag(found.shopId));
      if (json) {
        const docs = suggestedProducts(await found.store.products(productIds), params);
        return await reply.send(suggestJson(params, docs));
      }
      const page: PageRequest = {
        path: '/search',
        query: Object.fromEntries(url.searchParams),
        locale: url.pathname.startsWith('/ur/') ? 'ur' : 'en',
        suggest: { params, productIds },
      };
      const rendered = await renderer.sections(page, found.store, [sectionId], themeFor(found));
      const html = rendered.get(sectionId);
      if (!html) return notFound(reply, 'The theme has no such section.');
      return await reply.type('text/html; charset=utf-8').send(html);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return refuse(
        503,
        'Service Unavailable',
        'Search cannot be reached just now. Please try again in a minute.',
      );
    }
  };
  for (const path of ['/search/suggest', '/search/suggest.json']) {
    app.get(path, suggest);
    app.get(`/ur${path}`, suggest);
  }

  /**
   * A closed shop's password page (ADR-054), in the theme's `password` template: the password it
   * is given, when right, leaves a pass in a cookie and sends the shopper in. An open shop, or a
   * shopper with the pass, is sent in; a preview shows the page, to design it.
   */
  const password = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const urdu = request.url.startsWith('/ur/');
    const home = urdu ? '/ur' : '/';
    try {
      const lock = await lockOf(request, found);
      reply.header('cache-control', 'private, no-store');
      if (!found.preview && (!lock || lock.passed)) return await reply.redirect(home, 302);
      const page: PageRequest = { path: '/password', locale: urdu ? 'ur' : 'en' };
      if (request.method === 'POST' && lock) {
        if (limiter && !(await limiter.hit(PASSWORD_TRIES, request.ip)).allowed) {
          return await reply
            .code(429)
            .type('text/plain; charset=utf-8')
            .send('Too many tries. Please wait a minute.\n');
        }
        const typed = paramsOf(request).password;
        const verifier = lock.password.verifier;
        // No password is longer: nothing longer is worth scrypt's time.
        const given = typeof typed === 'string' && typed.length <= PASSWORD_TYPED_MAX;
        if (given && (await checkPassword(typed, verifier))) {
          reply.header(
            'set-cookie',
            passwordCookie(passwordPass(found.shopId, verifier), { secure }),
          );
          return await reply.redirect(home, 303);
        }
        const wrong = { ...page, formErrors: { storefront_password: ['form'] } };
        return await sendPage(reply, wrong, found, 401);
      }
      return await sendPage(reply, page, found);
    } catch (error) {
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      throw error;
    }
  };
  for (const path of ['/password', '/ur/password']) {
    app.route({ method: ['GET', 'POST'], url: path, handler: password });
  }

  app.get('/*', async (request, reply) => {
    const found = await shopFor(request, reply);
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const url = new URL(request.url, 'http://storefront');
    const urdu = url.pathname === '/ur' || url.pathname.startsWith('/ur/');
    const path = urdu ? url.pathname.slice(3) || '/' : url.pathname;
    try {
      if (asksForSections(url)) {
        // With the shopper's cart, as a drawer shows it: cookies naming no cart go.
        const token = cookieOf(request.headers.cookie, CART_COOKIE);
        const shown = token && core ? await core.read(found.shopId, token) : null;
        if (token && core && !shown) {
          reply.header('set-cookie', cartCookies(null, 0, { secure }));
        }
        return await sendSections(reply, found, url, shown);
      }
      const query = Object.fromEntries(url.searchParams);
      return await sendPage(
        reply,
        { path, query, locale: urdu ? 'ur' : 'en' },
        found,
        undefined,
        request,
      );
    } catch (error) {
      // Named in the directory, but its documents are gone: it is being published again.
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      if (!unreachable(request, error)) throw error;
      return reply
        .code(503)
        .header('cache-control', 'no-store')
        .type('text/plain; charset=utf-8')
        .send('Your cart cannot be reached just now. Please try again in a minute.\n');
    }
  });

  return app;
}

/** The cart as `/cart.js` gives it, with its lines' products. */
async function ajax(cart: CartJson | null, store: StoreData): Promise<Record<string, unknown>> {
  return ajaxCart(cart, await cartProducts(cart, (ids) => store.products(ids)));
}

/** Shopify's Ajax cart error. */
function ajaxError(status: number, description: string) {
  return { status, message: 'Cart Error', description };
}

/** The text fields of a posted form. */
function textFields(params: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function tooMany(reply: FastifyReply) {
  return reply
    .code(429)
    .type('text/plain; charset=utf-8')
    .send('Too many changes to the cart. Please wait a moment.\n');
}

function unavailable(reply: FastifyReply) {
  return reply
    .code(503)
    .type('text/plain; charset=utf-8')
    .send('Checkout cannot be reached just now. Please try again in a minute.\n');
}

/** Scripts ask for JSON where forms would be sent back to a page. */
function fromScript(request: FastifyRequest): boolean {
  const accept = String(request.headers.accept ?? '');
  return (
    request.headers['x-requested-with'] === 'XMLHttpRequest' ||
    (/application\/(json|javascript)/.test(accept) && !/text\/html/.test(accept))
  );
}

function paramsOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** A request's host as the directory has it: lowercase, without a port or a final dot. */
function hostName(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/** Whether a request asks for sections of a page rather than the page. */
function asksForSections(url: URL): boolean {
  return url.searchParams.has('section_id') || url.searchParams.has('sections');
}

/**
 * The sections a request asks for, as Shopify's `sections`: a list, or IDs with commas between
 * them; the first {@link SECTIONS_MAX} that could be IDs.
 */
function sectionIdsOf(value: unknown): string[] {
  const asked = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const ids = asked.flatMap((id: unknown) =>
    typeof id === 'string' && SECTION_ID.test(id.trim()) ? [id.trim()] : [],
  );
  return [...new Set(ids)].slice(0, SECTIONS_MAX);
}

/**
 * The page a cart change's sections render as part of: `sections_url`, a path on the shop; else
 * the page of the shop's that asked; else the home page.
 */
function sectionsPage(params: Record<string, unknown>, request: FastifyRequest): URL {
  const base = 'http://storefront';
  const asked = params.sections_url;
  if (typeof asked === 'string' && /^\/(?![/\\])/.test(asked)) return new URL(asked, base);
  try {
    const from = new URL(request.headers.referer ?? '');
    if (from.host === request.headers.host) return new URL(`${from.pathname}${from.search}`, base);
  } catch {
    // No page asked, or not an address.
  }
  return new URL('/', base);
}

/** Where a form asked to go afterwards: a path on the shop's own storefront, or nowhere. */
function returnTo(params: Record<string, unknown>): string | null {
  const to = params.return_to;
  return typeof to === 'string' && /^\/(?![/\\])/.test(to) ? to : null;
}

/** The core could not be reached, as when it restarts. */
function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError'))
  );
}

function notFound(reply: FastifyReply, message: string) {
  return reply
    .code(404)
    .header('cache-control', 'no-store')
    .type('text/plain; charset=utf-8')
    .send(`${message}\n`);
}

/**
 * A page's cache tags (ADR-047): the shop's, and those of the documents it names; with the path a
 * 404 page or a redirect was answered at, its tag, for a redirect from it to change (ADR-052).
 */
function cacheTags(shopId: string, named: readonly NamedDocument[], path: string | null): string {
  return [
    shopTag(shopId),
    ...named.map(({ kind, handle }) => handleTag(shopId, kind, handle)),
    ...(path === null ? [] : [pathTag(shopId, path)]),
  ].join(',');
}

/** The prefix of the pages in Urdu (04 §5). */
const URDU_PREFIX = /^\/ur(?=[/?#]|$)/;

/**
 * Where a URL redirect sends a shopper (ADR-052): its target, in the shopper's language when it is
 * a path on the shop, with the query of the address asked for when the target has none, as for a
 * campaign's link, but a preview's token. Characters beyond ASCII are percent-encoded, as a header
 * carries them.
 */
export function redirectedTo(target: string, urdu: boolean, asked: string): string {
  let to = target;
  if (urdu && to.startsWith('/') && !URDU_PREFIX.test(to)) {
    to = to === '/' || /^\/[?#]/.test(to) ? `/ur${to.slice(1)}` : `/ur${to}`;
  }
  const query = (/\?([^#]*)/.exec(asked)?.[1] ?? '')
    .split('&')
    .filter((pair) => pair !== '' && !/^preview(=|$)/.test(pair))
    .join('&');
  if (query !== '' && !to.includes('?')) {
    const hash = to.indexOf('#');
    to = hash === -1 ? `${to}?${query}` : `${to.slice(0, hash)}?${query}${to.slice(hash)}`;
  }
  return to.replace(/[^\x21-\x7e]+/gu, (chars) => encodeURIComponent(chars));
}
