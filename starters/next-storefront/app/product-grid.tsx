import Image from 'next/image';
import Link from 'next/link';
import { formatMoney } from '@/lib/money';
import type { ProductCard } from '@/lib/types';

/** Products as cards: picture, title and the lowest price, each to its page. */
export function ProductGrid({ products }: { products: ProductCard[] }) {
  if (products.length === 0) return <p>Nothing here yet.</p>;
  return (
    <ul className="grid">
      {products.map((product) => (
        <li key={product.id}>
          <Link href={`/products/${product.handle}`} className="card">
            {product.featuredImage && (
              <Image
                src={product.featuredImage.url}
                alt={product.featuredImage.altText ?? product.title}
                width={product.featuredImage.width ?? 600}
                height={product.featuredImage.height ?? 600}
                sizes="(max-width: 640px) 50vw, 25vw"
              />
            )}
            <span dir="auto">{product.title}</span>
            <strong>{formatMoney(product.priceRange.minVariantPrice)}</strong>
            {!product.availableForSale && <em>Sold out</em>}
          </Link>
        </li>
      ))}
    </ul>
  );
}
