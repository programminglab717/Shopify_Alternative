import Image from 'next/image';
import { notFound } from 'next/navigation';
import { addToCart } from '@/app/actions';
import { saveForLater } from '@/app/account/wishlist/actions';
import { storefront } from '@/lib/hatti';
import { languageCode, languageOf } from '@/lib/language';
import { formatMoney } from '@/lib/money';
import { PRODUCT_QUERY } from '@/lib/queries';
import type { Product } from '@/lib/types';
import { wordsOf } from '@/lib/words';
import { RecentlyViewed } from './recently-viewed';

export default async function ProductPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const language = await languageOf();
  const words = wordsOf(language);
  const { product } = await storefront<{ product: Product | null }>(PRODUCT_QUERY, {
    handle,
    language: languageCode(language),
  });
  if (!product) notFound();
  const variants = product.variants.nodes;
  const first = variants.find((variant) => variant.availableForSale) ?? variants[0];
  return (
    <article className="product">
      <div className="gallery">
        {product.images.nodes.map((image) => (
          <Image
            key={image.url}
            src={image.url}
            alt={image.altText ?? product.title}
            width={image.width ?? 1200}
            height={image.height ?? 1200}
            sizes="(max-width: 640px) 100vw, 50vw"
          />
        ))}
      </div>
      <div className="details">
        <h1 dir="auto">{product.title}</h1>
        {first && <p className="price">{formatMoney(first.price)}</p>}
        <form action={addToCart} className="buy">
          {variants.length > 1 && (
            <label>
              {words.choose}
              <select name="variantId" defaultValue={first?.id}>
                {variants.map((variant) => (
                  <option key={variant.id} value={variant.id} disabled={!variant.availableForSale}>
                    {variant.title} · {formatMoney(variant.price)}
                    {variant.availableForSale ? '' : words.soldOutOption}
                  </option>
                ))}
              </select>
            </label>
          )}
          {variants.length === 1 && <input type="hidden" name="variantId" value={first?.id} />}
          <label>
            {words.quantity}
            <input name="quantity" type="number" min={1} defaultValue={1} inputMode="numeric" />
          </label>
          <button type="submit" disabled={!product.availableForSale}>
            {product.availableForSale ? words.addToCart : words.soldOut}
          </button>
        </form>
        {/* Kept for later with the shopper's account (ADR-953), or on this device before (ADR-957). */}
        <form action={saveForLater}>
          <input type="hidden" name="productId" value={product.id} />
          <button type="submit" className="quiet">
            {words.saveForLater}
          </button>
        </form>
        <div dir="auto" dangerouslySetInnerHTML={{ __html: product.descriptionHtml }} />
      </div>
      <RecentlyViewed productId={product.id} words={words} />
    </article>
  );
}
