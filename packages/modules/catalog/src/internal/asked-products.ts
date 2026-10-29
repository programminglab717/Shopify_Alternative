import type { Tx } from '@hatti/db';
import { searchKey } from '@hatti/pk';
import { sql } from 'drizzle-orm';
import { DEFAULT_VARIANT_TITLE } from './product-store.js';

// The products a customer's message may be asking of (MSG-07, ADR-911), for the AI answering the
// shop's customers: the shop's products for sale holding the most of its words, with their
// variants and prices. Words every message has ("kya", "price", "please") find nothing.

/** The products a message finds, at most, and each one's variants. */
export const ASKED_PRODUCTS = { products: 3, variants: 20, words: 12 } as const;

/** English, Roman Urdu and Urdu words of any question, keyed as product search keys them. */
const COMMON = new Set(
  [
    'about',
    'also',
    'and',
    'any',
    'are',
    'available',
    'can',
    'colour',
    'color',
    'does',
    'for',
    'from',
    'have',
    'has',
    'hello',
    'how',
    'need',
    'order',
    'please',
    'plz',
    'pls',
    'price',
    'send',
    'size',
    'sizes',
    'stock',
    'thanks',
    'thank',
    'that',
    'the',
    'there',
    'this',
    'want',
    'what',
    'when',
    'where',
    'which',
    'will',
    'with',
    'you',
    'your',
    'kindly',
    'sir',
    'madam',
    'bhai',
    'salam',
    'assalam',
    'alaikum',
    'aoa',
    'hai',
    'hain',
    'kya',
    'kia',
    'mein',
    'main',
    'mujhe',
    'mjhe',
    'aap',
    'apka',
    'apke',
    'apki',
    'kitna',
    'kitne',
    'kitni',
    'kab',
    'kahan',
    'kaise',
    'kyun',
    'nahi',
    'nahin',
    'haan',
    'jee',
    'yeh',
    'woh',
    'abhi',
    'chahiye',
    'chahye',
    'milega',
    'milegi',
    'sakta',
    'sakti',
    'sakte',
    'hoga',
    'hogi',
    'wala',
    'wali',
    'wale',
    'bhi',
    'aur',
    'per',
    'tak',
    'rate',
    'qeemat',
    'کیا',
    'میں',
    'آپ',
    'اور',
    'بھی',
    'ہیں',
    'چاہیے',
    'قیمت',
    'سائز',
  ].map((word) => searchKey(word)),
);

/** A message's words a product may be found by: each once, as product search keys them. */
export function askedWordsOf(text: string): string[] {
  const words = searchKey(text)
    .split(' ')
    .filter((word) => [...word].length >= 3 && !/^\d+$/.test(word) && !COMMON.has(word));
  return [...new Set(words)].slice(0, ASKED_PRODUCTS.words);
}

export interface AskedProduct {
  productId: string;
  title: string;
  handle: string;
  variants: {
    variantId: string;
    /** "M / Red"; null for a product's only variant. */
    title: string | null;
    /** Minor units in the shop's currency. */
    price: bigint;
    compareAtPrice: bigint | null;
  }[];
}

/**
 * The shop's products for sale that `text` may be asking of, in the caller's transaction: those
 * holding a word of it at a word's start, the most of its words first, at most three.
 */
export async function askedProductsIn(
  tx: Tx,
  shopId: string,
  text: string,
): Promise<AskedProduct[]> {
  const words = askedWordsOf(text);
  if (words.length === 0) return [];
  // Keys hold only letters and digits, so no LIKE escaping.
  const patterns = sql.param(words.map((word) => `% ${word}%`));
  const { rows: products } = await tx.execute<{ id: string; title: string; handle: string }>(sql`
    SELECT p.id, p.title, p.handle
      FROM catalog.products p,
           LATERAL (SELECT ' ' || p.search_text || ' ' || p.translated_text AS searched) s
     WHERE p.shop_id = ${shopId} AND p.status = 'active'
       AND s.searched LIKE ANY(${patterns}::text[])
     ORDER BY (SELECT count(*) FROM unnest(${patterns}::text[]) w WHERE s.searched LIKE w) DESC,
              p.title, p.id
     LIMIT ${ASKED_PRODUCTS.products}`);
  if (products.length === 0) return [];
  const { rows: variants } = await tx.execute<{
    id: string;
    product_id: string;
    title: string;
    price: string;
    compare_at_price: string | null;
    only: boolean;
  }>(sql`
    SELECT v.id, v.product_id, v.title, v.price::text, v.compare_at_price::text,
           count(*) OVER (PARTITION BY v.product_id) = 1 AS only
      FROM (SELECT v.*, row_number() OVER (PARTITION BY v.product_id ORDER BY v.position, v.id) AS n
              FROM catalog.variants v
             WHERE v.shop_id = ${shopId}
               AND v.product_id = ANY(${sql.param(products.map((p) => p.id))}::uuid[])) v
     WHERE v.n <= ${ASKED_PRODUCTS.variants}
     ORDER BY v.product_id, v.position, v.id`);
  return products.map((product) => ({
    productId: product.id,
    title: product.title,
    handle: product.handle,
    variants: variants
      .filter((variant) => variant.product_id === product.id)
      .map((variant) => ({
        variantId: variant.id,
        title: variant.only || variant.title === DEFAULT_VARIANT_TITLE ? null : variant.title,
        price: BigInt(variant.price),
        compareAtPrice: variant.compare_at_price === null ? null : BigInt(variant.compare_at_price),
      })),
  }));
}
