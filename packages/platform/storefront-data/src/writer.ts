import type {
  CollectionDoc,
  MenuDoc,
  PageDoc,
  ProductDoc,
  ShopDoc,
  ThemeDoc,
} from './documents.js';
import type { HandledKind, StorefrontKeys } from './keys.js';
import type { ScriptedRedis } from './scripts.js';

/** The shop's build lock went to another publisher: this one must stop writing. */
export class LockLostError extends Error {
  constructor(readonly shopId: string) {
    super(`Lost the storefront build lock of shop ${shopId}`);
    this.name = 'LockLostError';
  }
}

// Documents a script writes at a time: a product may take tens of kilobytes.
const CHUNK = 50;

// Redirects a script changes at a time: each is 3 kB at most.
const REDIRECT_CHUNK = 500;

/**
 * Writes a shop's storefront documents as the holder of its build lock, each call atomically:
 * a page never finds a handle that leads nowhere. Every write checks the lock and keeps it; once
 * it is lost, writes throw {@link LockLostError} and change nothing.
 */
export class ShopWriter {
  constructor(
    private readonly redis: ScriptedRedis,
    private readonly keys: StorefrontKeys,
    readonly shopId: string,
    private readonly token: string,
    private readonly lockMs: number,
  ) {}

  putProducts(docs: readonly ProductDoc[]): Promise<void> {
    return this.#put('product', docs);
  }

  /** Takes products off the storefront: deleted, or no longer active. */
  dropProducts(ids: readonly string[]): Promise<void> {
    return this.#drop('product', ids);
  }

  putCollections(docs: readonly CollectionDoc[]): Promise<void> {
    return this.#put('collection', docs);
  }

  dropCollections(ids: readonly string[]): Promise<void> {
    return this.#drop('collection', ids);
  }

  putPages(docs: readonly PageDoc[]): Promise<void> {
    return this.#put('page', docs);
  }

  /** Takes pages off the storefront: deleted, or no longer published. */
  dropPages(ids: readonly string[]): Promise<void> {
    return this.#drop('page', ids);
  }

  /** The shop's policies' bodies, by type, all of them: one it no longer has goes. */
  async putPolicies(bodies: Readonly<Record<string, string>>): Promise<void> {
    const pairs = Object.entries(bodies).flat();
    const [lock, hash] = [this.keys.lock(this.shopId), this.keys.policies(this.shopId)];
    this.#check(await this.redis.sfSetHash(lock, hash, this.token, this.lockMs, ...pairs));
  }

  /** The shop's menus, all of them: one it no longer has goes. */
  async putMenus(docs: readonly MenuDoc[]): Promise<void> {
    const pairs = docs.flatMap((doc) => [doc.handle, JSON.stringify(doc)]);
    const [lock, menus] = [this.keys.lock(this.shopId), this.keys.menus(this.shopId)];
    this.#check(await this.redis.sfSetHash(lock, menus, this.token, this.lockMs, ...pairs));
  }

  /**
   * The shop's URL redirects, all of them, by path (ADR-052): one it no longer has goes. Only what
   * changed is written, a chunk at a time, so a shop moving thousands of addresses from its old
   * store never holds Valkey up; meanwhile a path leads to its old target or its new one. Returns
   * the paths whose redirects came, changed or went.
   */
  async putRedirects(redirects: ReadonlyMap<string, string>): Promise<string[]> {
    const [lock, hash] = [this.keys.lock(this.shopId), this.keys.redirects(this.shopId)];
    const stored = new Map(Object.entries(await this.redis.hgetall(hash)));
    const gone = [...stored.keys()].filter((path) => !redirects.has(path));
    const set = [...redirects].filter(([path, target]) => stored.get(path) !== target);
    for (let start = 0; start < gone.length; start += REDIRECT_CHUNK) {
      const paths = gone.slice(start, start + REDIRECT_CHUNK);
      this.#check(
        await this.redis.sfChangeHash(lock, hash, this.token, this.lockMs, paths.length, ...paths),
      );
    }
    for (let start = 0; start < set.length; start += REDIRECT_CHUNK) {
      const pairs = set.slice(start, start + REDIRECT_CHUNK).flat();
      this.#check(await this.redis.sfChangeHash(lock, hash, this.token, this.lockMs, 0, ...pairs));
    }
    return [...gone, ...set.map(([path]) => path)];
  }

  putShop(doc: ShopDoc): Promise<void> {
    return this.#set([[this.keys.shop(this.shopId), doc]]);
  }

  putTheme(doc: ThemeDoc): Promise<void> {
    return this.#set([[this.keys.theme(this.shopId), doc]]);
  }

  /** The shop shows the platform theme as it is. */
  async dropTheme(): Promise<void> {
    const keys = [this.keys.lock(this.shopId), this.keys.theme(this.shopId)];
    this.#check(await this.redis.sfDel(keys.length, ...keys, this.token, this.lockMs));
  }

  async #put(
    kind: HandledKind,
    docs: readonly (ProductDoc | CollectionDoc | PageDoc)[],
  ): Promise<void> {
    for (let start = 0; start < docs.length; start += CHUNK) {
      const chunk = docs.slice(start, start + CHUNK);
      const keys = [...this.#handleKeys(kind), ...chunk.map((doc) => this.#doc(kind, doc.id))];
      const args = chunk.flatMap((doc) => [doc.id, doc.handle, JSON.stringify(doc)]);
      this.#check(await this.redis.sfPut(keys.length, ...keys, this.token, this.lockMs, ...args));
    }
  }

  async #drop(kind: HandledKind, ids: readonly string[]): Promise<void> {
    for (let start = 0; start < ids.length; start += CHUNK * 10) {
      const chunk = ids.slice(start, start + CHUNK * 10);
      const keys = [...this.#handleKeys(kind), ...chunk.map((id) => this.#doc(kind, id))];
      this.#check(await this.redis.sfDrop(keys.length, ...keys, this.token, this.lockMs, ...chunk));
    }
  }

  async #set(entries: [key: string, doc: object][]): Promise<void> {
    if (entries.length === 0) return;
    const keys = [this.keys.lock(this.shopId), ...entries.map(([key]) => key)];
    const values = entries.map(([, doc]) => JSON.stringify(doc));
    this.#check(await this.redis.sfSet(keys.length, ...keys, this.token, this.lockMs, ...values));
  }

  #handleKeys(kind: HandledKind): string[] {
    return [
      this.keys.lock(this.shopId),
      this.keys.ids(this.shopId, kind),
      this.keys.handles(this.shopId, kind),
    ];
  }

  #doc(kind: HandledKind, id: string): string {
    return this.keys.doc(this.shopId, kind, id);
  }

  #check(result: number | null): void {
    if (result === null) throw new LockLostError(this.shopId);
  }
}
