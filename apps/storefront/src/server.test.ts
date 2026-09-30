import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  BuildQueue,
  MemoryStore,
  ShopDirectory,
  StorefrontKeys,
  type ShopDoc,
  type StoreData,
  type StoreDocuments,
  type ThemeDoc,
} from '@hatti/storefront-data';
import { Redis } from 'ioredis';
import { Parser } from 'liquidjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sampleStore } from './fixtures.js';
import { PageRenderer } from './render.js';
import { createStorefrontServer, handleOf, ShopResolver, ShopThemes } from './server.js';
import { loadTheme, readThemeDir, type Theme } from './theme.js';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

const THEME_DIR = fileURLToPath(new URL('../../../themes/hatti-base', import.meta.url));

/** A home page of a banner with `heading`, as a shop would save it. */
const bannerHome = (heading: string) =>
  JSON.stringify({
    sections: {
      banner: {
        type: 'image-banner',
        blocks: { heading: { type: 'heading', settings: { heading } } },
        block_order: ['heading'],
      },
    },
    order: ['banner'],
  });

describe('Finding the shop a host names', () => {
  it('reads the handle from a subdomain of the platform', () => {
    expect(handleOf('zari.hatti.pk', 'hatti.pk')).toBe('zari');
    expect(handleOf('Zari.Hatti.pk:443', 'hatti.pk')).toBe('zari');
    expect(handleOf('zari-fashions.localhost:4100', 'localhost')).toBe('zari-fashions');
    expect(handleOf('zari.hatti.pk.', 'hatti.pk')).toBe('zari');
    // The platform's own domain, and hosts that are no shop's subdomain.
    expect(handleOf('hatti.pk', 'hatti.pk')).toBeNull();
    expect(handleOf('localhost:4100', 'localhost')).toBeNull();
    for (const host of ['zari.com', 'www.zari.hatti.pk', 'xn--zari.hatti.pk', '-zari.hatti.pk']) {
      expect(handleOf(host, 'hatti.pk'), host).toBeUndefined();
    }
    expect(handleOf('evilhatti.pk', 'hatti.pk')).toBeUndefined();
  });

  it('remembers what the directory says for a few seconds', async () => {
    const asked: string[] = [];
    const shops = new ShopResolver(
      {
        find: async (handle: string) => {
          asked.push(handle);
          return handle === 'zari' ? 'shop-1' : null;
        },
      },
      60_000,
      2,
    );
    expect(await shops.find('zari')).toBe('shop-1');
    expect(await shops.find('zari')).toBe('shop-1');
    expect(await shops.find('nobody')).toBeNull();
    expect(await shops.find('nobody')).toBeNull();
    expect(asked).toEqual(['zari', 'nobody']);
    // It keeps two answers: a third handle pushes out the oldest.
    await shops.find('bazaar');
    await shops.find('zari');
    expect(asked).toEqual(['zari', 'nobody', 'bazaar', 'zari']);
  });
});

describe('Starting a storefront', () => {
  it('renders the sample pages before it listens, so the first pages served parse nothing', async () => {
    const theme = loadTheme(await readThemeDir(THEME_DIR));
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    const app = createStorefrontServer({
      theme,
      renderer,
      domain: 'localhost',
      sample: new MemoryStore(sampleStore()),
    });
    // Templates and snippets alike, each parsed by a Parser of its own.
    const parse = vi.spyOn(Parser.prototype, 'parse');
    await app.ready();
    const atStart = parse.mock.calls.length;
    expect(atStart).toBeGreaterThan(0);
    const product = sampleStore().products[5]!.handle;
    for (const url of ['/', '/ur/', '/collections/khussa', `/products/${product}`]) {
      const page = await app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
      expect(page.statusCode, url).toBe(200);
    }
    expect(parse.mock.calls.length).toBe(atStart);
    parse.mockRestore();
    await app.close();
  });
});

describe("Shops' themes", () => {
  let base: Theme;
  beforeAll(async () => {
    base = loadTheme(await readThemeDir(THEME_DIR));
  });

  /** A shop's store, holding `doc` as its theme, counting how often it is fetched. */
  const holding = (doc: ThemeDoc | null) => {
    const store = {
      doc,
      fetched: 0,
      theme: async () => {
        store.fetched += 1;
        return store.doc;
      },
    };
    return store;
  };
  const shopWith = (theme: ShopDoc['theme']): ShopDoc => ({ ...sampleStore().shop, theme });
  const doc = (version: number, heading: string): ThemeDoc => ({
    id: 'thm-1',
    version,
    base: 'hatti-base',
    files: { 'templates/index.json': bannerHome(heading) },
  });
  const home = (theme: Theme) => theme.files['templates/index.json'];

  it('lays a theme over the platform theme once per version, for pages at once and after', async () => {
    const themes = new ShopThemes(base);
    const store = holding(doc(1, 'One'));
    const data = store as unknown as StoreData;
    const [first, second] = await Promise.all([
      themes.for('s1', shopWith({ id: 'thm-1', version: 1 }), data),
      themes.for('s1', shopWith({ id: 'thm-1', version: 1 }), data),
    ]);
    expect(second).toBe(first);
    expect(await themes.for('s1', shopWith({ id: 'thm-1', version: 1 }), data)).toBe(first);
    expect(home(first)).toBe(bannerHome('One'));
    expect(store.fetched).toBe(1);
    // No theme, or documents from before shops had them: the platform theme, fetching nothing.
    expect(await themes.for('s1', shopWith(null), data)).toBe(base);
    const { theme: _, ...older } = shopWith(null);
    expect(await themes.for('s1', older as ShopDoc, data)).toBe(base);
    expect(store.fetched).toBe(1);

    // The shop's document names version 2 before its theme's is written: version 1 shows, but is
    // not kept as version 2.
    const early = await themes.for('s1', shopWith({ id: 'thm-1', version: 2 }), data);
    expect(home(early)).toBe(bannerHome('One'));
    store.doc = doc(2, 'Two');
    const next = await themes.for('s1', shopWith({ id: 'thm-1', version: 2 }), data);
    expect(home(next)).toBe(bannerHome('Two'));
    await themes.for('s1', shopWith({ id: 'thm-1', version: 2 }), data);
    expect(store.fetched).toBe(3);
  });

  it('keeps themes up to a size, letting the least recently used go first', async () => {
    const size = bannerHome('Shop 1').length;
    const themes = new ShopThemes(base, { maxBytes: size * 2 });
    const stores = new Map(['s1', 's2', 's3'].map((id) => [id, holding(doc(1, `Shop ${id[1]}`))]));
    const show = (shopId: string) =>
      themes.for(shopId, shopWith({ id: 'thm-1', version: 1 }), stores.get(shopId) as never);
    await show('s1');
    await show('s2');
    await show('s1');
    await show('s3');
    // s2 was used least recently: making room for s3 let it go.
    await show('s1');
    await show('s2');
    expect([...stores.values()].map((store) => store.fetched)).toEqual([1, 2, 1]);
  });
});

describe.skipIf(!redisUrl)('The storefront server', () => {
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const prefix = `test-sfs-${randomBytes(4).toString('hex')}`;
  const keys = new StorefrontKeys(prefix);
  const queue = new BuildQueue(redis, { keys });
  const directory = new ShopDirectory(redis, keys);
  const [zari, bazaar, gone] = [randomUUID(), randomUUID(), randomUUID()];
  let theme: Theme;

  /** Publishes a shop's documents as the core does, and names it in the directory. */
  const publish = async (shopId: string, handle: string, documents: StoreDocuments) => {
    await queue.add(shopId, ['sample']);
    await queue.drain(shopId, async ({ writer }) => {
      await writer.putShop({ ...documents.shop, handle });
      await writer.putProducts(documents.products);
      await writer.putCollections(documents.collections);
      await writer.putMenus(documents.menus);
    });
    await directory.set(shopId, handle);
  };

  beforeAll(async () => {
    theme = loadTheme(await readThemeDir(THEME_DIR));
    const sample = sampleStore();
    await publish(zari, 'zari', sample);
    await publish(bazaar, 'bazaar', {
      ...sample,
      shop: { ...sample.shop, name: 'Bazaar of Lahore' },
      products: sample.products.slice(0, 10),
    });
    await directory.set(gone, 'gone');
  });

  afterAll(async () => {
    const found = await redis.keys(`${prefix}:*`);
    if (found.length > 0) await redis.del(...found);
    redis.disconnect();
  });

  const server = () => {
    const sample = sampleStore();
    return createStorefrontServer({
      theme,
      // Time enough for a first render, which parses the theme, on a busy runner.
      renderer: new PageRenderer(theme, { limits: { timeMs: 10_000 } }),
      domain: 'localhost',
      redis,
      keys,
      sample: new MemoryStore({ ...sample, shop: { ...sample.shop, name: 'Sample' } }),
    });
  };

  it("serves each shop at its handle's subdomain, and the sample shop at the domain", async () => {
    const app = server();
    const page = (host: string, url = '/') => app.inject({ method: 'GET', url, headers: { host } });

    const home = await page('zari.localhost:4100');
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('<title>Zari Fashions</title>');
    expect((await page('bazaar.localhost')).body).toContain('<title>Bazaar of Lahore</title>');
    expect((await page('localhost:4100')).body).toContain('<title>Sample</title>');

    // A shop's pages are its own: Bazaar has 10 of Zari's 201 products.
    const product = sampleStore().products[20]!;
    expect((await page('zari.localhost', `/products/${product.handle}`)).statusCode).toBe(200);
    expect((await page('bazaar.localhost', `/products/${product.handle}`)).statusCode).toBe(404);
    expect((await page('zari.localhost', '/ur/')).body).toMatch(/<html lang="ur" dir="rtl">/);
    await app.close();
  });

  it("shows a shop's own theme, and its next version once published", async () => {
    const sana = randomUUID();
    const sample = sampleStore();
    const shop = { ...sample.shop, name: 'Sana Lawn', handle: 'sana' };
    await publish(sana, 'sana', { ...sample, shop });
    const publishTheme = async (version: number, heading: string) => {
      await queue.add(sana, ['shop']);
      await queue.drain(sana, async ({ writer }) => {
        await writer.putTheme({
          id: 'thm-1',
          version,
          base: 'hatti-base',
          files: { 'templates/index.json': bannerHome(heading) },
        });
        await writer.putShop({ ...shop, theme: { id: 'thm-1', version } });
      });
    };
    const app = server();
    const home = async (host: string) =>
      (await app.inject({ method: 'GET', url: '/', headers: { host } })).body;

    expect(await home('sana.localhost')).toContain('Eid Lawn &#39;26');
    await publishTheme(1, 'Sana Winter Sale');
    expect(await home('sana.localhost')).toContain('Sana Winter Sale');
    // Other shops keep theirs.
    expect(await home('zari.localhost')).toContain('Eid Lawn &#39;26');
    await publishTheme(2, 'Sana Spring Lawn');
    const page = await home('sana.localhost');
    expect(page).toContain('Sana Spring Lawn');
    expect(page).not.toContain('Sana Winter Sale');
    await app.close();
  });

  it('answers 404 where no shop is, or where its documents are missing', async () => {
    const app = server();
    for (const host of ['nobody.localhost', 'zari.example.com', 'gone.localhost']) {
      const response = await app.inject({ method: 'GET', url: '/', headers: { host } });
      expect(response.statusCode, host).toBe(404);
      expect(response.headers['content-type'], host).toMatch(/^text\/plain/);
    }
    await app.close();
  });
});
