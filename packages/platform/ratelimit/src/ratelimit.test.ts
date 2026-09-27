import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { RateLimiter } from './index.js';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

describe.skipIf(!redisUrl)('RateLimiter', () => {
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const prefix = `test-rl-${randomBytes(4).toString('hex')}`;
  const limiter = new RateLimiter(redis, prefix);

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  it('allows up to the limit, then refuses with a retry time', async () => {
    const limit = { name: 'sign-in', limit: 3, windowMs: 60_000 };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.hit(limit, 'owner@example.pk'));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]!.retryAfterMs).toBeGreaterThan(55_000);
  });

  it('counts subjects separately, ignoring case, and never stores them in clear', async () => {
    const limit = { name: 'separate', limit: 1, windowMs: 60_000 };
    expect((await limiter.hit(limit, 'A@example.pk')).allowed).toBe(true);
    expect((await limiter.hit(limit, 'a@example.pk')).allowed).toBe(false);
    expect((await limiter.hit(limit, 'b@example.pk')).allowed).toBe(true);
    const keys = await redis.keys(`${prefix}:separate:*`);
    expect(keys.join()).not.toContain('example');
  });

  it('starts a new window after the old one expires, and can be reset', async () => {
    const limit = { name: 'window', limit: 1, windowMs: 100 };
    expect((await limiter.hit(limit, 'x')).allowed).toBe(true);
    expect((await limiter.hit(limit, 'x')).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await limiter.hit(limit, 'x')).allowed).toBe(true);
    await limiter.reset(limit, 'x');
    expect((await limiter.hit(limit, 'x')).allowed).toBe(true);
  });
});
