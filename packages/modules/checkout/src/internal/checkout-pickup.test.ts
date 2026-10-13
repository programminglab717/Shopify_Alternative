import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import type { CartActionName } from '@hatti/storefront-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import type { CheckoutForm, CheckoutView } from './checkout.service.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

/** A shopper picking the order up: their name and number, no address. */
const COLLECTING: CheckoutForm = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  city: '',
  address1: '',
  address2: '',
  landmark: '',
  province: '',
  payment: '',
  code: '',
  resend: '',
};

describe.skipIf(!server)('Picking up at checkout (SHP-15, ADR-391)', () => {
  let f: CheckoutFixture;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    unwrap(await f.delivery.update(f.a, { charge: '250' }));
  });

  async function act(
    owner: TenantContext,
    token: string | null,
    name: CartActionName,
    body: unknown,
  ) {
    const action = parseAction(name, body);
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const result = await f.carts.act(owner.shopId, token, action);
    if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.error)}`);
    return result.token!;
  }

  /** A checkout of two lawn suits, in stock at the primary location; its secret and page. */
  async function started() {
    const [suit] = await f.variantsOf(f.a, 'Lawn 3-piece', { price: '4,500' });
    await f.stock(f.a, suit!, 5);
    const token = await act(f.a, null, 'add', { items: [{ variantId: suit, quantity: 2 }] });
    const secret = (await f.checkouts.start(f.a.shopId, token))!;
    return { secret, view: open(await f.checkouts.view(secret)) };
  }

  function open(view: CheckoutView) {
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return view;
  }

  /** The primary location, with its street and city, letting customers pick up there. */
  async function counter() {
    const primary = await f.locations.primary(f.a);
    unwrap(
      await f.locations.edit(f.a, primary.id, {
        name: 'Liberty store',
        address: { address1: 'Shop 4, Liberty Market', city: 'lhr' },
      }),
    );
    unwrap(
      await f.locations.enableLocalPickup(f.a, primary.id, { instructions: 'Ask at the counter' }),
    );
    return primary;
  }

  it('offers pickup where a location lets customers, and places it there with no delivery charge', async () => {
    // Nowhere offers it: the page offers delivery alone.
    const before = await started();
    expect(before.view.pickup).toEqual([]);
    expect(checkoutPage(before.view).html).not.toContain('name="pickup"');

    const primary = await counter();
    const { secret, view } = await started();
    expect(view.pickup).toEqual([
      {
        id: primary.id,
        name: 'Liberty store',
        address1: 'Shop 4, Liberty Market',
        address2: null,
        city: 'Lahore',
        instructions: 'Ask at the counter',
      },
    ]);
    const page = checkoutPage(view).html;
    expect(page).toContain('Deliver to my address');
    expect(page).toContain(
      'Pick up from Liberty store, Shop 4, Liberty Market, Lahore: no delivery charge. Ask at the counter',
    );

    // Picked up, the address is the shopper's to leave out: the location's stands in.
    const placed = await f.checkouts.place(secret, view.shown, {
      ...COLLECTING,
      pickup: primary.id,
    });
    if (placed.kind !== 'placed') throw new Error(`Expected a placed order, got ${placed.kind}`);
    expect(placed.order).toMatchObject({
      deliveryMethod: 'pickup',
      locationId: primary.id,
      shipping: 0n,
      total: 9_000_00n,
      shippingAddress: { name: 'Ayesha Khan', address1: 'Shop 4, Liberty Market', city: 'Lahore' },
    });
    expect(placed.pickup?.name).toBe('Liberty store');
    const thanks = checkoutPage(placed).html;
    expect(thanks).toContain('Pick up from');
    expect(thanks).toContain('We tell you on WhatsApp when it is ready to collect.');
    expect(thanks).not.toContain('Deliver to');
    // Seen again, the page still says where.
    const again = await f.checkouts.view(secret);
    expect(again.kind === 'placed' && again.pickup?.id).toBe(primary.id);
  });

  it('delivers as before, and shows the page again for a location no longer offering pickup', async () => {
    const primary = await counter();
    const { secret, view } = await started();
    unwrap(await f.locations.disableLocalPickup(f.a, primary.id));
    const refused = await f.checkouts.place(secret, view.shown, {
      ...COLLECTING,
      pickup: primary.id,
    });
    expect(refused.kind === 'open' && refused.problem).toEqual({ kind: 'changed' });

    // Delivered, the address is needed, and the charge is the shop's.
    const missing = await f.checkouts.place(secret, view.shown, COLLECTING);
    expect(missing.kind === 'open' && missing.problem?.kind).toBe('address');
    const placed = await f.checkouts.place(secret, view.shown, {
      ...COLLECTING,
      city: 'khi',
      address1: 'House 12, Street 4',
    });
    if (placed.kind !== 'placed') throw new Error(`Expected a placed order, got ${placed.kind}`);
    expect(placed.order).toMatchObject({ deliveryMethod: 'shipping', shipping: 250_00n });
    expect(placed.pickup).toBeNull();
  });
});
