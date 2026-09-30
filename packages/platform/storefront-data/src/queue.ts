import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { StorefrontKeys } from './keys.js';
import { scripted, type ScriptedRedis } from './scripts.js';
import { LockLostError, ShopWriter } from './writer.js';

/** What a publisher builds at a time: some of what is pending for one shop. */
export interface Batch {
  shopId: string;
  items: string[];
  writer: ShopWriter;
  /** Builds these too, in a later batch of the same drain: the parts of a larger item. */
  add(items: readonly string[]): Promise<void>;
}

export interface BuildQueueOptions {
  keys?: StorefrontKeys;
  /** Lower goes first, e.g. products before the collections listing them. Defaults to 0. */
  priority?: (item: string) => number;
  /** How long a publisher keeps the lock without writing or taking a batch. */
  lockMs?: number;
  batchSize?: number;
}

/**
 * What is waiting to be built for each shop's storefront, and who is building it. Items are
 * strings the publisher understands, such as "product:<id>"; adding one already waiting changes
 * nothing, so a burst of edits is built once.
 *
 * One publisher at a time drains a shop, holding its lock, and builds what others add meanwhile.
 * Items it takes are kept aside until built, and put back if it fails or stops: nothing is lost,
 * and nothing is built from data older than the change that asked for it.
 */
export class BuildQueue {
  readonly #redis: ScriptedRedis;
  readonly #keys: StorefrontKeys;
  readonly #priority: (item: string) => number;
  readonly #lockMs: number;
  readonly #batchSize: number;

  constructor(redis: Redis, options: BuildQueueOptions = {}) {
    this.#redis = scripted(redis);
    this.#keys = options.keys ?? new StorefrontKeys();
    this.#priority = options.priority ?? (() => 0);
    this.#lockMs = options.lockMs ?? 15_000;
    this.#batchSize = options.batchSize ?? 100;
  }

  async add(shopId: string, items: readonly string[]): Promise<void> {
    if (items.length === 0) return;
    const scored = items.flatMap((item) => [this.#priority(item), item]);
    await this.#redis.zadd(this.#keys.pending(shopId), 'NX', ...scored);
  }

  /** How many items wait for the shop, taken ones included. */
  async size(shopId: string): Promise<number> {
    const [pending, taken] = await Promise.all([
      this.#redis.zcard(this.#keys.pending(shopId)),
      this.#redis.zcard(this.#keys.taken(shopId)),
    ]);
    return pending + taken;
  }

  /**
   * Builds what is pending for the shop, a batch at a time, until nothing is. If another
   * publisher holds the shop's lock, returns at once: that one builds what was added too.
   * Returns how many items this call built. If `build` fails, its batch is put back and the
   * error thrown; a publisher that lost the lock throws {@link LockLostError}.
   */
  async drain(shopId: string, build: (batch: Batch) => Promise<void>): Promise<number> {
    const [lock, pending, taken] = [
      this.#keys.lock(shopId),
      this.#keys.pending(shopId),
      this.#keys.taken(shopId),
    ];
    let built = 0;
    for (;;) {
      const token = randomUUID();
      if (!(await this.#redis.sfClaim(lock, pending, taken, token, this.#lockMs))) return built;
      const writer = new ShopWriter(this.#redis, this.#keys, shopId, token, this.#lockMs);
      try {
        for (;;) {
          const items = await this.#redis.sfTake(
            lock,
            pending,
            taken,
            token,
            this.#lockMs,
            this.#batchSize,
          );
          if (items === null) throw new LockLostError(shopId);
          if (items.length === 0) break;
          await build({ shopId, items, writer, add: (more) => this.add(shopId, more) });
          if ((await this.#redis.sfFinish(lock, taken, token, this.#lockMs)) === null) {
            throw new LockLostError(shopId);
          }
          built += items.length;
        }
      } catch (error) {
        await this.#redis.sfGiveBack(lock, pending, taken, token);
        throw error;
      } finally {
        await this.#redis.sfRelease(lock, token);
      }
      // Added after the last batch was taken, by one that found the lock held: build it now.
      if ((await this.#redis.zcard(pending)) === 0) return built;
    }
  }

  /** Every key of the shop's storefront, documents included, as when the shop closes. */
  async clear(shopId: string): Promise<number> {
    let removed = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.#redis.scan(
        cursor,
        'MATCH',
        this.#keys.all(shopId),
        'COUNT',
        500,
      );
      if (keys.length > 0) removed += await this.#redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
    return removed;
  }
}
