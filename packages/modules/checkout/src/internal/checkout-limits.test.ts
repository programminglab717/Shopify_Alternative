import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import { CHECKOUT_LIMITS, type CheckoutForm, type CheckoutView } from './checkout.service.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Limits on how fast checkout takes orders', () => {
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
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 100);
  });

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

  /** A checkout of a kurta, and its page. */
  async function checkout() {
    const action = parseAction('add', { items: [{ variantId: kurta, quantity: 1 }] });
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const added = await f.carts.act(f.a.shopId, null, action);
    if (!added.ok) throw new Error(`Refused: ${JSON.stringify(added.error)}`);
    const secret = (await f.checkouts.start(f.a.shopId, added.token!))!;
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return { secret, view };
  }

  /** Places a checkout for `phone`, from the internet address `ip`. */
  async function placeFrom(phone: string, ip: string | null) {
    const { secret, view } = await checkout();
    return f.checkouts.place(
      secret,
      view.shown,
      { ...FORM, phone },
      { client: { ip, userAgent: 'Mozilla/5.0' } },
    );
  }

  const problemOf = (view: CheckoutView) =>
    view.kind === 'open' ? view.problem : view.kind === 'placed' ? null : view.kind;

  const orderCount = async () =>
    (await f.admin.query<{ count: number }>('SELECT count(*)::int AS count FROM orders.orders'))
      .rows[0]!.count;

  it('takes three orders a day from one number, however it is written', async () => {
    expect(CHECKOUT_LIMITS.ordersPerNumberDaily).toBe(3);
    const placed = [];
    for (const ip of ['203.0.113.1', '203.0.113.2', null]) {
      const view = await placeFrom('0300-1234567', ip);
      if (view.kind !== 'placed') throw new Error(`Expected an order, got ${view.kind}`);
      placed.push(view.order);
    }
    // Cancelled, one counts all the same.
    unwrap(await f.orders.cancel(f.a, placed[0]!.id, { reason: 'customer' }));
    const fourth = await placeFrom('+92 300 1234567', '203.0.113.9');
    expect(problemOf(fourth)).toEqual({ kind: 'too_many', by: 'phone' });
    expect(await orderCount()).toBe(3);
    const { rows } = await f.admin.query<{ committed: number }>(
      'SELECT sum(committed)::int AS committed FROM inventory.levels WHERE variant_id = $1',
      [kurta],
    );
    // The two open orders', the cancelled one's back, and nothing for the one refused.
    expect(rows[0]!.committed).toBe(2);
    const page = checkoutPage(fourth);
    expect(page.status).toBe(429);
    expect(page.html).toContain(
      'This number has placed as many orders today as checkout takes in a day. To order more, ' +
        'message the shop in your chat.',
    );
    // Another number goes through; a day on, this one does again.
    expect(problemOf(await placeFrom('0321-5556677', '203.0.113.9'))).toBeNull();
    await f.admin.query(
      `UPDATE orders.orders SET created_at = created_at - interval '25 hours'
        WHERE phone = '+923001234567'`,
    );
    expect(problemOf(await placeFrom('0300-1234567', '203.0.113.9'))).toBeNull();
  });

  it("takes twenty an hour from one internet address, shared by a mobile network's phones", async () => {
    expect(CHECKOUT_LIMITS.ordersPerAddressHourly).toBe(20);
    for (let index = 0; index < 20; index++) {
      const phone = `0300-12345${String(index).padStart(2, '0')}`;
      expect(problemOf(await placeFrom(phone, '198.51.100.7'))).toBeNull();
    }
    const next = await placeFrom('0333-4445566', '198.51.100.7');
    expect(problemOf(next)).toEqual({ kind: 'too_many', by: 'address' });
    expect(checkoutPage(next).html).toContain(
      'Many orders came from your internet connection in the last hour.',
    );
    // An order from the address that came another way, such as a draft its customer confirmed
    // through its link (ADR-114), is not checkout's to count.
    await f.admin.query(
      `UPDATE orders.orders SET source = 'whatsapp'
        WHERE id = (SELECT id FROM orders.orders WHERE client_ip = '198.51.100.7' LIMIT 1)`,
    );
    expect(problemOf(await placeFrom('0333-4445500', '198.51.100.7'))).toBeNull();
    // Another address goes through, and so does one not known, or not an address.
    for (const ip of ['198.51.100.8', null, '198.51.100.7, 10.0.0.1']) {
      expect(problemOf(await placeFrom('0333-4445566', ip))).toBeNull();
    }
    // An hour on, this one does again.
    await f.admin.query(
      `UPDATE orders.orders SET created_at = created_at - interval '61 minutes'
        WHERE client_ip = '198.51.100.7'`,
    );
    expect(problemOf(await placeFrom('0333-4445567', '198.51.100.7'))).toBeNull();
  });

  it('counts orders from one number placed at once one at a time', async () => {
    const pages = [];
    for (let index = 0; index < 5; index++) pages.push(await checkout());
    const results = await Promise.all(
      pages.map(({ secret, view }) =>
        f.checkouts.place(secret, view.shown, FORM, {
          client: { ip: '203.0.113.5', userAgent: 'Mozilla/5.0' },
        }),
      ),
    );
    expect(results.map(problemOf).sort((a, b) => (a === null ? -1 : b === null ? 1 : 0))).toEqual([
      null,
      null,
      null,
      { kind: 'too_many', by: 'phone' },
      { kind: 'too_many', by: 'phone' },
    ]);
    expect(await orderCount()).toBe(3);
  });
});
