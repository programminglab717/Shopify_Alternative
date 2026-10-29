'use client';

import { useEffect, useState } from 'react';
import { ProductGrid } from '@/app/product-grid';
import { recentProducts } from '@/app/recent/actions';
import type { ProductCard } from '@/lib/types';
import type { Words } from '@/lib/words';

// Products the shopper viewed lately (ADR-961), kept in their browser alone: this one put first,
// the others shown under it. A browser that keeps nothing shows nothing.

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

export function RecentlyViewed({ productId, words }: { productId: string; words: Words }) {
  const [products, setProducts] = useState<ProductCard[]>([]);
  useEffect(() => {
    const others = viewedBefore().filter((id) => id !== productId);
    try {
      window.localStorage.setItem(
        VIEWED_KEY,
        JSON.stringify([productId, ...others].slice(0, KEPT)),
      );
    } catch {
      // Kept nowhere: shown nowhere.
    }
    let shown = true;
    if (others.length > 0) {
      void recentProducts(others.slice(0, KEPT - 1)).then(
        (cards) => shown && setProducts(cards),
        () => undefined,
      );
    }
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
