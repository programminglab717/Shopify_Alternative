'use server';

import { customerToken } from '@/app/account/actions';
import { storefront } from '@/lib/hatti';
import { languageCode, languageOf } from '@/lib/language';
import {
  CUSTOMER_RECENTLY_VIEWED_ADD_MUTATION,
  CUSTOMER_RECENTLY_VIEWED_QUERY,
  PRODUCTS_BY_ID_QUERY,
} from '@/lib/queries';
import type { ProductCard } from '@/lib/types';

// Products the shopper viewed lately (ADR-961): their IDs are kept by their browser, and read here
// as cards, in one request, in their language. Signed in, they are kept with the shopper's account
// too (ADR-978): the browser's join the account's, and the account's, from any device, are shown.

/** The most shown. */
const MOST = 8;
const PRODUCT_ID = /^gid:\/\/hatti\/Product\/[\w-]{1,64}$/;

type Viewed = { nodes: (Partial<ProductCard> | null)[] };

/**
 * The cards of the products the shopper viewed: those `ids` names, in their order, those no longer
 * sold left out. Signed in, `viewing` and `ids` are added to their account's, and its list, but for
 * `viewing`, is shown.
 */
export async function recentProducts(ids: unknown, viewing?: unknown): Promise<ProductCard[]> {
  const wanted = Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string' && PRODUCT_ID.test(id))
    : [];
  const current = typeof viewing === 'string' && PRODUCT_ID.test(viewing) ? viewing : null;
  const language = languageCode(await languageOf());
  const cards = (viewed: Viewed | null | undefined) =>
    (viewed?.nodes ?? [])
      .filter((node): node is ProductCard => Boolean(node?.id) && node?.id !== current)
      .slice(0, MOST);
  const token = await customerToken();
  if (token) {
    const added = [...(current ? [current] : []), ...wanted.filter((id) => id !== current)];
    if (added.length > 0) {
      const { customerRecentlyViewedAdd } = await storefront<{
        customerRecentlyViewedAdd: { customer: { recentlyViewed: Viewed } | null } | null;
      }>(CUSTOMER_RECENTLY_VIEWED_ADD_MUTATION, {
        customerAccessToken: token,
        productIds: added.slice(0, 20),
        language,
      });
      const viewed = customerRecentlyViewedAdd?.customer?.recentlyViewed;
      if (viewed) return cards(viewed);
    } else {
      const { customer } = await storefront<{ customer: { recentlyViewed: Viewed } | null }>(
        CUSTOMER_RECENTLY_VIEWED_QUERY,
        { customerAccessToken: token, language },
      );
      if (customer) return cards(customer.recentlyViewed);
    }
  }
  if (wanted.length === 0) return [];
  const { nodes } = await storefront<Viewed>(PRODUCTS_BY_ID_QUERY, {
    ids: wanted.slice(0, MOST),
    language,
  });
  return cards({ nodes });
}
