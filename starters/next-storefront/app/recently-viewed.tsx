'use client';

import { useEffect, useState } from 'react';
import { ProductGrid } from '@/app/product-grid';
import { recentProducts } from '@/app/recent/actions';
import type { ProductCard } from '@/lib/types';
import type { Words } from '@/lib/words';

// Products the shopper viewed lately (ADR-961), kept in their browser: on a product's page, it put
// first and the others shown under it; on the home page, all of them. Signed in, they are kept
// with their account too (ADR-978), and those viewed on their other devices are shown as well.

const VIEWED_KEY = 'hatti_viewed';
/** This product, and the eight before it. */
const KEPT = 9;

function viewedBefore(): string[] {
  try {
    const kept: unknown = JSON.parse(window.localStorage.getItem(VIEWED_KEY) ?? '[]');
    return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function RecentlyViewed({
  productId = null,
  words,
}: {
  /** The product whose page this is, kept first; none on other pages. */
  productId?: string | null;
  words: Words;
}) {
  const [products, setProducts] = useState<ProductCard[]>([]);
  useEffect(() => {
    const others = viewedBefore().filter((id) => id !== productId);
    if (productId) {
      try {
        window.localStorage.setItem(
          VIEWED_KEY,
          JSON.stringify([productId, ...others].slice(0, KEPT)),
        );
      } catch {
        // Kept nowhere: shown nowhere.
      }
    }
    let shown = true;
    // Asked even with none kept here: a signed-in shopper's account may have some.
    void recentProducts(others.slice(0, KEPT - 1), productId).then(
      (cards) => shown && setProducts(cards),
      () => undefined,
    );
    return () => {
      shown = false;
    };
  }, [productId]);
  if (products.length === 0) return null;
  return (
    <section className="recent">
      <h2>{words.recentlyViewed}</h2>
      <ProductGrid products={products} words={words} />
    </section>
  );
}
