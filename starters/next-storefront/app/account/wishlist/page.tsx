import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { customerToken } from '@/app/account/actions';
import { removeFromWishlist } from '@/app/account/wishlist/actions';
import { storefront } from '@/lib/hatti';
import { languageCode, languageOf } from '@/lib/language';
import { formatMoney } from '@/lib/money';
import { CUSTOMER_WISHLIST_QUERY, PRODUCTS_BY_ID_QUERY } from '@/lib/queries';
import type { ProductCard } from '@/lib/types';
import { guestWishlist } from '@/lib/wishlist';
import { wordsOf } from '@/lib/words';

export const metadata = { title: 'Wishlist' };

/** The products kept on this device before signing in (ADR-957), those still sold. */
async function keptHere(language: string): Promise<ProductCard[]> {
  const ids = await guestWishlist();
  if (ids.length === 0) return [];
  const { nodes } = await storefront<{ nodes: (Partial<ProductCard> | null)[] }>(
    PRODUCTS_BY_ID_QUERY,
    { ids, language },
    { cache: 'none' },
  );
  return nodes.filter((node): node is ProductCard => Boolean(node?.id));
}

// The products the shopper keeps for later (ADR-953), each to its page or off the list, in their
// language: their account's once signed in, this device's before (ADR-957).
export default async function WishlistPage() {
  const token = await customerToken();
  const language = await languageOf();
  const words = wordsOf(language);
  let products: ProductCard[];
  if (token) {
    const { customer } = await storefront<{
      customer: { wishlist: { nodes: ProductCard[] } } | null;
    }>(
      CUSTOMER_WISHLIST_QUERY,
      { customerAccessToken: token, language: languageCode(language) },
      { cache: 'none' },
    );
    if (!customer) redirect('/account/login');
    products = customer.wishlist.nodes;
  } else {
    products = await keptHere(languageCode(language));
  }
  return (
    <>
      <h1>{words.wishlist}</h1>
      <p>
        {token ? (
          <Link href="/account">{words.backToAccount}</Link>
        ) : (
          <>
            {words.wishlistHere} <Link href="/account/login">{words.signIn}</Link>
          </>
        )}
      </p>
      {products.length === 0 ? (
        <p>{words.wishlistEmpty}</p>
      ) : (
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
                {!product.availableForSale && <em>{words.soldOut}</em>}
              </Link>
              <form action={removeFromWishlist}>
                <input type="hidden" name="productId" value={product.id} />
                <button type="submit" className="quiet">
                  {words.remove}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
