import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BuildQueue, MemoryStore, RedisStore, StorefrontKeys } from '@hatti/storefront-data';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { sampleStore } from './fixtures.js';
import { PageRenderer } from './render.js';
import { loadTheme, readThemeDir } from '@hatti/themes';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

const THEME_DIR = fileURLToPath(new URL('../../../themes/hatti-base', import.meta.url));

describe.skipIf(!redisUrl)('Storefront rendering from Valkey', () => {
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const keys = new StorefrontKeys(`test-sfr-${randomBytes(4).toString('hex')}`);
  const shopId = randomUUID();
  const queue = new BuildQueue(redis, { keys });

  afterAll(async () => {
    await queue.clear(shopId);
    redis.disconnect();
  });

  it('renders the same pages from Valkey as from memory, in as many round trips', async () => {
    const documents = sampleStore();
    await queue.add(shopId, ['sample']);
    await queue.drain(shopId, async ({ writer }) => {
      await writer.putShop(documents.shop);
      await writer.putProducts(documents.products);
      await writer.putCollections(documents.collections);
      await writer.putMenus(documents.menus);
    });
    // The first render parses the theme; on a busy runner it could go over the time limit where
    // the second does not. Time limits are render.test.ts's to test.
    const renderer = new PageRenderer(loadTheme(await readThemeDir(THEME_DIR)), {
      limits: { timeMs: 10_000 },
    });
    const paths = [
      '/',
      '/collections/eid-lawn',
      '/products/bridal-lehenga-heavy',
      `/products/${documents.products[0]!.handle}`,
      '/products/nothing',
    ];
    for (const path of paths) {
      const memory = new MemoryStore(documents);
      const valkey = new RedisStore(redis, shopId, keys);
      const expected = await renderer.render({ path }, memory);
      const page = await renderer.render({ path }, valkey);
      expect(page.status, path).toBe(expected.status);
      expect(page.html, path).toBe(expected.html);
      expect(valkey.roundTrips, path).toBe(memory.roundTrips);
    }
  });
});
