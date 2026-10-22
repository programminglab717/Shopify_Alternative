import { randomBytes } from 'node:crypto';
import type { Db } from '@hatti/db';
import { sql } from 'drizzle-orm';
import { AuthError } from './errors.js';

// Opening a shop (ONB-01, ADR-145): the rules for its name and its handle, which names its
// storefront on the platform's domain, as zari for zari.hatti.pk, and its events.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The events of shops' lives that identity records. */
export const ShopEvents = {
  /** A user opened a shop of their own: its storefront is published for the first time. */
  ShopOpened: 'shop.opened',
  /** A partner's development store went to its client, and opens to shoppers (ADR-504). */
  DevelopmentStoreTransferred: 'shop.development_store_transferred',
  /** Its owner closed it (ADR-740): its storefront goes, and its data in 90 days. */
  ShopClosed: 'shop.closed',
  /** Its owner reopened it within the 90 days: its storefront is published again. */
  ShopReopened: 'shop.reopened',
} as const;

export interface ShopOpenedPayload {
  handle: string;
}

export interface ShopClosedPayload {
  /** ISO 8601: when it closed, from which its data is deleted after `CLOSED_SHOP_DAYS`. */
  closedAt: string;
}

/** How long a closed shop's data stays, for its owner to export it or reopen the shop (ADR-740). */
export const CLOSED_SHOP_DAYS = 90;

/** What opening a shop takes, at most. */
export const SHOP_LIMITS = {
  name: 255,
  /** Shops a user may own, the subscription of each its own. */
  ownedShops: 5,
  /** Development stores a partner may build at once, none of them counted among those (ADR-504). */
  developmentStores: 20,
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

/**
 * Adds the shop under `handle`, or, `numbered`, the first of `handle-2`, `handle-3` … no other
 * shop has; the handle it took. A partner's development store (ADR-504) is closed to shoppers.
 */
export async function insertShop(
  tx: Tx,
  shopId: string,
  name: string,
  handle: string,
  options: { numbered: boolean; development?: boolean },
): Promise<string> {
  const development = options.development ?? false;
  // The identity login inserts these columns alone; the others take the table's defaults.
  const insert = async (candidate: string) =>
    (
      await tx.execute(sql`
        INSERT INTO control.shops (id, name, handle, development)
             VALUES (${shopId}, ${name}, ${candidate}, ${development})
            ON CONFLICT (handle) DO NOTHING
        RETURNING handle`)
    ).rows.length > 0;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    const candidate = `${handle.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (await insert(candidate)) return candidate;
    if (!options.numbered) break;
  }
  if (options.numbered) {
    // Twenty taken: a random suffix, as unlikely to be taken as a shop's ID.
    const candidate = `${handle.slice(0, 31).replace(/-+$/, '')}-${randomBytes(4).toString('hex')}`;
    if (await insert(candidate)) return candidate;
  }
  throw new AuthError('HANDLE_TAKEN', 409, 'Another shop has this handle', {
    fields: { handle: 'Taken by another shop' },
  });
}
