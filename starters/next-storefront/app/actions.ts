'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { storefront } from '@/lib/hatti';
import {
  CART_CREATE_MUTATION,
  CART_LINES_ADD_MUTATION,
  CART_LINES_REMOVE_MUTATION,
  CART_LINES_UPDATE_MUTATION,
} from '@/lib/queries';

// The shopper's cart: its ID kept in a cookie of this site's, its lines changed through the
// Storefront API. Checkout is the shop's own, at the cart's checkoutUrl.

const CART_COOKIE = 'hatti_cart';

type Changed = { cart: { id: string } | null; userErrors: { message: string }[] };

async function keep(changed: Changed): Promise<void> {
  if (changed.userErrors[0]) throw new Error(changed.userErrors[0].message);
  if (!changed.cart) return;
  (await cookies()).set(CART_COOKIE, changed.cart.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 14,
    path: '/',
  });
}

/** The cart's ID this shopper keeps; null before they add anything. */
export async function cartId(): Promise<string | null> {
  return (await cookies()).get(CART_COOKIE)?.value ?? null;
}

/** Adds the variant the product's form chose, then shows the cart. */
export async function addToCart(form: FormData): Promise<void> {
  const merchandiseId = String(form.get('variantId') ?? '');
  const quantity = Math.max(1, Number(form.get('quantity') ?? 1) || 1);
  const lines = [{ merchandiseId, quantity }];
  const id = await cartId();
  if (id) {
    const { cartLinesAdd } = await storefront<{ cartLinesAdd: Changed }>(
      CART_LINES_ADD_MUTATION,
      { cartId: id, lines },
      { cache: 'none' },
    );
    await keep(cartLinesAdd);
  } else {
    const { cartCreate } = await storefront<{ cartCreate: Changed }>(
      CART_CREATE_MUTATION,
      { lines },
      { cache: 'none' },
    );
    await keep(cartCreate);
  }
  redirect('/cart');
}

/** Sets a line's quantity; nothing takes it out. */
export async function updateLine(form: FormData): Promise<void> {
  const id = await cartId();
  if (!id) return;
  const lineId = String(form.get('lineId') ?? '');
  const quantity = Math.max(0, Number(form.get('quantity') ?? 0) || 0);
  if (quantity === 0) {
    const { cartLinesRemove } = await storefront<{ cartLinesRemove: Changed }>(
      CART_LINES_REMOVE_MUTATION,
      { cartId: id, lineIds: [lineId] },
      { cache: 'none' },
    );
    await keep(cartLinesRemove);
  } else {
    const { cartLinesUpdate } = await storefront<{ cartLinesUpdate: Changed }>(
      CART_LINES_UPDATE_MUTATION,
      { cartId: id, lines: [{ id: lineId, quantity }] },
      { cache: 'none' },
    );
    await keep(cartLinesUpdate);
  }
  redirect('/cart');
}
