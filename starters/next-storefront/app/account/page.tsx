import Link from 'next/link';
import { redirect } from 'next/navigation';
import { addToCart } from '@/app/actions';
import { customerToken, signOut } from '@/app/account/actions';
import { storefront } from '@/lib/hatti';
import { languageOf } from '@/lib/language';
import { formatMoney } from '@/lib/money';
import { CUSTOMER_QUERY } from '@/lib/queries';
import type { Customer, Order } from '@/lib/types';
import { wordsOf, type Words } from '@/lib/words';

export const metadata = { title: 'Account' };

const statusOf = (order: Order, words: Words) =>
  order.status === 'CANCELLED'
    ? words.orderCancelled
    : order.status === 'CLOSED'
      ? words.orderClosed
      : words.orderOpen;

// The signed-in shopper's account (ADR-944): their orders with the shop, each line to buy again,
// and their store credit, read with the customer access token their cookie keeps. Never kept.
export default async function AccountPage() {
  const token = await customerToken();
  if (!token) redirect('/account/login');
  const { customer } = await storefront<{ customer: Customer | null }>(
    CUSTOMER_QUERY,
    { customerAccessToken: token },
    { cache: 'none' },
  );
  // Signed out, or expired: sign in again.
  if (!customer) redirect('/account/login');
  const language = await languageOf();
  const words = wordsOf(language);
  const dateOf = (at: string) =>
    new Date(at).toLocaleDateString(language === 'ur' ? 'ur-PK' : 'en-PK', { dateStyle: 'medium' });
  return (
    <>
      <h1 dir="auto">{customer.displayName}</h1>
      {Number(customer.storeCredit.amount) > 0 && (
        <p>
          {words.storeCredit} <strong>{formatMoney(customer.storeCredit)}</strong>
        </p>
      )}
      <h2>{words.yourOrders}</h2>
      {customer.orders.nodes.length === 0 ? (
        <p>{words.noOrders}</p>
      ) : (
        <ul className="orders">
          {customer.orders.nodes.map((order) => (
            <li key={order.id}>
              <p className="order-head">
                <strong>{order.name}</strong> <span>{dateOf(order.processedAt)}</span>{' '}
                <span>{statusOf(order, words)}</span>{' '}
                <strong>{formatMoney(order.totalPrice)}</strong>
              </p>
              <ul className="lines">
                {order.lineItems.nodes.map((line, at) => (
                  <li key={`${order.id}-${at}`}>
                    <span className="line-title" dir="auto">
                      {line.title}
                      {line.variantTitle && <small>{line.variantTitle}</small>}
                    </span>
                    <span>× {line.quantity}</span>
                    {line.availableForSale && line.merchandiseId && (
                      <form action={addToCart}>
                        <input type="hidden" name="variantId" value={line.merchandiseId} />
                        <input type="hidden" name="quantity" value={line.quantity} />
                        <button type="submit">{words.buyAgain}</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <p>
        <Link href="/account/addresses">{words.addresses}</Link>
      </p>
      <form action={signOut}>
        <button type="submit">{words.signOut}</button>
      </form>
    </>
  );
}
