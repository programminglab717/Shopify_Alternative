/** The most redirects a shop keeps: room for a large store moving from Shopify. */
export const REDIRECT_LIMIT = 20_000;

/** The languages whose pages are under a prefix, as Urdu's are under /ur (04 §5). */
const LOCALE_PREFIX = /^\/ur(?=\/|$)/;

/** What no address has as it is: spaces, control characters, and halves of characters. */
const UNSAFE = /[\s\p{Cc}\p{Cs}]/u;

/**
 * A redirect's path, as the storefront looks it up (ADR-052): a path on the shop, from a path or a
 * whole address pasted in, without its query, a trailing slash or the Urdu prefix, since a
 * redirect sends both languages' pages; lowercase and decoded, as the storefront-data package's
 * `redirectKey` keeps the paths shoppers ask for. Null for anything else, and for the home page,
 * which is always there.
 */
export function redirectPath(input: string): string | null {
  let path = input.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  path = path.split(/[?#]/, 1)[0]!;
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  try {
    path = decodeURI(path);
  } catch {
    return null;
  }
  path = path
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(LOCALE_PREFIX, '')
    .replace(/\/+$/, '');
  if (path === '' || path.length > 1024 || UNSAFE.test(path)) return null;
  return path;
}

/**
 * Where a redirect sends shoppers: a path on the shop, with its query if it has one, or an
 * http(s) address elsewhere; null for anything else.
 */
export function redirectTarget(input: string): string | null {
  const target = input.trim();
  if (target.length === 0 || target.length > 2048 || UNSAFE.test(target)) return null;
  if (target.startsWith('/')) return target.startsWith('//') ? null : target;
  try {
    const url = new URL(target);
    return url.protocol === 'https:' || url.protocol === 'http:' ? target : null;
  } catch {
    return null;
  }
}
