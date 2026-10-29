'use server';

import { redirect } from 'next/navigation';
import { customerToken } from '@/app/account/actions';
import { storefront } from '@/lib/hatti';
import { CUSTOMER_WISHLIST_ADD_MUTATION, CUSTOMER_WISHLIST_REMOVE_MUTATION } from '@/lib/queries';

// The shopper's wishlist (ADR-953), kept with their account through the Storefront API
// (ADR-951): the same one the shop's own pages show them.

/** Keeps the form's product for later, then shows the wishlist; signing in first if need be. */
export async function saveForLater(form: FormData): Promise<void> {
  const token = await customerToken();
  if (!token) redirect('/account/login');
  await storefront(
    CUSTOMER_WISHLIST_ADD_MUTATION,
    { customerAccessToken: token, productIds: [String(form.get('productId') ?? '')] },
    { cache: 'none' },
  );
  redirect('/account/wishlist');
}

/** Takes the form's product off the wishlist. */
export async function removeFromWishlist(form: FormData): Promise<void> {
  const token = await customerToken();
  if (!token) redirect('/account/login');
  await storefront(
    CUSTOMER_WISHLIST_REMOVE_MUTATION,
    { customerAccessToken: token, productId: String(form.get('productId') ?? '') },
    { cache: 'none' },
  );
  redirect('/account/wishlist');
}
