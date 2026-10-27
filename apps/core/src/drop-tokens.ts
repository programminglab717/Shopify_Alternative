import { DropTokens, type DropTokenPool } from '@hatti/checkout/public';
import type { Redis } from 'ioredis';

// Takes so many of a pool's tokens if it has them: -1 for a pool not started, 0 for too few.
const TAKE = `
local left = redis.call('GET', KEYS[1])
if not left then return -1 end
if tonumber(left) >= tonumber(ARGV[1]) then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

// Gives tokens back to a pool that is still kept.
const GIVE_BACK = `
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('INCRBY', KEYS[1], ARGV[1]) end
return 0
`;

/**
 * Drops' token pools in Valkey (ADR-821): a count for each drop's variant, taken from and given
 * back to atomically by scripts. Keys name a drop and a variant, and nothing of the shopper.
 */
export class RedisDropTokens extends DropTokens {
  constructor(
    private readonly redis: Redis,
    /** How often an empty pool is started again from the stock. */
    private readonly recheckMs = 15_000,
  ) {
    super();
  }

  async take(
    pool: DropTokenPool,
    quantity: number,
    stock: () => Promise<number>,
    expiresAt: Date,
  ): Promise<boolean> {
    const key = keyOf(pool);
    let taken = await this.#take(key, quantity);
    if (taken === -1) {
      const ttl = Math.max(1_000, expiresAt.getTime() - Date.now() + 3_600_000);
      await this.redis.set(key, Math.max(0, await stock()), 'PX', ttl, 'NX');
      taken = await this.#take(key, quantity);
    }
    // Empty: the stock is read again once in a while, as cancelled orders and new stock add to it.
    if (taken === 0 && (await this.redis.set(`${key}:checked`, '1', 'PX', this.recheckMs, 'NX'))) {
      await this.redis.set(key, Math.max(0, await stock()), 'KEEPTTL', 'XX');
      taken = await this.#take(key, quantity);
    }
    return taken === 1;
  }

  async giveBack(pool: DropTokenPool, quantity: number): Promise<void> {
    await this.redis.eval(GIVE_BACK, 1, keyOf(pool), quantity);
  }

  async #take(key: string, quantity: number): Promise<number> {
    return Number(await this.redis.eval(TAKE, 1, key, quantity));
  }
}

const keyOf = (pool: DropTokenPool) => `drop-tokens:${pool.dropId}:${pool.variantId}`;
