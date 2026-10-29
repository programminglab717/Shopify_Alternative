'use server';

import { redirect } from 'next/navigation';
import { customerToken } from '@/app/account/actions';
import { storefront } from '@/lib/hatti';
import { CUSTOMER_WISHLIST_ADD_MUTATION, CUSTOMER_WISHLIST_REMOVE_MUTATION } from '@/lib/queries';
import { guestWishlist, keepGuestWishlist } from '@/lib/wishlist';

// The shopper's wishlist (ADR-953), kept with their account through the Storefront API
// (ADR-951): the same one the shop's own pages show them. Before they sign in, it is kept here
// (ADR-957), and joins their account's when they do.

/** Keeps the form's product for later, then shows the wishlist. */
export async function saveForLater(form: FormData): Promise<void> {
  const productId = String(form.get('productId') ?? '');
  const token = await customerToken();
  if (!token) {
    const kept = await guestWishlist();
    await keepGuestWishlist([productId, ...kept.filter((id) => id !== productId)]);
    redirect('/account/wishlist');
  }
  await storefront(
    CUSTOMER_WISHLIST_ADD_MUTATION,
    { customerAccessToken: token, productIds: [productId] },
    { cache: 'none' },
  );
  redirect('/account/wishlist');
}

/** Takes the form's product off the wishlist. */
export async function removeFromWishlist(form: FormData): Promise<void> {
  const productId = String(form.get('productId') ?? '');
  const token = await customerToken();
  if (!token) {
    await keepGuestWishlist((await guestWishlist()).filter((id) => id !== productId));
    redirect('/account/wishlist');
  }
  await storefront(
    CUSTOMER_WISHLIST_REMOVE_MUTATION,
    { customerAccessToken: token, productId },
    { cache: 'none' },
  );
  redirect('/account/wishlist');
}
