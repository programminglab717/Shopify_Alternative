import { notFound } from 'next/navigation';
import { ProductGrid } from '@/app/product-grid';
import { storefront } from '@/lib/hatti';
import { COLLECTION_QUERY } from '@/lib/queries';
import type { ProductCard } from '@/lib/types';

export default async function CollectionPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const { collection } = await storefront<{
    collection: {
      title: string;
      descriptionHtml: string;
      products: { nodes: ProductCard[] };
    } | null;
  }>(COLLECTION_QUERY, { handle, first: 48 });
  if (!collection) notFound();
  return (
    <>
      <h1 dir="auto">{collection.title}</h1>
      <div dir="auto" dangerouslySetInnerHTML={{ __html: collection.descriptionHtml }} />
      <ProductGrid products={collection.products.nodes} />
    </>
  );
}
