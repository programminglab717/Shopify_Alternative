'use server';

import { storefront } from '@/lib/hatti';
import { languageCode, languageOf } from '@/lib/language';
import { PRODUCTS_BY_ID_QUERY } from '@/lib/queries';
import type { ProductCard } from '@/lib/types';

// Products the shopper viewed lately (ADR-961): their IDs are kept by their browser alone, and
// read here as cards, in one request, in their language.

/** The most shown. */
const MOST = 8;
const PRODUCT_ID = /^gid:\/\/hatti\/Product\/[\w-]{1,64}$/;

/** The cards of the products `ids` names, in their order, those no longer sold left out. */
export async function recentProducts(ids: unknown): Promise<ProductCard[]> {
  const wanted = Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string' && PRODUCT_ID.test(id))
    : [];
  if (wanted.length === 0) return [];
  const language = await languageOf();
  const { nodes } = await storefront<{ nodes: (Partial<ProductCard> | null)[] }>(
    PRODUCTS_BY_ID_QUERY,
    { ids: wanted.slice(0, MOST), language: languageCode(language) },
  );
  return nodes.filter((node): node is ProductCard => Boolean(node?.id));
}
