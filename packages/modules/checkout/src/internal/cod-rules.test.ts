import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import type { CartActionName } from '@hatti/storefront-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import type { CheckoutForm, CheckoutView } from './checkout.service.js';
import { NO_COD_RULES, codRefusalOf, type CodRulesRecord } from './cod-rules.js';
import { codSettings } from './schema.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

const RULES: CodRulesRecord = {
  maxOrderTotal: 10_000_00n,
  unavailableCities: ['Gilgit', 'Skardu'],
  unavailableProductTags: [],
  refusedDeliveriesLimit: 2,
  riskScoreLimit: null,
  fee: 0n,
  advance: null,
  updatedAt: null,
};

describe('codRefusalOf', () => {
  it('keeps cash on delivery from orders above the total, to the cities, by refusing customers', () => {
    expect(codRefusalOf(NO_COD_RULES, { total: 10n ** 9n, city: 'Gilgit', refused: 9 })).toBeNull();
    expect(codRefusalOf(RULES, { total: 10_000_00n })).toBeNull();
    expect(codRefusalOf(RULES, { total: 10_000_01n })).toEqual({
      reason: 'total',
      max: 10_000_00n,
    });
    // Cities however they are typed, as addresses take them.
    expect(codRefusalOf(RULES, { total: 1n, city: 'gilgit' })).toEqual({
      reason: 'city',
      city: 'Gilgit',
    });
    expect(codRefusalOf(RULES, { total: 1n, city: 'Lahore' })).toBeNull();
    expect(codRefusalOf(RULES, { total: 1n, city: 'Somewhere new' })).toBeNull();
    expect(codRefusalOf(RULES, { total: 1n, refused: 1 })).toBeNull();
    expect(codRefusalOf(RULES, { total: 1n, refused: 2 })).toEqual({ reason: 'customer' });
  });

  it('keeps it from a cart holding a product the shop tags, in any letter case', () => {
    const rules = { ...RULES, unavailableProductTags: ['Pre-Order', 'custom stitching'] };
    const lawn = { title: 'Lawn suit', tags: ['summer'] };
    const lehnga = { title: 'Bridal lehnga', tags: ['bridal', 'pre-order'] };
    expect(codRefusalOf(rules, { total: 1n, products: [lawn] })).toBeNull();
    expect(codRefusalOf(rules, { total: 1n, products: [lawn, lehnga] })).toEqual({
      reason: 'product',
      title: 'Bridal lehnga',
    });
    // Its total first; and a shop that tags none keeps it from no product.
    expect(codRefusalOf(rules, { total: 10_000_01n, products: [lehnga] })).toMatchObject({
      reason: 'total',
    });
    expect(codRefusalOf(RULES, { total: 1n, products: [lehnga] })).toBeNull();
  });
});

describe.skipIf(!server)('Cash on delivery rules at checkout', () => {
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

  const FORM: CheckoutForm = {
    name: 'Ayesha Khan',
    phone: '0300-1234567',
    city: 'Lahore',
    address1: 'House 12, Street 4',
    address2: '',
    landmark: '',
    province: '',
    payment: '',
  };

  async function act(token: string | null, name: CartActionName, body: unknown) {
    const action = parseAction(name, body);
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const result = await f.carts.act(f.a.shopId, token, action);
    if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.error)}`);
    return result.token!;
  }

  /** A checkout of `quantity` kurtas at Rs 4,000, and its page. */
  async function checkout(quantity: number) {
    const [kurta] = await f.variantsOf(f.a, `Kurta ${quantity}`, { price: '4,000' });
    await f.stock(f.a, kurta!, 10);
    const token = await act(null, 'add', { items: [{ variantId: kurta, quantity }] });
    const secret = (await f.checkouts.start(f.a.shopId, token))!;
    return { secret, view: open(await f.checkouts.view(secret)) };
  }

  function open(view: CheckoutView) {
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return view;
  }

  function placed(view: CheckoutView) {
    if (view.kind !== 'placed') {
      throw new Error(
        `Expected an order, got ${JSON.stringify(view.kind === 'open' && view.problem)}`,
      );
    }
    return view.order;
  }

  const offerTransfers = async () =>
    unwrap(
      await f.bankTransfer.update(f.a, {
        enabled: true,
        account: {
          title: 'Zari',
          bankName: 'Standard Chartered',
          iban: 'PK36SCBL0000001123456702',
        },
      }),
    );

  const shopRules = (owner: TenantContext = f.a) =>
    f.codRules.update(owner, {
      maxOrderTotal: '10,000',
      unavailableCities: ['gilgit', 'Skardu', 'GILGIT'],
      refusedDeliveriesLimit: 2,
    });

  it("keeps the shop's rules, checked, and records each change", async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(codSettings).limit(1));
    expect(await f.codRules.get(f.a)).toEqual(NO_COD_RULES);
    const refused = await f.codRules.update(f.a, {
      maxOrderTotal: '0',
      unavailableCities: ['Lahore', 'Narnia'],
      refusedDeliveriesLimit: 0,
    });
    expect(
      refused.ok ? [] : refused.errors.map((error) => [error.field.join('.'), error.code]),
    ).toEqual([
      ['input.maxOrderTotal', 'INVALID'],
      ['input.unavailableCities.1', 'INVALID'],
      ['input.refusedDeliveriesLimit', 'INVALID'],
    ]);
    await f.admin.query('DELETE FROM platform.outbox_events');
    const saved = unwrap(await shopRules());
    expect(saved).toMatchObject({ ...RULES, updatedAt: expect.any(Date) });
    // The same again changes nothing; taking one away, only it.
    unwrap(await shopRules());
    unwrap(await f.codRules.update(f.a, { maxOrderTotal: null }));
    expect(await f.codRules.get(f.a)).toMatchObject({
      maxOrderTotal: null,
      refusedDeliveriesLimit: 2,
    });
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'cod_settings.updated')
        .map((event) => event.payload),
    ).toEqual([
      { changed: ['maxOrderTotal', 'unavailableCities', 'refusedDeliveriesLimit'] },
      { changed: ['maxOrderTotal'] },
    ]);
    expect(await f.codRules.get(f.b)).toEqual(NO_COD_RULES);
  });

  it('takes a cart above its total by transfer alone, or not at all', async () => {
    unwrap(await shopRules());
    const { secret, view } = await checkout(3);
    // Rs 12,000 of items: past the shop's Rs 10,000, with no other way to pay.
    expect(view.payments.codRefusal).toEqual({ reason: 'total', max: 10_000_00n });
    expect(view.problem).toEqual({
      kind: 'cod_unavailable',
      refusal: { reason: 'total', max: 10_000_00n },
    });
    expect(open(await f.checkouts.place(secret, view.shown, FORM)).problem).toEqual(view.problem);

    await offerTransfers();
    const now = open(await f.checkouts.view(secret));
    expect(now.problem).toBeNull();
    const order = placed(await f.checkouts.place(secret, now.shown, FORM));
    expect(order.paymentMethod).toBe('bank_transfer');
  });

  it('turns cash on delivery away from a city the shop names, choosing transfer for the shopper', async () => {
    unwrap(await shopRules());
    const { secret, view } = await checkout(1);
    const gilgit = { ...FORM, city: 'gilgit', payment: 'cash_on_delivery' };
    const away = open(await f.checkouts.place(secret, view.shown, gilgit));
    expect(away.problem).toEqual({
      kind: 'cod_unavailable',
      refusal: { reason: 'city', city: 'Gilgit' },
    });
    // With no transfer to choose, the shopper's choice stays, and nothing is placed.
    expect(away.form).toEqual(gilgit);

    await offerTransfers();
    const page = open(await f.checkouts.view(secret));
    const instead = open(await f.checkouts.place(secret, page.shown, gilgit));
    expect(instead.problem).toMatchObject({ kind: 'cod_unavailable' });
    expect(instead.form).toEqual({ ...gilgit, payment: 'bank_transfer' });
    const order = placed(await f.checkouts.place(secret, instead.shown, instead.form));
    expect(order).toMatchObject({ paymentMethod: 'bank_transfer', stage: 'awaiting_payment' });
    // Elsewhere, cash on delivery as before.
    const next = await checkout(1);
    expect(placed(await f.checkouts.place(next.secret, next.view.shown, FORM))).toMatchObject({
      paymentMethod: 'cash_on_delivery',
    });
  });

  it('turns cash on delivery away from customers who refused as many parcels as the shop allows', async () => {
    unwrap(await f.codRules.update(f.a, { refusedDeliveriesLimit: 1 }));
    await offerTransfers();
    // Their first order: delivered to their door, and refused.
    const first = await checkout(1);
    const order = placed(await f.checkouts.place(first.secret, first.view.shown, FORM));
    unwrap(await f.orders.confirm(f.a, order.id));
    const parcel = unwrap(await f.fulfillments.fulfill(f.a, order.id, {})).fulfillmentId;
    unwrap(await f.fulfillments.markReturning(f.a, parcel));

    // Their next: transfer only, from any number of theirs, however it is written.
    const { secret, view } = await checkout(1);
    const again = open(
      await f.checkouts.place(secret, view.shown, {
        ...FORM,
        phone: '+92 300 1234567',
        payment: 'cash_on_delivery',
      }),
    );
    expect(again.problem).toEqual({ kind: 'cod_unavailable', refusal: { reason: 'customer' } });
    expect(placed(await f.checkouts.place(secret, again.shown, again.form)).paymentMethod).toBe(
      'bank_transfer',
    );
    // Another customer pays on delivery.
    const other = await checkout(1);
    expect(
      placed(
        await f.checkouts.place(other.secret, other.view.shown, { ...FORM, phone: '0321 5556677' }),
      ).paymentMethod,
    ).toBe('cash_on_delivery');
  });

  it("keeps a limit for risk above the advance's, checked", async () => {
    const errors = async (input: Parameters<typeof f.codRules.update>[1]) => {
      const result = await f.codRules.update(f.a, input);
      return result.ok ? [] : result.errors.map((error) => [error.field.join('.'), error.message]);
    };
    for (const riskScoreLimit of [0, 1.5, 0.605, Number.NaN]) {
      expect((await errors({ riskScoreLimit })).map(([field]) => field)).toEqual([
        'input.riskScoreLimit',
      ]);
    }
    await offerTransfers();
    unwrap(await f.codRules.update(f.a, { advance: { amount: '500', riskScore: 0.3 } }));
    await f.admin.query('DELETE FROM platform.outbox_events');
    // An advance asked from 0.30: orders are paid ahead from higher up alone.
    expect(await errors({ riskScoreLimit: 0.3 })).toEqual([
      ['input.riskScoreLimit', 'The limit must be above the risk the advance is asked from, 0.30'],
    ]);
    expect(unwrap(await f.codRules.update(f.a, { riskScoreLimit: 0.6 }))).toMatchObject({
      riskScoreLimit: 60,
      advance: { riskScore: 30 },
    });
    expect(await errors({ advance: { amount: '500', riskScore: 0.6 } })).toEqual([
      ['input.advance.riskScore', 'The risk must be below the limit for cash on delivery, 0.60'],
    ]);
    // Both at once, in order.
    unwrap(
      await f.codRules.update(f.a, {
        riskScoreLimit: 0.8,
        advance: { amount: '500', riskScore: 0.7 },
      }),
    );
    unwrap(await f.codRules.update(f.a, { riskScoreLimit: null }));
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'cod_settings.updated')
        .map((event) => event.payload),
    ).toEqual([
      { changed: ['riskScoreLimit'] },
      { changed: ['riskScoreLimit', 'advance'] },
      { changed: ['riskScoreLimit'] },
    ]);
    expect(await f.codRules.get(f.a)).toMatchObject({ riskScoreLimit: null });
  });

  it("turns cash on delivery away from orders scored at the shop's limit, undoing them (ADR-099)", async () => {
    unwrap(await f.codRules.update(f.a, { riskScoreLimit: 0.3 }));
    const counts = async () =>
      (
        await f.admin.query<{ orders: number; customers: number }>(
          `SELECT (SELECT count(*)::int FROM orders.orders WHERE shop_id = $1) AS orders,
                  (SELECT count(*)::int FROM customers.customers WHERE shop_id = $1) AS customers`,
          [f.a.shopId],
        )
      ).rows[0];
    // A first order to a short address with no house number, 0.35: placed, scored and undone,
    // with no transfer to choose instead.
    const vague = {
      ...FORM,
      phone: '0321-5556677',
      address1: 'Bazaar',
      payment: 'cash_on_delivery',
    };
    const first = await checkout(1);
    const refused = open(await f.checkouts.place(first.secret, first.view.shown, vague));
    expect(refused.problem).toEqual({ kind: 'cod_unavailable', refusal: { reason: 'risk' } });
    expect(refused.form).toEqual(vague);
    expect(await counts()).toEqual({ orders: 0, customers: 0 });

    // With transfers, one is chosen for the shopper, and paid so the order is taken, unscored.
    await offerTransfers();
    const page = open(await f.checkouts.view(first.secret));
    const away = open(await f.checkouts.place(first.secret, page.shown, vague));
    expect(away.problem).toEqual(refused.problem);
    expect(away.form).toEqual({ ...vague, payment: 'bank_transfer' });
    expect(placed(await f.checkouts.place(first.secret, away.shown, away.form))).toMatchObject({
      paymentMethod: 'bank_transfer',
      stage: 'awaiting_payment',
      risk: null,
    });
    // A first order to a full address, 0.10, is paid on delivery as before.
    const full = await checkout(1);
    expect(placed(await f.checkouts.place(full.secret, full.view.shown, FORM))).toMatchObject({
      paymentMethod: 'cash_on_delivery',
      risk: { score: 10 },
    });

    // An advance asked from 0.30 and the limit at 0.50: a first vague order, 0.35, is asked the
    // advance; the same number's next within hours, 0.50, pays ahead.
    unwrap(
      await f.codRules.update(f.a, {
        riskScoreLimit: 0.5,
        advance: { amount: '500', riskScore: 0.3 },
      }),
    );
    const other = { ...vague, phone: '0321-5556678' };
    const asked = await checkout(1);
    expect(placed(await f.checkouts.place(asked.secret, asked.view.shown, other))).toMatchObject({
      paymentMethod: 'cash_on_delivery',
      advanceDue: 500_00n,
      risk: { score: 35 },
    });
    const again = await checkout(1);
    expect(open(await f.checkouts.place(again.secret, again.view.shown, other)).problem).toEqual(
      refused.problem,
    );
    expect(await counts()).toEqual({ orders: 3, customers: 3 });
  });

  it("charges the shop's fee for paying at the door, and nothing for a transfer", async () => {
    await offerTransfers();
    await f.admin.query('DELETE FROM platform.outbox_events');
    expect(unwrap(await f.codRules.update(f.a, { fee: '100' })).fee).toBe(100_00n);
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'cod_settings.updated')
        .map((event) => event.payload),
    ).toEqual([{ changed: ['fee'] }]);
    const cash = await checkout(1);
    expect(placed(await f.checkouts.place(cash.secret, cash.view.shown, FORM))).toMatchObject({
      paymentMethod: 'cash_on_delivery',
      codFee: 100_00n,
      total: 4_100_00n,
      codAmount: 4_100_00n,
    });
    const transfer = await checkout(1);
    expect(
      placed(
        await f.checkouts.place(transfer.secret, transfer.view.shown, {
          ...FORM,
          payment: 'bank_transfer',
        }),
      ),
    ).toMatchObject({ paymentMethod: 'bank_transfer', codFee: 0n, total: 4_000_00n });
    // A page shown before the fee changed shows itself again.
    const before = await checkout(1);
    unwrap(await f.codRules.update(f.a, { fee: '150' }));
    expect(open(await f.checkouts.place(before.secret, before.view.shown, FORM)).problem).toEqual({
      kind: 'changed',
    });
  });

  it('keeps cash on delivery from carts holding a product the shop tags, offering transfer alone', async () => {
    const tags = Array.from({ length: 51 }, (_, index) => `tag-${index}`);
    const tooMany = await f.codRules.update(f.a, { unavailableProductTags: tags });
    expect(
      tooMany.ok ? [] : tooMany.errors.map((error) => [error.field.join('.'), error.code]),
    ).toEqual([['input.unavailableProductTags', 'TOO_MANY']]);
    await f.admin.query('DELETE FROM platform.outbox_events');
    // Each once, in any letter case, as products' tags are.
    const saved = unwrap(
      await f.codRules.update(f.a, {
        unavailableProductTags: [' Pre-order ', 'PRE-ORDER', 'custom stitching'],
      }),
    );
    expect(saved.unavailableProductTags).toEqual(['Pre-order', 'custom stitching']);
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'cod_settings.updated')
        .map((event) => event.payload),
    ).toEqual([{ changed: ['unavailableProductTags'] }]);

    // A pre-order in the cart, and no transfer: nothing to fill in.
    const [lehnga] = await f.variantsOf(f.a, 'Bridal lehnga', {
      price: '4,000',
      tags: ['bridal', 'pre-order'],
    });
    await f.stock(f.a, lehnga!, 5);
    const token = await act(null, 'add', { items: [{ variantId: lehnga, quantity: 1 }] });
    const secret = (await f.checkouts.start(f.a.shopId, token))!;
    const view = open(await f.checkouts.view(secret));
    const refusal = { reason: 'product', title: 'Bridal lehnga' };
    expect(view.payments.codRefusal).toEqual(refusal);
    expect(view.problem).toEqual({ kind: 'cod_unavailable', refusal });
    expect(open(await f.checkouts.place(secret, view.shown, FORM)).problem).toEqual(view.problem);

    // With transfer, it is the way to pay.
    await offerTransfers();
    const now = open(await f.checkouts.view(secret));
    expect(now.problem).toBeNull();
    expect(
      open(await f.checkouts.place(secret, now.shown, { ...FORM, payment: 'cash_on_delivery' }))
        .problem,
    ).toEqual({ kind: 'changed' });
    expect(placed(await f.checkouts.place(secret, now.shown, FORM)).paymentMethod).toBe(
      'bank_transfer',
    );
    // Products the shop doesn't tag are paid on delivery, as before.
    const other = await checkout(1);
    expect(
      placed(await f.checkouts.place(other.secret, other.view.shown, FORM)).paymentMethod,
    ).toBe('cash_on_delivery');
  });

  it("leaves staff's orders to the shop", async () => {
    unwrap(await shopRules());
    const [kurta] = await f.variantsOf(f.a, 'Kurta', { price: '40,000' });
    await f.stock(f.a, kurta!, 1);
    const order = unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId: kurta!, quantity: 1 }],
        shippingAddress: { ...FORM, city: 'Gilgit' },
      }),
    );
    expect(order.paymentMethod).toBe('cash_on_delivery');
  });
});
