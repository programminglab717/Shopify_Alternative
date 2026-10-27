import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisDropTokens } from './drop-tokens.js';

const url = process.env.REDIS_URL;

describe.skipIf(!url)("Drops' token pools in Valkey (ADR-821)", () => {
  let redis: Redis;
  const pool = { dropId: 'd1', variantId: `v${Date.now()}` };
  const later = new Date(Date.now() + 3_600_000);

  beforeAll(() => {
    redis = new Redis(url!);
  });
  afterAll(async () => {
    await redis.del(`drop-tokens:d1:${pool.variantId}`, `drop-tokens:d1:${pool.variantId}:checked`);
    redis.disconnect();
  });

  it('starts a pool from the stock once, takes from it while it has enough, and takes back', async () => {
    const tokens = new RedisDropTokens(redis, 50);
    let reads = 0;
    let stock = 3;
    const read = async () => {
      reads += 1;
      return stock;
    };
    expect(await tokens.take(pool, 2, read, later)).toBe(true);
    expect(await tokens.take(pool, 1, read, later)).toBe(true);
    expect(reads).toBe(1);
    // The three ordered, the stock is gone too.
    stock = 0;
    // Empty: the stock is read again, at most once a while.
    expect(await tokens.take(pool, 1, read, later)).toBe(false);
    expect(await tokens.take(pool, 1, read, later)).toBe(false);
    expect(reads).toBe(2);
    // An order not placed gives its tokens back.
    await tokens.giveBack(pool, 1);
    expect(await tokens.take(pool, 1, read, later)).toBe(true);
    // Once in a while, the stock added is found.
    stock = 2;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await tokens.take(pool, 2, read, later)).toBe(true);
    expect(reads).toBe(3);
    // Taken at once by many, a pool gives no more than it has.
    await redis.set(`drop-tokens:d1:${pool.variantId}`, '5');
    const many = await Promise.all(
      Array.from({ length: 20 }, () => tokens.take(pool, 1, async () => 0, later)),
    );
    expect(many.filter(Boolean)).toHaveLength(5);
  });
});
