import type { Redis } from 'ioredis';
import type {
  CollectionDoc,
  MenuDoc,
  ProductDoc,
  ShopDoc,
  StoreData,
  ThemeDoc,
} from './documents.js';
import { StorefrontKeys, type HandledKind } from './keys.js';
import { scripted, type ScriptedRedis } from './scripts.js';

/** A shop whose documents were never written: its storefront is not published. */
export class StoreMissingError extends Error {
  constructor(readonly shopId: string) {
    super(`The storefront of shop ${shopId} has no documents`);
    this.name = 'StoreMissingError';
  }
}

/**
 * A shop's documents in Valkey, each method one round trip, as the renderer expects: many
 * products with one `MGET`, a document by its handle through a script. One per request, as it
 * counts its round trips.
 */
export class RedisStore implements StoreData {
  roundTrips = 0;
  readonly #redis: ScriptedRedis;

  constructor(
    redis: Redis,
    private readonly shopId: string,
    private readonly keys = new StorefrontKeys(),
  ) {
    this.#redis = scripted(redis);
  }

  async shop(): Promise<ShopDoc> {
    const doc = parse<ShopDoc>(await this.#get(this.keys.shop(this.shopId)));
    if (!doc) throw new StoreMissingError(this.shopId);
    return doc;
  }

  productByHandle(handle: string): Promise<ProductDoc | null> {
    return this.#byHandle<ProductDoc>('product', handle);
  }

  async products(ids: readonly string[]): Promise<(ProductDoc | null)[]> {
    if (ids.length === 0) return [];
    this.roundTrips += 1;
    const docs = await this.#redis.mget(ids.map((id) => this.keys.doc(this.shopId, 'product', id)));
    return docs.map((doc) => parse<ProductDoc>(doc));
  }

  collectionByHandle(handle: string): Promise<CollectionDoc | null> {
    return this.#byHandle<CollectionDoc>('collection', handle);
  }

  async menu(handle: string): Promise<MenuDoc | null> {
    return parse(await this.#get(this.keys.menu(this.shopId, handle)));
  }

  async theme(): Promise<ThemeDoc | null> {
    return parse(await this.#get(this.keys.theme(this.shopId)));
  }

  async #byHandle<T>(kind: HandledKind, handle: string): Promise<T | null> {
    this.roundTrips += 1;
    const json = await this.#redis.sfByHandle(
      this.keys.ids(this.shopId, kind),
      handle,
      this.keys.doc(this.shopId, kind, ''),
    );
    return parse<T>(json);
  }

  #get(key: string): Promise<string | null> {
    this.roundTrips += 1;
    return this.#redis.get(key);
  }
}

function parse<T>(json: string | null | undefined): T | null {
  return json ? (JSON.parse(json) as T) : null;
}
