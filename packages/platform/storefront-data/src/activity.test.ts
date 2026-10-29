import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { StorefrontActivity, StorefrontKeys, localDay } from './index.js';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

describe("A shop's days in its time zone", () => {
  it('names the day a moment falls on there, in Pakistan for a zone not known', () => {
    // 00:10 on 5 October in Karachi is 19:10 on the 4th in UTC.
    const early = new Date('2026-10-04T19:10:00Z');
    expect(localDay(early, 'Asia/Karachi')).toBe('2026-10-05');
    expect(localDay(early, 'UTC')).toBe('2026-10-04');
    expect(localDay(early, 'Not/A_Zone')).toBe('2026-10-05');
  });
});

describe.skipIf(!redisUrl)('What shoppers do on a storefront, in Valkey (ADR-180)', () => {
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const prefix = `test-an-${randomBytes(4).toString('hex')}`;
  const activity = new StorefrontActivity(redis, new StorefrontKeys(prefix));
  const karachi = 'Asia/Karachi';

  afterAll(async () => {
    const found = await redis.keys(`${prefix}:*`);
    if (found.length > 0) await redis.del(...found);
    redis.disconnect();
  });

  it("counts a theme experiment's arms, their steps and their orders' revenue, each order once (ADR-921)", async () => {
    const shopId = randomUUID();
    await activity.experimented(shopId, 'texp_1', 'a', 'session-a');
    await activity.experimented(shopId, 'texp_1', 'b', 'session-b', 'converted');
    await activity.experimented(shopId, 'texp_1', 'b', 'session-c', 'converted');
    // Rs 5,000 and Rs 1,500 in the draft's arm; the first told twice counts once.
    await activity.experimentSold(shopId, 'texp_1', 'b', 'order-1', 500_000);
    await activity.experimentSold(shopId, 'texp_1', 'b', 'order-1', 500_000);
    await activity.experimentSold(shopId, 'texp_1', 'b', 'order-2', 150_000);
    expect(await activity.experimentCounts(shopId, 'texp_1')).toEqual({
      a: {
        sessions: 1,
        added_to_cart: 0,
        reached_checkout: 0,
        converted: 0,
        revenue: 0,
        revenue_squares: 0,
      },
      b: {
        sessions: 2,
        added_to_cart: 0,
        reached_checkout: 0,
        converted: 2,
        revenue: 650_000,
        revenue_squares: 500_000 ** 2 + 150_000 ** 2,
      },
    });
  });

  it('counts each arm of an experiment with three drafts (ADR-931)', async () => {
    const shopId = randomUUID();
    await activity.experimented(shopId, 'texp_2', 'c', 'session-c', 'added_to_cart');
    await activity.experimented(shopId, 'texp_2', 'd', 'session-d');
    await activity.experimentSold(shopId, 'texp_2', 'd', 'order-3', 200_000);
    const counts = await activity.experimentCounts(shopId, 'texp_2', 3);
    expect(Object.keys(counts)).toEqual(['a', 'b', 'c', 'd']);
    expect(counts.c).toMatchObject({ sessions: 1, added_to_cart: 1, revenue: 0 });
    expect(counts.d).toMatchObject({ sessions: 1, revenue: 200_000 });
    // Asked of its first draft alone, as before.
    expect(Object.keys(await activity.experimentCounts(shopId, 'texp_2'))).toEqual(['a', 'b']);
  });

  it("counts a day's sessions once each, in the shop's time zone, and those that took each step", async () => {
    const shopId = randomUUID();
    // 23:30 on 4 October in Karachi, and 00:10 on the 5th.
    const late = new Date('2026-10-04T18:30:00Z');
    const early = new Date('2026-10-04T19:10:00Z');
    await activity.visited(shopId, karachi, 'session-a', late);
    await activity.visited(shopId, karachi, 'session-a', late);
    await activity.visited(shopId, karachi, 'session-b', late);
    await activity.reached(shopId, karachi, 'session-b', 'added_to_cart', late);
    await activity.reached(shopId, karachi, 'session-b', 'reached_checkout', late);
    // A step taken without a page counted, as with scripts blocked, counts its session too.
    await activity.reached(shopId, karachi, 'session-c', 'converted', early);
    expect(await activity.counts(shopId, '2026-10-04')).toEqual({
      sessions: 2,
      added_to_cart: 1,
      reached_checkout: 1,
      converted: 0,
    });
    expect(await activity.counts(shopId, '2026-10-05')).toEqual({
      sessions: 1,
      added_to_cart: 0,
      reached_checkout: 0,
      converted: 1,
    });

    // Each day changed is taken once; one the worker could not keep is given back.
    const taken = await activity.takeChanged(100);
    const ours = taken.filter((day) => day.shopId === shopId);
    expect(ours.map((day) => day.day).sort()).toEqual(['2026-10-04', '2026-10-05']);
    expect((await activity.takeChanged(100)).filter((day) => day.shopId === shopId)).toEqual([]);
    await activity.giveBack([ours[0]!]);
    expect(await activity.takeChanged(100)).toEqual([ours[0]]);
    // Counted again, a day is changed again.
    await activity.visited(shopId, karachi, 'session-d', late);
    expect(await activity.takeChanged(100)).toEqual([{ shopId, day: '2026-10-04' }]);
  });

  it("counts each day's taps on the link page's links, by where each goes, and marks the day changed (ADR-204)", async () => {
    const shopId = randomUUID();
    const late = new Date('2026-10-04T18:30:00Z');
    const early = new Date('2026-10-04T19:10:00Z');
    const instagram = 'https://www.instagram.com/zari.pk';
    await activity.tapped(shopId, karachi, instagram, late);
    await activity.tapped(shopId, karachi, instagram, late);
    await activity.tapped(shopId, karachi, '/collections/eid-lawn', late);
    await activity.tapped(shopId, karachi, instagram, early);
    expect(await activity.linkTaps(shopId, '2026-10-04')).toEqual({
      [instagram]: 2,
      '/collections/eid-lawn': 1,
    });
    expect(await activity.linkTaps(shopId, '2026-10-05')).toEqual({ [instagram]: 1 });
    expect(await activity.linkTaps(shopId, '2026-10-06')).toEqual({});
    const changed = (await activity.takeChanged(100)).filter((day) => day.shopId === shopId);
    expect(changed.map((day) => day.day).sort()).toEqual(['2026-10-04', '2026-10-05']);
    // Kept a few days, as sessions are.
    expect(
      await redis.ttl(new StorefrontKeys(prefix).linkTaps(shopId, '2026-10-04')),
    ).toBeGreaterThan(2 * 24 * 60 * 60);
  });

  it('says how many saw a page in the last five minutes', async () => {
    const shopId = randomUUID();
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    await activity.visited(shopId, karachi, 'gone', at(6));
    await activity.visited(shopId, karachi, 'browsing', at(4));
    await activity.visited(shopId, karachi, 'arrived', at(0));
    expect(await activity.liveVisitors(shopId, at(0))).toBe(2);
    // Another page brings one back.
    await activity.visited(shopId, karachi, 'gone', at(0));
    expect(await activity.liveVisitors(shopId, at(0))).toBe(3);
    expect(await activity.liveVisitors(randomUUID())).toBe(0);
  });
});
