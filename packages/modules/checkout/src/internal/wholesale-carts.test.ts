import 'reflect-metadata';
import { CustomerService } from '@hatti/customers/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { PriceListService } from '@hatti/pricing/public';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction, type CartAction } from './cart-lines.js';
import type { CheckoutForm } from './checkout.service.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

const JAZZ = '+923001234567';

const FORM: CheckoutForm = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  city: 'Lahore',
  address1: 'House 12, Street 4',
  address2: '',
  landmark: '',
  province: '',
  payment: '',
  code: '',
  resend: '',
};

function action(name: 'add' | 'change', body: unknown): CartAction {
  const parsed = parseAction(name, body);
  if ('code' in parsed) throw new Error(`Refused: ${JSON.stringify(parsed)}`);
  return parsed;
}

describe.skipIf(!server)("A wholesale customer's cart and checkout (CUS-06, ADR-780)", () => {
  let f: CheckoutFixture;
  let kurta: string;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM pricing.price_lists');
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 100);
    unwrap(
      await new CustomerService(f.db).create(f.a, {
        phone: '0300 1234567',
        name: 'Ayesha Khan',
        tags: ['Wholesale'],
      }),
    );
    unwrap(
      await new PriceListService(f.db).create(f.a, {
        name: 'Wholesale',
        customerTag: 'wholesale',
        percentOff: '20',
        quantityBreaks: [{ minQuantity: 12, percentOff: '5' }],
      }),
    );
  });

  /** Signs Ayesha in to the shop with the code sent to her: the session's token. */
  async function signIn(): Promise<string> {
    expect(await f.accounts.startSignIn(f.a.shopId, { phone: JAZZ })).toMatchObject({
      kind: 'sent',
    });
    const { rows } = await f.admin.query<{ code: string }>(
      `SELECT variables ->> 'code' AS code FROM messaging.messages
        WHERE kind = 'account_code' ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    const verified = await f.accounts.verifySignIn(f.a.shopId, {
      phone: JAZZ,
      code: rows[0]!.code,
    });
    if (verified.kind !== 'signed_in') throw new Error(`Expected signed in, got ${verified.kind}`);
    return verified.token;
  }

  it('prices the cart of a shopper signed in from their price list, while they stay signed in', async () => {
    const account = await signIn();
    const add = action('add', { items: [{ variantId: kurta, quantity: 2 }] });
    // Anyone else's cart: the price to anyone.
    const theirs = await f.carts.act(f.a.shopId, null, add);
    expect(theirs.ok && theirs.cart.items[0]!.price).toBe(200_000);

    const added = await f.carts.act(f.a.shopId, null, add, account);
    if (!added.ok) throw new Error('Refused');
    expect(added.cart.items[0]).toMatchObject({ price: 160_000, linePrice: 320_000 });
    // The cart keeps whose it is: read without the session, its prices stay hers.
    expect((await f.carts.cart(f.a.shopId, added.token!))!.subtotal).toBe(320_000);
    // A dozen reaches the list's break: 5% more off.
    const changed = await f.carts.act(
      f.a.shopId,
      added.token,
      action('change', { line: { variantId: kurta }, quantity: 12 }),
    );
    expect(changed.ok && changed.cart.items[0]!.price).toBe(152_000);

    // Checkout and the order placed from the cart keep the price.
    const secret = (await f.checkouts.start(f.a.shopId, added.token!))!;
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    const placed = await f.checkouts.place(secret, view.shown, FORM);
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    const { rows } = await f.admin.query<{ unit_price: string; quantity: number }>(
      'SELECT unit_price, quantity FROM orders.lines',
    );
    expect(rows).toEqual([{ unit_price: '152000', quantity: 12 }]);
  });

  it('prices a cart read signed in, and the price to anyone once she signs out', async () => {
    const add = action('add', { items: [{ variantId: kurta, quantity: 1 }] });
    const added = await f.carts.act(f.a.shopId, null, add);
    if (!added.ok) throw new Error('Refused');
    expect(added.cart.items[0]!.price).toBe(200_000);
    const account = await signIn();
    // A session that is not one prices nothing.
    expect((await f.carts.cart(f.a.shopId, added.token!, 'x'.repeat(43)))!.subtotal).toBe(200_000);
    expect((await f.carts.cart(f.a.shopId, added.token!, account))!.subtotal).toBe(160_000);
    expect(await f.accounts.signOut(f.a.shopId, account)).toBe(true);
    expect((await f.carts.cart(f.a.shopId, added.token!))!.subtotal).toBe(200_000);
    // Her session is the shop's alone: in another shop's cart it prices nothing.
    const [shawl] = (await f.variantsOf(f.b, 'Shawl', { price: '2,000' })) as [string];
    await f.stock(f.b, shawl, 10);
    const again = await signIn();
    const elsewhere = await f.carts.act(
      f.b.shopId,
      null,
      action('add', { items: [{ variantId: shawl, quantity: 1 }] }),
      again,
    );
    expect(elsewhere.ok && elsewhere.cart.items[0]!.price).toBe(200_000);
  });

  it('answers what one of each variant costs her, for the product pages (ADR-781)', async () => {
    const [shawl] = (await f.variantsOf(f.a, 'Shawl', { price: '1,000' })) as [string];
    const account = await signIn();
    expect(await f.carts.listedPrices(f.a.shopId, account, [kurta, shawl, kurta])).toEqual(
      new Map([
        [kurta, 160_000n],
        [shawl, 80_000n],
      ]),
    );
    // A dozen's break is not one's price; a draft product, nor a session that is not one.
    await f.admin.query(`UPDATE catalog.products SET status = 'draft' WHERE title = 'Shawl'`);
    expect(await f.carts.listedPrices(f.a.shopId, account, [shawl])).toEqual(new Map());
    expect(await f.carts.listedPrices(f.a.shopId, 'x'.repeat(43), [kurta])).toBeNull();
    expect(await f.carts.listedPrices(f.b.shopId, account, [kurta])).toBeNull();
  });
});
