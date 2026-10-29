import Image from 'next/image';
import Link from 'next/link';
import { cartId, updateLine } from '@/app/actions';
import { storefront } from '@/lib/hatti';
import { languageCode, languageOf } from '@/lib/language';
import { formatMoney } from '@/lib/money';
import { CART_QUERY } from '@/lib/queries';
import type { Cart } from '@/lib/types';
import { wordsOf } from '@/lib/words';

export default async function CartPage() {
  const id = await cartId();
  const language = await languageOf();
  const words = wordsOf(language);
  const cart = id
    ? (
        await storefront<{ cart: Cart | null }>(
          CART_QUERY,
          { id, language: languageCode(language) },
          { cache: 'none' },
        )
      ).cart
    : null;
  if (!cart || cart.totalQuantity === 0) {
    return (
      <>
        <h1>{words.yourCart}</h1>
        <p>
          {words.emptyCart} <Link href="/">{words.shopNow}</Link>
        </p>
      </>
    );
  }
  return (
    <>
      <h1>{words.yourCart}</h1>
      <ul className="lines">
        {cart.lines.nodes.map((line) => (
          <li key={line.id}>
            {line.merchandise.image && (
              <Image
                src={line.merchandise.image.url}
                alt={line.merchandise.image.altText ?? line.merchandise.product.title}
                width={80}
                height={80}
              />
            )}
            <span className="line-title" dir="auto">
              <Link href={`/products/${line.merchandise.product.handle}`}>
                {line.merchandise.product.title}
              </Link>
              {line.merchandise.title !== 'Default Title' && (
                <small>{line.merchandise.title}</small>
              )}
            </span>
            <form action={updateLine}>
              <input type="hidden" name="lineId" value={line.id} />
              <input
                name="quantity"
                type="number"
                min={0}
                defaultValue={line.quantity}
                aria-label={`${words.quantityOf} ${line.merchandise.product.title}`}
              />
              <button type="submit">{words.update}</button>
            </form>
            <strong>{formatMoney(line.cost.totalAmount)}</strong>
          </li>
        ))}
      </ul>
      <p className="total">
        {words.subtotal} <strong>{formatMoney(cart.cost.subtotalAmount)}</strong>
      </p>
      {/* The shop's own checkout: address, delivery, cash on delivery or paying online. */}
      <a className="checkout" href={cart.checkoutUrl}>
        {words.checkout}
      </a>
    </>
  );
}
