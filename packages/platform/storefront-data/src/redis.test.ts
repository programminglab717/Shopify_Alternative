import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BuildQueue,
  LockLostError,
  RedisStore,
  ShopDirectory,
  StoreMissingError,
  StorefrontKeys,
  type CollectionDoc,
  type ProductDoc,
  type ShopDoc,
  type ShopWriter,
} from './index.js';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

const SHOP: ShopDoc = {
  version: 3,
  name: 'Zari Fashions',
  handle: 'zari',
  domain: 'zari.hatti.pk',
  whatsapp: null,
  cod: { available: true, fee: 0, limit: null },
  theme: null,
};

function product(id: string, handle: string): ProductDoc {
  return {
    id,
    handle,
    title: handle,
    descriptionHtml: '',
    vendor: '',
    productType: '',
    tags: [],
    options: [{ name: 'Title', values: ['Default Title'] }],
    variants: [
      {
        id: `${id}-v`,
        title: 'Default Title',
        sku: null,
        price: 250_000,
        compareAtPrice: null,
        available: true,
        options: ['Default Title'],
        image: null,
      },
    ],
    images: [],
  };
}

function collection(id: string, handle: string, productIds: string[] = []): CollectionDoc {
  return { id, handle, title: handle, descriptionHtml: '', image: null, productIds };
}

describe.skipIf(!redisUrl)('Storefront documents in Valkey', () => {
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const prefix = `test-sf-${randomBytes(4).toString('hex')}`;
  const keys = new StorefrontKeys(prefix);
  const queue = new BuildQueue(redis, { keys });

  afterAll(async () => {
    const found = await redis.keys(`${prefix}:*`);
    if (found.length > 0) await redis.del(...found);
    redis.disconnect();
  });

  /** Writes as a publisher does, holding the shop's lock. */
  const write = async (shopId: string, change: (writer: ShopWriter) => Promise<void>) => {
    await queue.add(shopId, ['write']);
    await queue.drain(shopId, ({ writer }) => change(writer));
  };
  const store = (shopId: string) => new RedisStore(redis, shopId, keys);

  it('reads each document in one round trip, products in the order asked', async () => {
    const shopId = randomUUID();
    await expect(store(shopId).shop()).rejects.toThrow(StoreMissingError);
    await write(shopId, async (writer) => {
      await writer.putShop(SHOP);
      await writer.putProducts([product('p1', 'lawn-suit'), product('p2', 'khussa')]);
      await writer.putCollections([collection('c1', 'eid', ['p2', 'p1'])]);
      await writer.putMenus([
        {
          handle: 'main-menu',
          title: 'Main menu',
          links: [{ title: 'Eid', url: '/collections/eid' }],
        },
      ]);
    });

    const data = store(shopId);
    expect(await data.shop()).toEqual(SHOP);
    expect((await data.productByHandle('khussa'))?.id).toBe('p2');
    expect(await data.productByHandle('nothing')).toBeNull();
    const listed = await data.products(['p2', 'gone', 'p1']);
    expect(listed.map((doc) => doc?.id ?? null)).toEqual(['p2', null, 'p1']);
    expect((await data.collectionByHandle('eid'))?.productIds).toEqual(['p2', 'p1']);
    expect((await data.menu('main-menu'))?.links).toHaveLength(1);
    expect(await data.menu('footer')).toBeNull();
    expect(data.roundTrips).toBe(7);
    // Other shops' documents are out of reach.
    expect(await store(randomUUID()).productByHandle('khussa')).toBeNull();
  });

  it('moves a handle with its document, when two swap handles or one is built late', async () => {
    const shopId = randomUUID();
    const handles = async (...wanted: string[]) => {
      const data = store(shopId);
      const docs = await Promise.all(wanted.map((handle) => data.productByHandle(handle)));
      return docs.map((doc) => doc?.id ?? null);
    };
    await write(shopId, (writer) => writer.putProducts([product('p1', 'a'), product('p2', 'b')]));
    await write(shopId, (writer) => writer.putProducts([product('p1', 'b'), product('p2', 'a')]));
    expect(await handles('a', 'b')).toEqual(['p2', 'p1']);

    // p3 was renamed from "c" to "d", and p4 given "c", but p4 is built first.
    await write(shopId, (writer) => writer.putProducts([product('p3', 'c')]));
    await write(shopId, (writer) => writer.putProducts([product('p4', 'c')]));
    await write(shopId, (writer) => writer.putProducts([product('p3', 'd')]));
    expect(await handles('c', 'd')).toEqual(['p4', 'p3']);

    // Taking a product off lets go only of the handle it holds.
    await write(shopId, (writer) => writer.dropProducts(['p3', 'p1', 'never-built']));
    expect(await handles('a', 'b', 'c', 'd')).toEqual(['p2', null, 'p4', null]);
    expect(await store(shopId).products(['p1', 'p2'])).toEqual([null, expect.anything()]);

    await write(shopId, (writer) => writer.putCollections([collection('c1', 'eid')]));
    await write(shopId, (writer) => writer.putCollections([collection('c1', 'eid-2026')]));
    expect(await store(shopId).collectionByHandle('eid')).toBeNull();
    expect((await store(shopId).collectionByHandle('eid-2026'))?.id).toBe('c1');
    await write(shopId, (writer) => writer.dropCollections(['c1']));
    expect(await store(shopId).collectionByHandle('eid-2026')).toBeNull();
  });

  it('builds what is pending once each, in batches, lowest priority first', async () => {
    const shopId = randomUUID();
    const ordered = new BuildQueue(redis, {
      keys,
      batchSize: 2,
      priority: (item) => (item.startsWith('product:') ? 1 : 2),
    });
    await ordered.add(shopId, ['menus', 'product:p1', 'collection:c1', 'product:p2', 'product:p1']);
    expect(await ordered.size(shopId)).toBe(4);

    const batches: string[][] = [];
    const built = await ordered.drain(shopId, async ({ items, add }) => {
      batches.push(items);
      if (batches.length === 1) {
        // A part of a larger item, and a product changed again while its document is built.
        await add(['product:p3']);
        await ordered.add(shopId, ['product:p1']);
      }
    });
    expect(batches).toEqual([
      ['product:p1', 'product:p2'],
      ['product:p1', 'product:p3'],
      ['collection:c1', 'menus'],
    ]);
    expect(built).toBe(6);
    expect(await ordered.size(shopId)).toBe(0);
  });

  it('leaves a shop to the publisher holding its lock, which builds what others add', async () => {
    const shopId = randomUUID();
    await queue.add(shopId, ['product:p1']);
    const built: string[] = [];
    let other: number | undefined;
    const first = await queue.drain(shopId, async ({ items }) => {
      built.push(...items);
      if (other === undefined) {
        await queue.add(shopId, ['product:p2']);
        other = await queue.drain(shopId, async ({ items: stolen }) => {
          built.push(...stolen.map((item) => `other ${item}`));
        });
      }
    });
    expect(other).toBe(0);
    expect(first).toBe(2);
    expect(built).toEqual(['product:p1', 'product:p2']);
  });

  it('puts back a failed batch, and what a publisher that stopped had taken', async () => {
    const shopId = randomUUID();
    await queue.add(shopId, ['product:p1', 'product:p2']);
    await expect(
      queue.drain(shopId, async () => {
        throw new Error('database unavailable');
      }),
    ).rejects.toThrow('database unavailable');
    expect(await queue.size(shopId)).toBe(2);

    // This one stalls past its lock; the next publisher takes over and builds its batch.
    const stalling = new BuildQueue(redis, { keys, lockMs: 50 });
    let resume = () => {};
    const stalled = stalling.drain(
      shopId,
      () => new Promise<void>((resolve) => (resume = resolve)),
    );
    await sleep(120);
    const built: string[] = [];
    expect(await queue.drain(shopId, async ({ items }) => void built.push(...items))).toBe(2);
    expect(built.sort()).toEqual(['product:p1', 'product:p2']);
    resume();
    await expect(stalled).rejects.toThrow(LockLostError);
    expect(await queue.size(shopId)).toBe(0);
  });

  it('refuses the writes of a publisher that lost its lock', async () => {
    const shopId = randomUUID();
    const slow = new BuildQueue(redis, { keys, lockMs: 50 });
    await slow.add(shopId, ['shop']);
    await expect(
      slow.drain(shopId, async ({ writer }) => {
        await sleep(120);
        await writer.putShop(SHOP);
      }),
    ).rejects.toThrow(LockLostError);
    await expect(store(shopId).shop()).rejects.toThrow(StoreMissingError);
    // Its item waits for the next publisher.
    expect(await queue.size(shopId)).toBe(1);
  });

  it('finds shops by handle, and lets a handle go only for the shop it names', async () => {
    const directory = new ShopDirectory(redis, keys);
    const [zari, bazaar] = [randomUUID(), randomUUID()];
    await directory.set(zari, 'zari');
    await directory.set(bazaar, 'bazaar');
    expect(await directory.find('zari')).toBe(zari);
    expect(await directory.find('nobody')).toBeNull();
    // Zari takes a new handle, and Bazaar the old one; Zari letting go of it again changes nothing.
    await directory.set(zari, 'zari-fashions', 'zari');
    await directory.set(bazaar, 'zari', 'bazaar');
    await directory.remove(zari, 'zari');
    expect(await directory.find('zari-fashions')).toBe(zari);
    expect(await directory.find('zari')).toBe(bazaar);
    expect(await directory.find('bazaar')).toBeNull();
  });

  it("keeps a shop's theme files, and lets them go for the platform theme's", async () => {
    const shopId = randomUUID();
    const theme = {
      id: 'thm-1',
      version: 4,
      base: 'hatti-base',
      files: { 'templates/index.json': '{"sections":{},"order":[]}' },
    };
    await write(shopId, (writer) => writer.putTheme(theme));
    const data = store(shopId);
    expect(await data.theme()).toEqual(theme);
    expect(data.roundTrips).toBe(1);
    await write(shopId, (writer) => writer.dropTheme());
    expect(await store(shopId).theme()).toBeNull();
  });

  it("clears a shop's documents and queue", async () => {
    const shopId = randomUUID();
    await write(shopId, async (writer) => {
      await writer.putShop(SHOP);
      await writer.putProducts([product('p1', 'lawn-suit')]);
    });
    await queue.add(shopId, ['product:p1']);
    expect(await queue.clear(shopId)).toBe(5);
    await expect(store(shopId).shop()).rejects.toThrow(StoreMissingError);
    expect(await store(shopId).productByHandle('lawn-suit')).toBeNull();
    expect(await queue.size(shopId)).toBe(0);
  });
});
