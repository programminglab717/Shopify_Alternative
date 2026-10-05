/**
 * The documents found by handle as well as by ID. An article is found by its blog's handle and
 * its own, as `news/eid-edit` (ADR-177).
 */
export type HandledKind = 'product' | 'collection' | 'page' | 'blog' | 'article';

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

  /** A product's, collection's, page's, blog's or article's document. */
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

  /** The shop's policies' bodies: a hash by type, written whole. */
  policies(shopId: string): string {
    return `${this.#base(shopId)}:policies`;
  }

  /** The shop's URL redirects: a hash of targets by path, in {@link redirectKey}'s form. */
  redirects(shopId: string): string {
    return `${this.#base(shopId)}:redirects`;
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

  /** The cell's shops by their own domains: a hash, beside the one by handle. */
  domains(): string {
    return `${this.prefix}:sf:domains`;
  }

  /** Where storefronts count what shoppers do, such as changes to carts, to limit it. */
  rateLimits(): string {
    return `${this.prefix}:sf:rl`;
  }

  /**
   * A day's sessions on the shop's storefront, in its time zone, or those of them that took
   * `step`: a HyperLogLog of their IDs (ADR-180). Beside its documents, not among them, so
   * clearing those leaves the counts.
   */
  activity(shopId: string, day: string, step: ActivityStep): string {
    return `${this.prefix}:{${shopId}}:an:${day}:${step}`;
  }

  /** The shop's sessions by when each was last seen, in milliseconds: a sorted set. */
  live(shopId: string): string {
    return `${this.prefix}:{${shopId}}:an:live`;
  }

  /** Shops' days whose counts changed since the worker last kept them: "{shopId} {day}". */
  activityChanged(): string {
    return `${this.prefix}:an:changed`;
  }

  #base(shopId: string): string {
    return `${this.prefix}:{${shopId}}:sf`;
  }
}

/**
 * What a storefront counts of a day's sessions (ADR-180): them all, and those that added to the
 * cart, reached checkout and placed an order, as Shopify's conversion funnel has them.
 */
export const ACTIVITY_STEPS = [
  'sessions',
  'added_to_cart',
  'reached_checkout',
  'converted',
] as const;
export type ActivityStep = (typeof ACTIVITY_STEPS)[number];

/**
 * A path as a shop's URL redirects are kept by (ADR-052), from the path a shopper asked for, less
 * its language's prefix: decoded, lowercase, and without repeated or trailing slashes. The online
 * store keeps a redirect's path in this form, so however a link wrote it, it is found.
 */
export function redirectKey(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURI(path);
  } catch {
    // Kept as it came: a path the online store would not take finds nothing.
  }
  return decoded
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}
