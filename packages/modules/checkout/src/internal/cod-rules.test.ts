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
  refusedDeliveriesLimit: 2,
  fee: 0n,
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
