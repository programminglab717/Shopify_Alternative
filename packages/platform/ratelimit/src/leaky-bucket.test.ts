import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { LeakyBuckets } from './index.js';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

describe.skipIf(!redisUrl)('LeakyBuckets', () => {
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const prefix = `test-lb-${randomBytes(4).toString('hex')}`;
  const buckets = new LeakyBuckets(redis, prefix);
  const limits = { maximum: 1_000, restoreRate: 50 };
  const start = 1_800_000_000_000;

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  it('starts full, takes what is there, and refuses more without taking any', async () => {
    expect(await buckets.take('api', 'shop-1:app-1', 600, limits, start)).toEqual({
      allowed: true,
      available: 400,
    });
    expect(await buckets.take('api', 'shop-1:app-1', 401, limits, start)).toEqual({
      allowed: false,
      available: 400,
    });
    expect(await buckets.take('api', 'shop-1:app-1', 400, limits, start)).toEqual({
      allowed: true,
      available: 0,
    });
  });

  it('restores at its rate, never past its maximum', async () => {
    const subject = 'shop-1:app-2';
    await buckets.take('api', subject, 1_000, limits, start);
    // 50 a second: 1.5 seconds later, 75 are back.
    expect(await buckets.take('api', subject, 0, limits, start + 1_500)).toEqual({
      allowed: true,
      available: 75,
    });
    expect((await buckets.take('api', subject, 76, limits, start + 1_500)).allowed).toBe(false);
    expect((await buckets.take('api', subject, 0, limits, start + 60_000)).available).toBe(1_000);
  });

  it('gives back what a call did not use, never past its maximum', async () => {
    const subject = 'shop-1:app-3';
    await buckets.take('api', subject, 300, limits, start);
    expect(await buckets.refund('api', subject, 250, limits, start)).toEqual({
      allowed: true,
      available: 950,
    });
    expect((await buckets.refund('api', subject, 500, limits, start)).available).toBe(1_000);
  });

  it('keeps buckets apart by subject and name', async () => {
    await buckets.take('api', 'shop-2:app-1', 1_000, limits, start);
    expect((await buckets.take('api', 'shop-2:app-1', 1, limits, start)).allowed).toBe(false);
    expect((await buckets.take('api', 'shop-3:app-1', 1, limits, start)).allowed).toBe(true);
    expect((await buckets.take('other', 'shop-2:app-1', 1, limits, start)).allowed).toBe(true);
  });

  it('lets no time pass backwards when clocks disagree', async () => {
    const subject = 'shop-4:app-1';
    await buckets.take('api', subject, 1_000, limits, start + 2_000);
    // A process whose clock is behind sees nothing restored, and restores nothing twice later.
    expect((await buckets.take('api', subject, 0, limits, start)).available).toBe(0);
    expect((await buckets.take('api', subject, 0, limits, start + 3_000)).available).toBe(50);
  });

  it('spends a bucket once when calls race for it', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => buckets.take('api', 'shop-5:app-1', 100, limits, start)),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(10);
  });

  it('lets a bucket left alone expire once it would be full again', async () => {
    await buckets.take('api', 'shop-6:app-1', 10, { maximum: 100, restoreRate: 100 }, start);
    const ttl = await redis.pttl(`${prefix}:api:shop-6:app-1`);
    expect(ttl).toBeGreaterThan(1_000);
    expect(ttl).toBeLessThanOrEqual(2_000);
  });
});
