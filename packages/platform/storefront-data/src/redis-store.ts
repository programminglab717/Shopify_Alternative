import type { Redis } from 'ioredis';
import type {
  ArticleDoc,
  BlogDoc,
  CollectionDoc,
  MenuDoc,
  PageDoc,
  ProductDoc,
  ShopDoc,
  SitemapEntry,
  SitemapEntryDoc,
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
  #shop: Promise<ShopDoc> | undefined;

  constructor(
    redis: Redis,
    private readonly shopId: string,
    private readonly keys = new StorefrontKeys(),
  ) {
    this.#redis = scripted(redis);
  }

  /** Fetched once: a request asks for it more than once, as to see if the shop is closed. */
  shop(): Promise<ShopDoc> {
    this.#shop ??= this.#get(this.keys.shop(this.shopId)).then((json) => {
      const doc = parse<ShopDoc>(json);
      if (!doc) throw new StoreMissingError(this.shopId);
      return doc;
    });
    return this.#shop;
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
    this.roundTrips += 1;
    return parse(await this.#redis.hget(this.keys.menus(this.shopId), handle));
  }

  pageByHandle(handle: string): Promise<PageDoc | null> {
    return this.#byHandle<PageDoc>('page', handle);
  }

  blogByHandle(handle: string): Promise<BlogDoc | null> {
    return this.#byHandle<BlogDoc>('blog', handle);
  }

  articleByHandle(handle: string): Promise<ArticleDoc | null> {
    return this.#byHandle<ArticleDoc>('article', handle);
  }

  async pages(ids: readonly string[]): Promise<(PageDoc | null)[]> {
    if (ids.length === 0) return [];
    this.roundTrips += 1;
    const docs = await this.#redis.mget(ids.map((id) => this.keys.doc(this.shopId, 'page', id)));
    return docs.map((doc) => parse<PageDoc>(doc));
  }

  async articles(ids: readonly string[]): Promise<(ArticleDoc | null)[]> {
    if (ids.length === 0) return [];
    this.roundTrips += 1;
    const docs = await this.#redis.mget(ids.map((id) => this.keys.doc(this.shopId, 'article', id)));
    return docs.map((doc) => parse<ArticleDoc>(doc));
  }

  async redirect(path: string): Promise<string | null> {
    this.roundTrips += 1;
    return this.#redis.hget(this.keys.redirects(this.shopId), path);
  }

  async policy(type: string): Promise<string | null> {
    this.roundTrips += 1;
    return this.#redis.hget(this.keys.policies(this.shopId), type);
  }

  async theme(): Promise<ThemeDoc | null> {
    return parse(await this.#get(this.keys.theme(this.shopId)));
  }

  async handles(kind: HandledKind): Promise<string[]> {
    this.roundTrips += 1;
    return this.#redis.hkeys(this.keys.ids(this.shopId, kind));
  }

  async productIds(): Promise<string[]> {
    this.roundTrips += 1;
    // The hash of handles by ID has each product once.
    return this.#redis.hkeys(this.keys.handles(this.shopId, 'product'));
  }

  async sitemap(kind: HandledKind): Promise<SitemapEntry[]> {
    this.roundTrips += 1;
    const answers = await this.#redis
      .pipeline()
      .hgetall(this.keys.ids(this.shopId, kind))
      .hgetall(this.keys.sitemap(this.shopId, kind))
      .exec();
    const [ids, entries] = (answers ?? []).map(([error, value]) => {
      if (error) throw error;
      return value as Record<string, string>;
    });
    // A document written before sitemaps kept entries (ADR-236) has none until written again.
    return Object.entries(ids ?? {}).map(([handle, id]) => {
      const entry = entries?.[id];
      const parsed: SitemapEntryDoc = entry
        ? (JSON.parse(entry) as SitemapEntryDoc)
        : { at: null, image: null };
      return { handle, ...parsed };
    });
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
