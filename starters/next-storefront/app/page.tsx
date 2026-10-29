import { storefront } from '@/lib/hatti';
import { languageCode, languageOf } from '@/lib/language';
import { PRODUCTS_QUERY } from '@/lib/queries';
import type { ProductCard } from '@/lib/types';
import { wordsOf } from '@/lib/words';
import { ProductGrid } from './product-grid';
import { RecentlyViewed } from './recently-viewed';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; after?: string }>;
}) {
  const { q, after } = await searchParams;
  const language = await languageOf();
  const words = wordsOf(language);
  const { products } = await storefront<{
    products: {
      nodes: ProductCard[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(PRODUCTS_QUERY, {
    first: 24,
    after: after ?? null,
    query: q ?? null,
    language: languageCode(language),
  });
  return (
    <>
      <form className="search" role="search">
        <input
          name="q"
          defaultValue={q}
          placeholder={words.search}
          aria-label={words.searchProducts}
        />
      </form>
      <ProductGrid products={products.nodes} words={words} />
      {/* What the shopper looked at before, on the first page of the shop's (ADR-961). */}
      {!q && !after && <RecentlyViewed words={words} />}
      {products.pageInfo.hasNextPage && products.pageInfo.endCursor && (
        <a
          className="more"
          href={`/?${new URLSearchParams({ ...(q && { q }), after: products.pageInfo.endCursor })}`}
        >
          {words.more}
        </a>
      )}
    </>
  );
}
