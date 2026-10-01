import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { sha256 } from '@hatti/crypto';
import { testDatabaseServer } from '@hatti/db/testing';
import { checkoutPagePath, type CartActionName, type CartJson } from '@hatti/storefront-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import {
  CHECKOUT_PATH,
  EMPTY_FORM,
  orderNoteOf,
  shownOf,
  type CheckoutForm,
  type CheckoutView,
} from './checkout.service.js';
import { checkouts } from './schema.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

const FORM: CheckoutForm = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  city: 'khi',
  address1: 'House 12, Street 4, Block 5',
  address2: 'Gulshan-e-Iqbal',
  landmark: 'Near Jamia Masjid',
  province: '',
};

const CART: CartJson = {
  note: '',
  attributes: {},
  items: [],
  itemCount: 0,
  subtotal: 0,
  totalWeightGrams: 0,
  discount: null,
  totalDiscount: 0,
};

function item(title: string, variantTitle: string, properties: Record<string, string>) {
  return {
    key: `v:${title}`,
    variantId: 'v',
    productId: 'p',
    quantity: 2,
    properties,
    price: 1_000_00,
    linePrice: 2_000_00,
    title,
    variantTitle,
    sku: null,
    grams: 0,
    maxQuantity: null,
  };
}

describe('orderNoteOf', () => {
  it("is the cart's note, then the properties shoppers see of each line", () => {
    expect(orderNoteOf(CART)).toBe('');
    expect(orderNoteOf({ ...CART, note: '  Call first  ' })).toBe('Call first');
    const cart = {
      ...CART,
      note: 'Call first',
      items: [
        item('Kurta', 'M', { Name: 'Ali', Colour: 'Gold', _bundle: '7' }),
        item('Dupatta', 'Default Title', { _app: 'x' }),
        item('Mug', 'Default Title', { Text: 'Eid Mubarak' }),
      ],
    };
    expect(orderNoteOf(cart)).toBe(
      'Call first\n2 × Kurta (M): Name: Ali, Colour: Gold\n2 × Mug: Text: Eid Mubarak',
    );
  });

  it("is cut to what an order's note holds", () => {
    const note = orderNoteOf({
      ...CART,
      note: 'n'.repeat(4_900),
      items: [item('Mug', 'Default Title', { Text: 'x'.repeat(100) })],
    });
    expect(note).toHaveLength(5_000);
    expect(note.endsWith('x…')).toBe(true);
  });

  it('is at the path storefronts send shoppers to', () => {
    expect(checkoutPagePath('secret')).toBe(`/${CHECKOUT_PATH}/secret`);
  });
});

describe.skipIf(!server)('CheckoutService', () => {
  let f: CheckoutFixture;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  /** Does what a storefront would post, as the controller checks it; the cart's token. */
  async function act(
    owner: TenantContext,
    token: string | null,
    name: CartActionName,
    body: unknown,
  ): Promise<string> {
    const action = parseAction(name, body);
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const result = await f.carts.act(owner.shopId, token, action);
    if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.error)}`);
    return result.token!;
  }

  /** A cart of two lawn suits, in stock, with a note; its token and variants. */
  async function lawnCart(owner = f.a) {
    const [small, medium] = await f.variantsOf(owner, 'Lawn 3-piece', {
      sizes: ['S', 'M'],
      price: '4,500',
    });
    await f.stock(owner, small!, 5);
    await f.stock(owner, medium!, 5);
    const token = await act(owner, null, 'add', {
      items: [
        { variantId: small, quantity: 2 },
        { variantId: medium, properties: { Stitching: 'Yes' } },
      ],
    });
    await act(owner, token, 'update', { note: 'Please call before coming' });
    return { token, small: small!, medium: medium! };
  }

  /** A checkout of the cart, and its page. */
  async function started(cartToken: string, owner = f.a) {
    const secret = await f.checkouts.start(owner.shopId, cartToken);
    if (!secret) throw new Error('No checkout');
    const view = await f.checkouts.view(secret);
    return { secret, view: open(view) };
  }

  function open(view: CheckoutView) {
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return view;
  }

  function placedOrder(view: CheckoutView) {
    if (view.kind !== 'placed') {
      const problem = view.kind === 'open' ? JSON.stringify(view.problem) : '';
      throw new Error(`Expected a placed order, got ${view.kind} ${problem}`);
    }
    return view.order;
  }

  async function handleOf(owner: TenantContext): Promise<string> {
    const { rows } = await f.admin.query<{ handle: string }>(
      'SELECT handle FROM control.shops WHERE id = $1',
      [owner.shopId],
    );
    return rows[0]!.handle;
  }

  async function orderCount(): Promise<number> {
    const { rows } = await f.admin.query<{ count: string }>('SELECT count(*) FROM orders.orders');
    return Number(rows[0]!.count);
  }

  /**
   * Sets one of shop A's policies, as the online store keeps them, with a version for each body:
   * the version's ID.
   */
  async function policy(type: string, body: string): Promise<string> {
    const { rows } = await f.admin.query<{ id: string }>(
      `WITH version AS (
         INSERT INTO online_store.policy_versions (shop_id, type, body) VALUES ($1, $2, $3)
         RETURNING shop_id, id, type, body)
       INSERT INTO online_store.policies (shop_id, type, body, version_id)
       SELECT shop_id, type, body, id FROM version
       ON CONFLICT (shop_id, type)
         DO UPDATE SET body = excluded.body, version_id = excluded.version_id
       RETURNING version_id AS id`,
      [f.a.shopId, type, body],
    );
    return rows[0]!.id;
  }

  /** Gives shop A a main theme whose settings set its accent colour. */
  async function accent(colour: string): Promise<void> {
    await f.admin.query(
      `WITH theme AS (
         INSERT INTO online_store.themes (shop_id, name, base, role)
         VALUES ($1, 'Hatti Base', 'hatti-base', 'main') RETURNING shop_id, id)
       INSERT INTO online_store.theme_files (shop_id, theme_id, filename, body)
       SELECT shop_id, id, 'config/settings_data.json', $2 FROM theme`,
      [f.a.shopId, JSON.stringify({ current: { color_accent: colour } })],
    );
  }

  it('matches the migrated table', async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(checkouts).limit(1));
  });

  it("starts a checkout of a cart with something to order, keeping only its secret's digest", async () => {
    const { token } = await lawnCart();
    const secret = await f.checkouts.start(f.a.shopId, token);
    expect(secret).toMatch(/^[\w-]{22}$/);
    const { rows } = await f.admin.query<{
      token_hash: Buffer;
      cart_id: string;
      order_id: string | null;
      hours: number;
    }>(
      `SELECT token_hash, cart_id, order_id,
              round(extract(epoch FROM expires_at - now()) / 3600) AS hours
         FROM checkout.checkouts`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash.equals(sha256(secret!))).toBe(true);
    expect([rows[0]!.order_id, Number(rows[0]!.hours)]).toEqual([null, 24]);

    // None for a cart that names nothing, another shop's, or one with nothing in it.
    expect(await f.checkouts.start(f.a.shopId, 'x'.repeat(22))).toBeNull();
    expect(await f.checkouts.start(f.b.shopId, token)).toBeNull();
    await act(f.a, token, 'clear', {});
    expect(await f.checkouts.start(f.a.shopId, token)).toBeNull();
  });

  it('shows the cart to order, what delivery costs, and an empty form', async () => {
    unwrap(
      await f.delivery.update(f.a, {
        charge: '250',
        zones: [{ name: 'Karachi', cities: ['Karachi'], charge: '150' }],
      }),
    );
    // The shop's policies, which the page links, in Shopify's order.
    const shipping = await policy('shipping_policy', '<p>Rs 250.</p>');
    const refund = await policy('refund_policy', '<p>7 days.</p>');
    // And its theme's colour, which the page takes.
    await accent('#B45309');
    const { token } = await lawnCart();
    const { secret, view } = await started(token);
    expect(view.shop).toEqual({
      name: 'A',
      storefront: `https://${await handleOf(f.a)}.hatti.test`,
      policies: [
        { type: 'refund_policy', versionId: refund },
        { type: 'shipping_policy', versionId: shipping },
      ],
      accent: '#B45309',
    });
    expect(view.cart).toEqual(await f.carts.cart(f.a.shopId, token));
    expect(view.delivery).toMatchObject({ charge: 250_00n, zones: [{ charge: 150_00n }] });
    expect(view.shown).toBe(shownOf(view.cart, view.delivery, view.shop.policies));
    expect([view.form, view.problem]).toEqual([EMPTY_FORM, null]);

    // Only for the shop's own storefront, and only for secrets it gave.
    expect((await f.checkouts.view(secret, f.a.shopId)).kind).toBe('open');
    expect(await f.checkouts.view(secret, f.b.shopId)).toEqual({ kind: 'not_found' });
    expect(await f.checkouts.view('y'.repeat(22))).toEqual({ kind: 'not_found' });
    expect(await f.checkouts.view('not a secret')).toEqual({ kind: 'not_found' });
  });

  it('places a cash-on-delivery order with the charge for the city, and empties the cart', async () => {
    unwrap(
      await f.delivery.update(f.a, {
        charge: '250',
        zones: [{ name: 'Karachi', cities: ['Karachi'], charge: '150' }],
      }),
    );
    const { token, small, medium } = await lawnCart();
    const { secret, view } = await started(token);
    const order = placedOrder(await f.checkouts.place(secret, view.shown, FORM));
    expect(order).toMatchObject({
      number: 1001,
      source: 'online_store',
      paymentMethod: 'cash_on_delivery',
      confirmationStatus: 'pending',
      subtotal: 13_500_00n,
      shipping: 150_00n,
      total: 13_650_00n,
      codAmount: 13_650_00n,
      amountPaid: 0n,
      phone: '+923001234567',
      shippingAddress: {
        name: 'Ayesha Khan',
        city: 'Karachi',
        provinceCode: 'SD',
        address2: 'Gulshan-e-Iqbal',
        landmark: 'Near Jamia Masjid',
      },
      note: 'Please call before coming\n1 × Lawn 3-piece (M): Stitching: Yes',
      // Placed by its customer, who agreed to no policies: the shop has none.
      agreement: { policyVersions: [], ip: null, userAgent: null },
    });
    expect(
      order.lines.map((line) => [line.variantId, line.variantTitle, line.quantity, line.unitPrice]),
    ).toEqual([
      [small, 'S', 2, 4_500_00n],
      [medium, 'M', 1, 4_500_00n],
    ]);
    const events = (await f.outbox()).map((event) => event.event_type);
    expect(events).toContain('order.created');

    // The cart is empty, its secret still naming it; the checkout knows its order.
    expect(await f.carts.cart(f.a.shopId, token)).toMatchObject({ items: [], note: '' });
    const { rows } = await f.admin.query<{ order_id: string; completed: boolean }>(
      'SELECT order_id, completed_at IS NOT NULL AS completed FROM checkout.checkouts',
    );
    expect(rows).toEqual([{ order_id: order.id, completed: true }]);

    // Its page shows the order from now on; placing it again places nothing more.
    expect(placedOrder(await f.checkouts.view(secret)).id).toBe(order.id);
    expect(placedOrder(await f.checkouts.place(secret, view.shown, FORM)).id).toBe(order.id);
    expect(placedOrder(await f.checkouts.place(secret, 'stale', EMPTY_FORM)).id).toBe(order.id);
    expect(await orderCount()).toBe(1);
  });

  it('applies a discount code to the cart, takes it off the order and counts its use', async () => {
    unwrap(
      await f.delivery.update(f.a, {
        charge: '250',
        zones: [{ name: 'Karachi', cities: ['Karachi'], charge: '150' }],
      }),
    );
    const eid = unwrap(
      await f.codes.create(f.a, {
        code: 'EID10',
        percentage: 10,
        minimumSubtotal: '10,000',
        usageLimit: 5,
      }),
    );
    const { token } = await lawnCart();
    const { secret } = await started(token);
    // Typed in any letter case; kept as the shop wrote it.
    const applied = open(await f.checkouts.applyDiscount(secret, ' eid10 '));
    expect(applied.problem).toBeNull();
    expect(applied.discount).toMatchObject({
      code: 'EID10',
      record: { id: eid.id },
      refusal: null,
    });
    expect(applied.shown).toBe(
      shownOf(applied.cart, applied.delivery, applied.shop.policies, applied.discount),
    );
    // The cart keeps it: the page shows it on the next visit, and on no other shop's.
    expect(open(await f.checkouts.view(secret)).discount?.code).toBe('EID10');
    expect(await f.checkouts.applyDiscount(secret, 'EID10', { shopId: f.b.shopId })).toEqual({
      kind: 'not_found',
    });

    const order = placedOrder(await f.checkouts.place(secret, applied.shown, FORM));
    // Rs 13,500 less 10%, and Rs 150 to Karachi.
    expect(order).toMatchObject({
      subtotal: 13_500_00n,
      discount: 1_350_00n,
      shipping: 150_00n,
      total: 12_300_00n,
      codAmount: 12_300_00n,
      discountCodes: ['EID10'],
    });
    expect((await f.codes.get(f.a, eid.id))?.used).toBe(1);
    const { rows } = await f.admin.query<Record<string, string>>(
      'SELECT order_id, customer_id, amount::text FROM pricing.discount_redemptions',
    );
    expect(rows).toEqual([{ order_id: order.id, customer_id: order.customerId, amount: '135000' }]);
    // The cart is emptied, its code with it.
    const carts = await f.admin.query<{ discount_codes: string[] }>(
      'SELECT discount_codes FROM checkout.carts',
    );
    expect(carts.rows).toEqual([{ discount_codes: [] }]);
    expect((await f.outbox()).map((event) => event.event_type)).toContain('discount_code.redeemed');
  });

  it('makes delivery free with a free-delivery code, wherever it goes', async () => {
    unwrap(await f.delivery.update(f.a, { charge: '250' }));
    const free = unwrap(await f.codes.create(f.a, { code: 'FREEDEL', freeShipping: true }));
    const { token } = await lawnCart();
    const { secret } = await started(token);
    const applied = open(await f.checkouts.applyDiscount(secret, 'freedel'));
    const order = placedOrder(await f.checkouts.place(secret, applied.shown, FORM));
    expect(order).toMatchObject({
      subtotal: 13_500_00n,
      discount: 0n,
      shipping: 0n,
      total: 13_500_00n,
      discountCodes: ['FREEDEL'],
    });
    const { rows } = await f.admin.query<{ amount: string }>(
      'SELECT amount::text FROM pricing.discount_redemptions WHERE code_id = $1',
      [free.id],
    );
    // What the code took off: the delivery charge.
    expect(rows).toEqual([{ amount: '25000' }]);
  });

  it('says why a code takes nothing off, and takes no more codes past ten', async () => {
    unwrap(await f.codes.create(f.a, { code: 'BIG', amount: '1,000', minimumSubtotal: '20,000' }));
    unwrap(
      await f.codes.create(f.a, {
        code: 'OLD',
        percentage: 5,
        startsAt: new Date('2026-01-01T00:00:00+05:00'),
        endsAt: new Date('2026-02-01T00:00:00+05:00'),
      }),
    );
    const { token } = await lawnCart();
    const { secret } = await started(token);
    const refused = async (typed: string) => {
      const view = open(await f.checkouts.applyDiscount(secret, typed));
      expect(view.discount, typed).toBeNull();
      return view.problem;
    };
    expect(await refused('BIG')).toEqual({
      kind: 'discount',
      code: 'BIG',
      refusal: { reason: 'minimum', minimum: 20_000_00n },
    });
    expect(await refused('old')).toEqual({
      kind: 'discount',
      code: 'old',
      refusal: { reason: 'expired' },
    });
    expect(await refused(`NOPE${'!'.repeat(80)}`)).toEqual({
      kind: 'discount',
      code: `NOPE${'!'.repeat(60)}`,
      refusal: { reason: 'unknown' },
    });
    for (let attempt = 3; attempt < 10; attempt++) await refused(`GUESS${attempt}`);
    // Ten refused: a good code is not even looked at.
    unwrap(await f.codes.create(f.a, { code: 'GOOD', percentage: 5 }));
    expect(await refused('GOOD')).toEqual({
      kind: 'discount',
      code: 'GOOD',
      refusal: { reason: 'attempts' },
    });
    // Another checkout of the cart may.
    const again = await started(token);
    expect(open(await f.checkouts.applyDiscount(again.secret, 'GOOD')).discount?.code).toBe('GOOD');
  });

  it('places nothing with a code used up since, or used before by a customer meant to use it once', async () => {
    unwrap(await f.codes.create(f.a, { code: 'ONCE', amount: '500', oncePerCustomer: true }));
    const first = await started((await lawnCart()).token);
    const shown = open(await f.checkouts.applyDiscount(first.secret, 'ONCE')).shown;
    expect(placedOrder(await f.checkouts.place(first.secret, shown, FORM)).discount).toBe(500_00n);

    // The same number again: refused as the order is placed, which is undone.
    const second = await started((await lawnCart()).token);
    const again = open(await f.checkouts.applyDiscount(second.secret, 'ONCE'));
    expect(again.problem).toBeNull();
    const refused = open(await f.checkouts.place(second.secret, again.shown, FORM));
    expect(refused.problem).toEqual({
      kind: 'discount',
      code: 'ONCE',
      refusal: { reason: 'used' },
    });
    expect(refused.form).toEqual(FORM);
    expect(await orderCount()).toBe(1);
    expect((await f.codes.byCode(f.a, 'ONCE'))?.used).toBe(1);
    // Without it, the order goes.
    const removed = open(await f.checkouts.removeDiscount(second.secret));
    expect(removed.discount).toBeNull();
    const plain = placedOrder(await f.checkouts.place(second.secret, removed.shown, FORM));
    expect([plain.discount, plain.discountCodes]).toEqual([0n, []]);

    // One use left, two pages showing it: the second finds it used up, and shows it so.
    unwrap(await f.codes.create(f.a, { code: 'LAST', amount: '300', usageLimit: 1 }));
    const a = await started((await lawnCart()).token);
    const b = await started((await lawnCart()).token);
    const shownA = open(await f.checkouts.applyDiscount(a.secret, 'LAST')).shown;
    const shownB = open(await f.checkouts.applyDiscount(b.secret, 'LAST')).shown;
    placedOrder(await f.checkouts.place(a.secret, shownA, FORM));
    const usedUp = open(await f.checkouts.place(b.secret, shownB, FORM));
    expect(usedUp.problem).toEqual({ kind: 'changed' });
    expect(usedUp.discount).toEqual({
      code: 'LAST',
      record: null,
      refusal: { reason: 'used_up' },
    });
    // As shown again, without the code.
    const plainB = placedOrder(await f.checkouts.place(b.secret, usedUp.shown, FORM));
    expect([plainB.discount, plainB.discountCodes]).toEqual([0n, []]);
  });

  it('keeps with the order what the shopper agreed to, and where they placed it from', async () => {
    const refund = await policy('refund_policy', '<p>7 days.</p>');
    const terms = await policy('terms_of_service', '<p>Our terms.</p>');
    const first = await started((await lawnCart()).token);
    expect(first.view.shop.policies).toEqual([
      { type: 'refund_policy', versionId: refund },
      { type: 'terms_of_service', versionId: terms },
    ]);
    const client = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (Linux; Android 14)' };

    // The refund policy changes while the page is open: nothing is placed, and the page shows
    // the new one, which placing the order then agrees to.
    const refund2 = await policy('refund_policy', '<p>14 days.</p>');
    const changed = await f.checkouts.place(first.secret, first.view.shown, FORM, { client });
    expect(changed).toMatchObject({ kind: 'open', problem: { kind: 'changed' } });
    expect(await orderCount()).toBe(0);
    const shown = (changed as Extract<CheckoutView, { kind: 'open' }>).shown;
    const order = placedOrder(await f.checkouts.place(first.secret, shown, FORM, { client }));
    expect(order.agreement).toEqual({ policyVersions: [refund2, terms], ...client });

    // An address that is none is left out; a browser's name loses control characters, and is
    // cut to 512 characters.
    const second = await started((await lawnCart()).token);
    const odd = {
      ip: '203.0.113.7, 10.0.0.1',
      userAgent: `A${String.fromCharCode(0)}B`.repeat(300),
    };
    const next = placedOrder(
      await f.checkouts.place(second.secret, second.view.shown, FORM, { client: odd }),
    );
    expect(next.agreement).toEqual({
      policyVersions: [refund2, terms],
      ip: null,
      userAgent: 'AB'.repeat(256),
    });
  });

  it('charges what the shop charges everywhere else, and nothing above its free amount', async () => {
    unwrap(
      await f.delivery.update(f.a, {
        charge: '250',
        freeAbove: '20,000',
        zones: [{ name: 'Karachi', cities: ['Karachi'], charge: '150' }],
      }),
    );
    const { token } = await lawnCart();
    const first = await started(token);
    const lahore = { ...FORM, city: 'Lahore', province: 'punjab' };
    const order = placedOrder(await f.checkouts.place(first.secret, first.view.shown, lahore));
    expect([order.shipping, order.shippingAddress.provinceCode]).toEqual([250_00n, 'PB']);

    const [lehnga] = await f.variantsOf(f.a, 'Bridal lehnga', { price: '25,000' });
    const token2 = await act(f.a, null, 'add', { items: [{ variantId: lehnga }] });
    const second = await started(token2);
    const free = placedOrder(await f.checkouts.place(second.secret, second.view.shown, FORM));
    expect([free.subtotal, free.shipping]).toEqual([25_000_00n, 0n]);
  });

  it('takes no more cash on delivery than the law allows an order', async () => {
    unwrap(await f.delivery.update(f.a, { charge: '250' }));
    const [lehnga] = await f.variantsOf(f.a, 'Bridal lehnga', { price: '199,900' });
    const token = await act(f.a, null, 'add', { items: [{ variantId: lehnga }] });
    // Within the limit, until delivery takes it past: placing says so, and places nothing.
    const { secret, view } = await started(token);
    expect(view.problem).toBeNull();
    expect(await f.checkouts.place(secret, view.shown, FORM)).toMatchObject({
      kind: 'open',
      problem: { kind: 'cod_limit' },
      form: FORM,
    });
    // Two are past it whatever delivery costs: the page says so before the shopper types.
    await act(f.a, token, 'add', { items: [{ variantId: lehnga }] });
    const past = open(await f.checkouts.view(secret));
    expect(past.problem).toEqual({ kind: 'cod_limit' });
    expect(await f.checkouts.place(secret, past.shown, FORM)).toMatchObject({
      problem: { kind: 'cod_limit' },
    });
    expect(await orderCount()).toBe(0);
  });

  it('shows the page again when the cart or the charges changed since it was shown', async () => {
    const { token, small } = await lawnCart();
    const { secret, view } = await started(token);
    await act(f.a, token, 'change', { line: { variantId: small }, quantity: 3 });
    const changed = open(await f.checkouts.place(secret, view.shown, FORM));
    expect(changed.problem).toEqual({ kind: 'changed' });
    expect(changed.form).toEqual(FORM);
    expect(changed.cart.itemCount).toBe(4);
    expect(changed.shown).not.toBe(view.shown);

    unwrap(await f.delivery.update(f.a, { charge: '199' }));
    const charged = open(await f.checkouts.place(secret, changed.shown, FORM));
    expect(charged.problem).toEqual({ kind: 'changed' });
    expect(await orderCount()).toBe(0);

    const order = placedOrder(await f.checkouts.place(secret, charged.shown, FORM));
    expect([order.subtotal, order.shipping]).toEqual([18_000_00n, 199_00n]);
  });

  it("says what is wrong with the shopper's details, keeping what they typed", async () => {
    const { token } = await lawnCart();
    const { secret, view } = await started(token);
    const typed = { ...FORM, name: ' ', phone: '12345', province: 'Narnia' };
    const wrong = open(await f.checkouts.place(secret, view.shown, typed));
    expect(wrong.form).toEqual(typed);
    if (wrong.problem?.kind !== 'address') throw new Error('Expected address errors');
    expect(wrong.problem.errors.map((error) => [error.field.join('.'), error.code])).toEqual([
      ['name', 'BLANK'],
      ['phone', 'INVALID'],
      ['province', 'INVALID'],
    ]);
    expect(await orderCount()).toBe(0);
    expect((await f.carts.cart(f.a.shopId, token))!.itemCount).toBe(3);
  });

  it('refuses what cannot be bought now, and orders nothing', async () => {
    const { token, small } = await lawnCart();
    const { secret, view } = await started(token);
    await f.stock(f.a, small, 1);
    const short = open(await f.checkouts.place(secret, view.shown, FORM));
    expect(short.problem).toEqual({ kind: 'unavailable' });
    expect(await orderCount()).toBe(0);
    expect((await f.carts.cart(f.a.shopId, token))!.itemCount).toBe(3);
  });

  it("holds an order from a blocked number for the shop's review", async () => {
    unwrap(await f.blocklist.add(f.a, { phone: FORM.phone, reason: 'fake_orders' }));
    const { token } = await lawnCart();
    const { secret, view } = await started(token);
    const order = placedOrder(await f.checkouts.place(secret, view.shown, FORM));
    expect(order.confirmationStatus).toBe('needs_review');
  });

  it('places one order from a cart, however many checkouts it has', async () => {
    const { token } = await lawnCart();
    const first = await started(token);
    const second = await started(token);
    const [a, b] = await Promise.all([
      f.checkouts.place(first.secret, first.view.shown, FORM),
      f.checkouts.place(second.secret, second.view.shown, FORM),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['empty', 'placed']);
    expect(await orderCount()).toBe(1);
  });

  it('shows nothing to order once the cart is emptied or gone', async () => {
    const { token } = await lawnCart();
    const { secret } = await started(token);
    await act(f.a, token, 'clear', {});
    const shop = {
      name: 'A',
      storefront: `https://${await handleOf(f.a)}.hatti.test`,
      policies: [],
      accent: null,
    };
    expect(await f.checkouts.view(secret)).toEqual({ kind: 'empty', shop });
    await f.admin.query('DELETE FROM checkout.carts');
    expect(await f.checkouts.place(secret, 'x', FORM)).toEqual({ kind: 'empty', shop });
  });

  it('lasts a day, its thank-you page with it; later checkouts sweep it away', async () => {
    const { token } = await lawnCart();
    const { secret, view } = await started(token);
    placedOrder(await f.checkouts.place(secret, view.shown, FORM));
    await f.admin.query(`UPDATE checkout.checkouts SET expires_at = now() - interval '1 second'`);
    expect((await f.checkouts.view(secret)).kind).toBe('expired');
    expect((await f.checkouts.place(secret, view.shown, FORM)).kind).toBe('expired');

    const next = await lawnCart();
    await started(next.token);
    const { rows } = await f.admin.query<{ count: string }>(
      'SELECT count(*) FROM checkout.checkouts',
    );
    expect(Number(rows[0]!.count)).toBe(1);
    expect(await f.checkouts.view(secret)).toEqual({ kind: 'not_found' });
  });

  it("shows no shop's checkouts once the shop is closed", async () => {
    const { token } = await lawnCart();
    const { secret } = await started(token);
    await f.admin.query(`UPDATE control.shops SET status = 'suspended' WHERE id = $1`, [
      f.a.shopId,
    ]);
    try {
      expect(await f.checkouts.view(secret)).toEqual({ kind: 'not_found' });
    } finally {
      await f.admin.query(`UPDATE control.shops SET status = 'active' WHERE id = $1`, [f.a.shopId]);
    }
  });
});
