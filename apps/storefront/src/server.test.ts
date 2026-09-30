import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  BuildQueue,
  MemoryStore,
  ShopDirectory,
  StorefrontKeys,
  type StoreDocuments,
} from '@hatti/storefront-data';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sampleStore } from './fixtures.js';
import { PageRenderer } from './render.js';
import { createStorefrontServer, handleOf, ShopResolver } from './server.js';
import { loadTheme, readThemeDir, type Theme } from './theme.js';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

const THEME_DIR = fileURLToPath(new URL('../../../themes/hatti-base', import.meta.url));

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
      renderer: new PageRenderer(theme),
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
