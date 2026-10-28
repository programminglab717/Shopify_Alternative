import { storefront } from '@/lib/hatti';
import { PRODUCTS_QUERY } from '@/lib/queries';
import type { ProductCard } from '@/lib/types';
import { ProductGrid } from './product-grid';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; after?: string }>;
}) {
  const { q, after } = await searchParams;
  const { products } = await storefront<{
    products: {
      nodes: ProductCard[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(PRODUCTS_QUERY, { first: 24, after: after ?? null, query: q ?? null });
  return (
    <>
      <form className="search" role="search">
        <input name="q" defaultValue={q} placeholder="Search" aria-label="Search products" />
      </form>
      <ProductGrid products={products.nodes} />
      {products.pageInfo.hasNextPage && products.pageInfo.endCursor && (
        <a
          className="more"
          href={`/?${new URLSearchParams({ ...(q && { q }), after: products.pageInfo.endCursor })}`}
        >
          More products
        </a>
      )}
    </>
  );
}
