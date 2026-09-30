/** The documents found by handle as well as by ID. */
export type HandledKind = 'product' | 'collection';

/**
 * Where a shop's storefront documents are kept in Valkey (03 §8). The shop's ID sits in braces, a
 * hash tag, so all of a shop's keys land in one slot of a cluster, and a script may read a key it
 * learns on the way, as a product's by its handle. The prefix is "s" but in tests.
 */
export class StorefrontKeys {
  constructor(private readonly prefix = 's') {}

  shop(shopId: string): string {
    return `${this.#base(shopId)}:shop`;
  }

  /** A product's or collection's document. */
  doc(shopId: string, kind: HandledKind, id: string): string {
    return `${this.#base(shopId)}:${kind}:${id}`;
  }

  /** A hash of IDs by handle, to find a document by the handle in its URL. */
  ids(shopId: string, kind: HandledKind): string {
    return `${this.#base(shopId)}:${kind}-ids`;
  }

  /** A hash of handles by ID, to let go of a document's old handle when it changes. */
  handles(shopId: string, kind: HandledKind): string {
    return `${this.#base(shopId)}:${kind}-handles`;
  }

  /** The shop's theme files, over the platform theme's. */
  theme(shopId: string): string {
    return `${this.#base(shopId)}:theme`;
  }

  /** The shop's menus, a hash by handle, written whole. */
  menus(shopId: string): string {
    return `${this.#base(shopId)}:menus`;
  }

  /** What is waiting to be built (see the core's storefront publisher). */
  pending(shopId: string): string {
    return `${this.#base(shopId)}:pending`;
  }

  /** What the publisher holding the lock took from `pending` and is building. */
  taken(shopId: string): string {
    return `${this.#base(shopId)}:taken`;
  }

  lock(shopId: string): string {
    return `${this.#base(shopId)}:lock`;
  }

  /** Every key of the shop's, for SCAN. */
  all(shopId: string): string {
    return `${this.#base(shopId)}:*`;
  }

  /** The cell's shops by handle: a hash, and the one key no shop owns. */
  directory(): string {
    return `${this.prefix}:sf:shops`;
  }

  /** Where storefronts count what shoppers do, such as changes to carts, to limit it. */
  rateLimits(): string {
    return `${this.prefix}:sf:rl`;
  }

  #base(shopId: string): string {
    return `${this.prefix}:{${shopId}}:sf`;
  }
}
