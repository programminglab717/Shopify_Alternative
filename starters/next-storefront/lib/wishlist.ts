import { cookies } from 'next/headers';

// A wishlist kept before signing in (ADR-957): the products' IDs, the newest first, in a cookie
// only this server reads, until the shopper signs in and they join their account's.

const WISHLIST_COOKIE = 'hatti_wishlist';

/** The most a wishlist kept here holds, as the account's page shows. */
export const GUEST_WISHLIST_MOST = 50;

/** The products kept here, the newest first; none where the cookie says nothing sensible. */
export async function guestWishlist(): Promise<string[]> {
  const kept = (await cookies()).get(WISHLIST_COOKIE)?.value;
  if (!kept) return [];
  try {
    const ids: unknown = JSON.parse(kept);
    return Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === 'string').slice(0, GUEST_WISHLIST_MOST)
      : [];
  } catch {
    return [];
  }
}

/** Keeps `ids` as the wishlist here, for a year; none clears it. */
export async function keepGuestWishlist(ids: readonly string[]): Promise<void> {
  const jar = await cookies();
  if (ids.length === 0) {
    jar.delete(WISHLIST_COOKIE);
    return;
  }
  jar.set(WISHLIST_COOKIE, JSON.stringify(ids.slice(0, GUEST_WISHLIST_MOST)), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 365 * 86_400,
    path: '/',
  });
}
