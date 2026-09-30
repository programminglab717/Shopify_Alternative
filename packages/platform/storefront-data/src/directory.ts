import type { Redis } from 'ioredis';
import { StorefrontKeys } from './keys.js';
import { scripted, type ScriptedRedis } from './scripts.js';

/**
 * Which shop each handle names, so a storefront finds the shop a host asks for:
 * {handle}.hatti.pk. One hash for the cell, written as shops are published; the edge will keep a
 * copy of its own (04 §2.1).
 */
export class ShopDirectory {
  readonly #redis: ScriptedRedis;

  constructor(
    redis: Redis,
    private readonly keys = new StorefrontKeys(),
  ) {
    this.#redis = scripted(redis);
  }

  /** The shop the handle names, if any. */
  find(handle: string): Promise<string | null> {
    return this.#redis.hget(this.keys.directory(), handle);
  }

  /** Points the handle at the shop, and lets go of the shop's `previous` one. */
  async set(shopId: string, handle: string, previous?: string | null): Promise<void> {
    if (previous && previous !== handle) await this.remove(shopId, previous);
    await this.#redis.hset(this.keys.directory(), handle, shopId);
  }

  /** Lets go of the handle, if it still names the shop. */
  async remove(shopId: string, handle: string): Promise<void> {
    await this.#redis.sfUnmap(this.keys.directory(), handle, shopId);
  }
}
