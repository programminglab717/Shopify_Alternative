import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { SEARCHES, StorefrontKeys, StorefrontSearches, searchReportOf } from './index.js';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

describe("Shoppers' searches (SRC-06, ADR-683)", () => {
  it("reads a page's report, its words folded, and refuses anything else", () => {
    expect(searchReportOf({ q: '  Lawn   SUIT​ ', n: 12 })).toEqual({
      terms: 'lawn suit',
      found: true,
    });
    expect(searchReportOf({ q: 'ｌａｗｎ', n: 0 })).toEqual({ terms: 'lawn', found: false });
    expect(searchReportOf({ q: 'جوتے', n: 3 })).toEqual({ terms: 'جوتے', found: true });
    expect(searchReportOf({ q: 'x'.repeat(300), n: 1 })!.terms).toHaveLength(SEARCHES.termsMax);
    expect(searchReportOf({ q: '   ', n: 1 })).toBeNull();
    expect(searchReportOf({ q: 'lawn', n: -1 })).toBeNull();
    expect(searchReportOf({ q: 'lawn', n: 1.5 })).toBeNull();
    expect(searchReportOf({ q: 'lawn' })).toBeNull();
    expect(searchReportOf(['lawn', 1])).toBeNull();
    expect(searchReportOf('q=lawn')).toBeNull();
  });
});

describe.skipIf(!redisUrl)("Shoppers' searches, in Valkey (ADR-683)", () => {
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const prefix = `test-searches-${randomBytes(4).toString('hex')}`;
  const keys = new StorefrontKeys(prefix);
  const searches = new StorefrontSearches(redis, keys);

  afterAll(async () => {
    const found = await redis.keys(`${prefix}:*`);
    if (found.length > 0) await redis.del(...found);
    redis.disconnect();
  });

  it('counts searches by day and words, those that found nothing apart, added up over days', async () => {
    const shopId = randomUUID();
    await searches.record(shopId, '2026-10-20', { terms: 'lawn', found: true });
    await searches.record(shopId, '2026-10-20', { terms: 'khussa', found: false });
    await searches.record(shopId, '2026-10-21', { terms: 'lawn', found: true });
    await searches.record(shopId, '2026-10-21', { terms: 'khussa', found: false });
    await searches.record(shopId, '2026-10-21', { terms: 'khussa', found: true });

    const both = await searches.counts(shopId, ['2026-10-19', '2026-10-20', '2026-10-21']);
    expect(both.searches).toBe(5);
    expect(both.foundNothing).toBe(2);
    expect(both.terms).toEqual(
      expect.arrayContaining([
        { terms: 'lawn', searches: 2, foundNothing: 0 },
        { terms: 'khussa', searches: 3, foundNothing: 2 },
      ]),
    );
    expect(both.terms).toHaveLength(2);
    expect((await searches.counts(shopId, ['2026-10-21'])).searches).toBe(3);
    expect(await redis.ttl(keys.searches(shopId, '2026-10-21'))).toBeGreaterThan(89 * 24 * 60 * 60);
  });

  it("keeps a day's first few thousand different searches, counting the rest in its totals", async () => {
    const shopId = randomUUID();
    const key = keys.searches(shopId, '2026-10-21');
    const full: Record<string, number> = {};
    for (let index = 0; index < SEARCHES.termsPerDay * 2 + 2; index++) full[`s:old ${index}`] = 1;
    await redis.hset(key, full);
    await searches.record(shopId, '2026-10-21', { terms: 'new', found: false });
    await searches.record(shopId, '2026-10-21', { terms: 'old 7', found: false });
    const counts = await searches.counts(shopId, ['2026-10-21']);
    expect([counts.searches, counts.foundNothing]).toEqual([2, 2]);
    expect(counts.terms.find((each) => each.terms === 'new')).toBeUndefined();
    expect(counts.terms.find((each) => each.terms === 'old 7')).toEqual({
      terms: 'old 7',
      searches: 2,
      foundNothing: 1,
    });
  });
});
