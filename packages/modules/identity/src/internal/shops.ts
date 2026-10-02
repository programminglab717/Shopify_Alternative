// Opening a shop (ONB-01, ADR-145): the rules for its name and its handle, which names its
// storefront on the platform's domain, as zari for zari.hatti.pk, and its event.

/** The events of shops' lives that identity records. */
export const ShopEvents = {
  /** A user opened a shop of their own: its storefront is published for the first time. */
  ShopOpened: 'shop.opened',
} as const;

export interface ShopOpenedPayload {
  handle: string;
}

/** What opening a shop takes, at most. */
export const SHOP_LIMITS = {
  name: 255,
  /** Shops a user may own, the subscription of each its own. */
  ownedShops: 5,
} as const;

/** As control.shops checks it: letters and digits, hyphens between them, 1 to 40 of them. */
const HANDLE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Handles the platform keeps for its own subdomains, or that shoppers would mistake for its own:
 * a shop never has one.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'about',
  'account',
  'accounts',
  'admin',
  'api',
  'app',
  'apps',
  'assets',
  'auth',
  'billing',
  'blog',
  'cdn',
  'checkout',
  'checkouts',
  'dashboard',
  'dev',
  'docs',
  'email',
  'files',
  'hatti',
  'help',
  'images',
  'img',
  'login',
  'mail',
  'media',
  'partners',
  'pay',
  'payments',
  'shop',
  'shops',
  'signin',
  'signup',
  'staging',
  'static',
  'status',
  'store',
  'stores',
  'support',
  'test',
  'www',
]);

/** Why `handle` cannot name a shop; null when it can, taken or not. */
export function handleProblem(handle: string): string | null {
  if (!HANDLE.test(handle) || handle.includes('--')) {
    return 'Use 1 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit';
  }
  if (RESERVED_HANDLES.has(handle)) return 'This handle is kept for the platform';
  return null;
}

/**
 * A handle made from a shop's name: its Latin letters and digits in lower case, words joined by
 * hyphens, at most 40 characters; "shop" for a name without them, as one written in Urdu.
 */
export function handleFrom(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let handle = '';
  for (const word of words) {
    const next = handle ? `${handle}-${word}` : word;
    if (next.length > 40) break;
    handle = next;
  }
  if (!handle) handle = words[0]?.slice(0, 40) ?? '';
  return handle && !RESERVED_HANDLES.has(handle) ? handle : `${handle || 'shop'}-store`;
}
