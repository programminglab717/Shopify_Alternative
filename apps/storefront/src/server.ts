import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  MemoryStore,
  RedisStore,
  ShopDirectory,
  StoreMissingError,
  StorefrontKeys,
  type ShopDoc,
  type StoreData,
} from '@hatti/storefront-data';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { sampleStore } from './fixtures.js';
import type { PageRenderer, PageRequest } from './render.js';
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
}

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
    const kept = this.#themes.get(key);
    if (kept) {
      // Last in the map is the most recently used, so the first is the one to let go.
      this.#themes.delete(key);
      this.#themes.set(key, kept);
      return kept.theme;
    }
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
    const theme = overlayTheme(this.base, doc.files, (error) =>
      this.options.onRejected?.(shopId, error),
    );
    // Written since the shop's document was read, or not yet: shown, but not kept as the version
    // the shop's document names.
    if (doc.id !== wanted.id || doc.version !== wanted.version) return theme;
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
    { path: '/pages/none' },
  ];
  for (const request of requests) await renderer.render(request, store.fresh());
}

/**
 * The storefront's HTTP server: each request's host names a shop, whose documents the page is
 * rendered from, and sent as it is written. Urdu pages are under /ur/. It warms up before it
 * listens.
 */
export function createStorefrontServer(options: StorefrontServerOptions): FastifyInstance {
  const { theme, renderer, domain, redis, sample } = options;
  const keys = options.keys ?? new StorefrontKeys();
  const shops = redis ? new ShopResolver(new ShopDirectory(redis, keys)) : null;
  const themes = new ShopThemes(theme, { onRejected: options.onThemeFileRejected });
  const app = Fastify();
  app.addHook('onReady', () => warmUp(renderer));

  /** The shop a host names and the documents its pages are made from; null if none answers. */
  const shopFor = async (host: string): Promise<{ shopId: string; store: StoreData } | null> => {
    const handle = handleOf(host, domain);
    if (handle === null) return sample ? { shopId: 'sample', store: sample.fresh() } : null;
    if (handle === undefined || !shops || !redis) return null;
    const shopId = await shops.find(handle);
    return shopId ? { shopId, store: new RedisStore(redis, shopId, keys) } : null;
  };

  app.get('/assets/:version/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    const source = theme.files[`assets/${file}`];
    if (source === undefined) return reply.code(404).send();
    const type = file.endsWith('.css') ? 'text/css' : 'application/javascript';
    return reply.type(`${type}; charset=utf-8`).send(source);
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
        .send(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width * 100} ${height * 100}">` +
            `<rect width="100%" height="100%" fill="hsl(${hue} 45% 78%)"/>` +
            `<text x="50%" y="50%" text-anchor="middle" font-family="sans-serif" font-size="14" ` +
            `fill="hsl(${hue} 40% 30%)">${label}</text></svg>`,
        );
    });
  }

  app.get('/*', async (request, reply) => {
    const found = await shopFor(request.headers.host ?? '');
    if (!found) return notFound(reply, 'No shop answers at this address.');
    const { shopId, store } = found;
    const url = new URL(request.url, 'http://storefront');
    const urdu = url.pathname === '/ur' || url.pathname.startsWith('/ur/');
    const path = urdu ? url.pathname.slice(3) || '/' : url.pathname;
    try {
      // Sent as it is written: the head goes while the sections render.
      const page = await renderer.stream(
        { path, query: Object.fromEntries(url.searchParams), locale: urdu ? 'ur' : 'en' },
        store,
        (shop) => themes.for(shopId, shop, store),
      );
      return await reply
        .code(page.status)
        .type('text/html; charset=utf-8')
        .send(Readable.from(page.body));
    } catch (error) {
      // Named in the directory, but its documents are gone: it is being published again.
      if (error instanceof StoreMissingError) return notFound(reply, 'This shop is not open yet.');
      throw error;
    }
  });

  return app;
}

function notFound(reply: FastifyReply, message: string) {
  return reply.code(404).type('text/plain; charset=utf-8').send(`${message}\n`);
}
