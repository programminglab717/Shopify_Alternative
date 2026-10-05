import 'reflect-metadata';
import { InputChecker } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import type { CartActionName } from '@hatti/storefront-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import type { CheckoutForm, CheckoutView } from './checkout.service.js';
import {
  NO_COD_RULES,
  advanceOf,
  advanceTakes,
  checkCodRules,
  placedAdvanceOf,
  type CodAdvanceInput,
  type CodAdvanceValue,
} from './cod-rules.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

/** An advance's conditions when it asks every order. */
const EVERY_ORDER = {
  above: null,
  cities: [],
  refusedDeliveries: null,
  newCustomers: false,
  riskScore: null,
};

describe('advanceOf', () => {
  const order = { items: 4_000_00n, delivery: 250_00n };

  it('asks for an amount, a percentage of the items or the delivery charge', () => {
    expect(advanceOf(null, order, 'PKR')).toBe(0n);
    const amount = (value: bigint): CodAdvanceValue => ({
      kind: 'fixed_amount',
      amount: value,
      ...EVERY_ORDER,
    });
    expect(advanceOf(amount(500_00n), order, 'PKR')).toBe(500_00n);
    // Never more than the items.
    expect(advanceOf(amount(5_000_00n), order, 'PKR')).toBe(4_000_00n);
    // A percentage to the rupee, half up: 12.5% of Rs 3,999 is Rs 499.875.
    const share = (bps: number): CodAdvanceValue => ({
      kind: 'percentage',
      percentageBps: bps,
      ...EVERY_ORDER,
    });
    expect(advanceOf(share(1_250), { items: 3_999_00n, delivery: 0n }, 'PKR')).toBe(500_00n);
    expect(advanceOf(share(10_000), order, 'PKR')).toBe(4_000_00n);
    const delivery: CodAdvanceValue = { kind: 'delivery', ...EVERY_ORDER };
    expect(advanceOf(delivery, order, 'PKR')).toBe(250_00n);
    // Nothing where delivery is free; not known before the city is.
    expect(advanceOf(delivery, { ...order, delivery: 0n }, 'PKR')).toBe(0n);
    expect(advanceOf(delivery, { ...order, delivery: null }, 'PKR')).toBeNull();
  });

  it('asks only on orders whose items come to more than its total', () => {
    const above: CodAdvanceValue = { kind: 'delivery', ...EVERY_ORDER, above: 4_000_00n };
    expect(advanceOf(above, { items: 4_000_00n, delivery: null }, 'PKR')).toBe(0n);
    expect(advanceOf(above, { items: 4_000_01n, delivery: null }, 'PKR')).toBeNull();
    expect(advanceOf(above, { items: 4_000_01n, delivery: 250_00n }, 'PKR')).toBe(250_00n);
  });

  it('asks only to its cities and of customers who refused as many parcels, once they are known', () => {
    const fiveHundred: CodAdvanceValue = {
      kind: 'fixed_amount',
      amount: 500_00n,
      ...EVERY_ORDER,
      cities: ['Quetta', 'Karachi'],
    };
    // The city as addresses have it, however it is typed; not known before it is.
    expect(advanceOf(fiveHundred, { ...order, city: 'khi' }, 'PKR')).toBe(500_00n);
    expect(advanceOf(fiveHundred, { ...order, city: 'Lahore' }, 'PKR')).toBe(0n);
    expect(advanceOf(fiveHundred, { ...order, city: 'Nowhere' }, 'PKR')).toBe(0n);
    for (const city of [undefined, null, ' ']) {
      expect(advanceOf(fiveHundred, { ...order, city }, 'PKR')).toBeNull();
    }
    // Of a customer who refused as many parcels before, or more.
    const refusers: CodAdvanceValue = { ...fiveHundred, cities: [], refusedDeliveries: 2 };
    expect(advanceOf(refusers, { ...order, refused: 1 }, 'PKR')).toBe(0n);
    expect(advanceOf(refusers, { ...order, refused: 2 }, 'PKR')).toBe(500_00n);
    expect(advanceOf(refusers, { ...order, refused: 5 }, 'PKR')).toBe(500_00n);
    expect(advanceOf(refusers, order, 'PKR')).toBeNull();
    // Both: each must hold; one that doesn't is enough to know it asks nothing.
    const both: CodAdvanceValue = { ...fiveHundred, refusedDeliveries: 1 };
    expect(advanceTakes(both, { city: 'Quetta', refused: 1 })).toBe(true);
    expect(advanceTakes(both, { city: 'Lahore' })).toBe(false);
    expect(advanceTakes(both, { refused: 0 })).toBe(false);
    expect(advanceTakes(both, { city: 'Quetta' })).toBeNull();
    // Nothing for items at or below its total, wherever and of whomever.
    expect(advanceOf({ ...both, above: 4_000_00n }, order, 'PKR')).toBe(0n);
  });

  it('asks only of customers new to the shop, and by risk only as an order is placed', () => {
    const fresh: CodAdvanceValue = {
      kind: 'fixed_amount',
      amount: 500_00n,
      ...EVERY_ORDER,
      newCustomers: true,
    };
    // None of their orders delivered before; not known before the number is.
    expect(advanceOf(fresh, { ...order, delivered: 0 }, 'PKR')).toBe(500_00n);
    expect(advanceOf(fresh, { ...order, delivered: 1 }, 'PKR')).toBe(0n);
    expect(advanceOf(fresh, order, 'PKR')).toBeNull();
    // With refusals, each must hold: a refuser never delivered to is both.
    const both: CodAdvanceValue = { ...fresh, refusedDeliveries: 1 };
    expect(advanceTakes(both, { refused: 1, delivered: 0 })).toBe(true);
    expect(advanceTakes(both, { refused: 1, delivered: 2 })).toBe(false);
    expect(advanceTakes(both, { refused: 0 })).toBe(false);
    expect(advanceTakes(both, { refused: 1 })).toBeNull();

    // By risk, never known before the order is scored, as it is placed; nothing where its other
    // conditions say so.
    const risky: CodAdvanceValue = { ...fresh, newCustomers: false, riskScore: 60 };
    expect(advanceOf(risky, { ...order, city: 'Lahore' }, 'PKR')).toBeNull();
    expect(advanceOf({ ...risky, above: 5_000_00n }, order, 'PKR')).toBe(0n);
    const placing = { ...order, delivery: 250_00n, city: 'Lahore' };
    expect(placedAdvanceOf(risky, placing, 'PKR')).toEqual({
      due: 0n,
      ifRisky: { due: 500_00n, from: 60 },
    });
    expect(placedAdvanceOf({ ...risky, cities: ['Quetta'] }, placing, 'PKR')).toEqual({
      due: 0n,
      ifRisky: null,
    });
    // Without a risk, asked whatever the order scores.
    expect(placedAdvanceOf(fresh, { ...placing, delivered: 0 }, 'PKR')).toEqual({
      due: 500_00n,
      ifRisky: null,
    });
    expect(placedAdvanceOf(fresh, { ...placing, delivered: 3 }, 'PKR')).toEqual({
      due: 0n,
      ifRisky: null,
    });
    expect(placedAdvanceOf(null, placing, 'PKR')).toEqual({ due: 0n, ifRisky: null });
  });
});

describe('checkCodRules', () => {
  /** The advance `input` gives; or its errors, as [field, code]. */
  function advance(input: CodAdvanceInput | null) {
    const check = new InputChecker();
    const rules = checkCodRules(check, NO_COD_RULES, { advance: input }, 'PKR');
    return rules ? rules.advance : check.errors.map((error) => [error.field.join('.'), error.code]);
  }

  function messages(input: CodAdvanceInput) {
    const check = new InputChecker();
    checkCodRules(check, NO_COD_RULES, { advance: input }, 'PKR');
    return check.errors.map((error) => error.message);
  }

  it('takes an amount, a percentage or the delivery charge: one of them', () => {
    expect(advance({ amount: '500' })).toEqual({
      kind: 'fixed_amount',
      amount: 500_00n,
      ...EVERY_ORDER,
    });
    expect(advance({ percentage: 12.5, above: '10,000' })).toEqual({
      kind: 'percentage',
      percentageBps: 1_250,
      ...EVERY_ORDER,
      above: 10_000_00n,
    });
    expect(advance({ deliveryCharge: true, above: ' ', amount: '', cities: [] })).toEqual({
      kind: 'delivery',
      ...EVERY_ORDER,
    });
    expect(advance(null)).toBeNull();
    expect(advance({ deliveryCharge: false })).toEqual([['input.advance', 'BLANK']]);
    expect(messages({})).toEqual([
      'Say what to ask for in advance: an amount, a percentage or the delivery charge',
    ]);
    expect(advance({ amount: '500', deliveryCharge: true })).toEqual([
      ['input.advance', 'INVALID'],
    ]);
    expect(messages({ amount: '500', percentage: 20 })).toEqual([
      'Ask for an amount, a percentage or the delivery charge: one of them',
    ]);
  });

  it('refuses nothing to ask for, past all of the items, and a total of zero', () => {
    expect(advance({ amount: '0', above: '0' })).toEqual([
      ['input.advance.above', 'INVALID'],
      ['input.advance.amount', 'INVALID'],
    ]);
    expect(messages({ amount: '0', above: '0' })).toEqual([
      'The total must be above Rs 0',
      'Amount must be more than zero',
    ]);
    for (const percentage of [0, 100.5, 12.345]) {
      expect(advance({ percentage })).toEqual([['input.advance.percentage', 'INVALID']]);
    }
    expect(messages({ percentage: 0 })).toEqual([
      'Percentage must be from 0.01 to 100, with two decimals at most, like 20 or 12.5',
    ]);
    expect(advance({ amount: 'five hundred' })).toEqual([['input.advance.amount', 'INVALID']]);
  });

  it('takes the cities addresses name, each once, and refusals from 1 to 100', () => {
    expect(
      advance({ amount: '500', cities: ['quetta', 'KHI', ' Karachi '], refusedDeliveries: 1 }),
    ).toEqual({
      kind: 'fixed_amount',
      amount: 500_00n,
      ...EVERY_ORDER,
      cities: ['Quetta', 'Karachi'],
      refusedDeliveries: 1,
    });
    expect(
      advance({ deliveryCharge: true, cities: ['Lahore', 'Atlantis'], refusedDeliveries: 0 }),
    ).toEqual([
      ['input.advance.cities.1', 'INVALID'],
      ['input.advance.refusedDeliveries', 'INVALID'],
    ]);
    expect(
      messages({ deliveryCharge: true, cities: ['Atlantis'], refusedDeliveries: 101 }),
    ).toEqual([
      '"Atlantis" is not a city of Pakistan we know',
      'Refused deliveries must be a whole number from 1 to 100',
    ]);
    // The page names them all: fifty at most.
    const many = Array.from({ length: 51 }, () => 'Quetta');
    expect(advance({ amount: '500', cities: many })).toEqual([
      ['input.advance.cities', 'TOO_MANY'],
    ]);
    expect(messages({ amount: '500', cities: many })).toEqual(['At most 50 cities']);
  });

  it('takes new customers alone, and a risk score from 0.01 to 1, in hundredths', () => {
    expect(advance({ deliveryCharge: true, newCustomers: true, riskScore: 0.6 })).toEqual({
      kind: 'delivery',
      ...EVERY_ORDER,
      newCustomers: true,
      riskScore: 60,
    });
    expect(advance({ deliveryCharge: true, newCustomers: null, riskScore: 1 })).toMatchObject({
      newCustomers: false,
      riskScore: 100,
    });
    for (const riskScore of [0, 1.01, 0.605, -0.5, Number.NaN]) {
      expect(advance({ deliveryCharge: true, riskScore })).toEqual([
        ['input.advance.riskScore', 'INVALID'],
      ]);
    }
    expect(messages({ deliveryCharge: true, riskScore: 2 })).toEqual([
      'Risk score must be from 0.01 to 1, in hundredths',
    ]);
  });
});

describe.skipIf(!server)('An advance at checkout', () => {
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
    code: '',
    resend: '',
  };

  const IBAN = 'PK36SCBL0000001123456702';

  /** The shop's account, which an advance is paid into: transfer offered, or not. */
  const giveAccount = (enabled = false) =>
    f.bankTransfer.update(f.a, {
      enabled,
      account: { title: 'Zari', bankName: 'Standard Chartered', iban: IBAN },
    });

  async function act(token: string | null, name: CartActionName, body: unknown) {
    const action = parseAction(name, body);
    if ('code' in action) throw new Error(`Refused: ${JSON.stringify(action)}`);
    const result = await f.carts.act(f.a.shopId, token, action);
    if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.error)}`);
    return result.token!;
  }

  /** A checkout of `quantity` kurtas at Rs 4,000, and its page. */
  async function checkout(quantity = 1) {
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

  let shoppers = 0;

  /**
   * A cash-on-delivery order placed through a checkout of `quantity` kurtas, to `city`: each by a
   * shopper of its own, as checkout takes three orders a day from one number (CHK-18).
   */
  async function order(quantity = 1, city = 'Lahore') {
    const { secret, view } = await checkout(quantity);
    const phone = `0300-12345${String(shoppers++ % 100).padStart(2, '0')}`;
    return placed(await f.checkouts.place(secret, view.shown, { ...FORM, city, phone }));
  }

  it("keeps the shop's advance, which needs its bank account, and records each change", async () => {
    const refused = await f.codRules.update(f.a, { advance: { amount: '500' } });
    expect(refused.ok ? [] : refused.errors).toEqual([
      {
        field: ['input', 'advance'],
        code: 'INVALID',
        message: "An advance is paid into the shop's bank account: give its account first",
      },
    ]);
    unwrap(await giveAccount());
    await f.admin.query('DELETE FROM platform.outbox_events');
    const saved = unwrap(
      await f.codRules.update(f.a, { advance: { amount: '500', above: '5,000' } }),
    );
    expect(saved.advance).toEqual({
      kind: 'fixed_amount',
      amount: 500_00n,
      ...EVERY_ORDER,
      above: 5_000_00n,
    });
    // The same again changes nothing; another kind replaces it, as stored.
    unwrap(await f.codRules.update(f.a, { advance: { amount: '500.00', above: '5000' } }));
    unwrap(await f.codRules.update(f.a, { advance: { percentage: 20 } }));
    expect((await f.codRules.get(f.a)).advance).toEqual({
      kind: 'percentage',
      percentageBps: 2_000,
      ...EVERY_ORDER,
    });
    unwrap(await f.codRules.update(f.a, { advance: { deliveryCharge: true } }));
    expect((await f.codRules.get(f.a)).advance).toEqual({ kind: 'delivery', ...EVERY_ORDER });
    // Without the account, its other rules still change, the advance kept.
    unwrap(await f.bankTransfer.update(f.a, { account: null }));
    expect(unwrap(await f.codRules.update(f.a, { fee: '100' })).advance).toEqual({
      kind: 'delivery',
      ...EVERY_ORDER,
    });
    expect(unwrap(await f.codRules.update(f.a, { advance: null })).advance).toBeNull();
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'cod_settings.updated')
        .map((event) => event.payload),
    ).toEqual([
      { changed: ['advance'] },
      { changed: ['advance'] },
      { changed: ['advance'] },
      { changed: ['fee'] },
      { changed: ['advance'] },
    ]);
    expect((await f.codRules.get(f.b)).advance).toBeNull();
  });

  it('asks for it beside cash on delivery, and the order it places waits for it', async () => {
    unwrap(await giveAccount());
    unwrap(await f.delivery.update(f.a, { charge: '250' }));
    unwrap(await f.codRules.update(f.a, { fee: '100', advance: { amount: '500' } }));
    const { secret, view } = await checkout();
    expect(view.payments.advance).toEqual({
      kind: 'fixed_amount',
      amount: 500_00n,
      ...EVERY_ORDER,
    });
    // Transfer is off: paid on delivery alone, its advance taken off what the door collects.
    expect(checkoutPage(view).html).toMatch(/Pay on delivery<\/span>[\s\S]*?Rs 3,850/);
    const ordered = placed(await f.checkouts.place(secret, view.shown, FORM));
    expect(ordered).toMatchObject({
      paymentMethod: 'cash_on_delivery',
      // Paying it ahead is the customer's say-so: no call, no score.
      stage: 'awaiting_payment',
      confirmationStatus: 'not_required',
      risk: null,
      total: 4_350_00n,
      codFee: 100_00n,
      advanceDue: 500_00n,
      amountPaid: 0n,
      codAmount: 3_850_00n,
      bankAccount: { iban: IBAN },
    });
    // The thank-you page says where to pay it.
    const thanks = checkoutPage(await f.checkouts.view(secret)).html;
    expect(thanks).toContain(
      `Pay Rs 500 in advance by bank transfer, with #${ordered.number} as the reference`,
    );
    expect(thanks).toContain(IBAN.slice(0, 4));
    expect(thanks).toContain('You pay Rs 3,850 when it arrives.');
    // Recorded once it is in, the order is the shop's to pack.
    expect(unwrap(await f.orders.recordPayment(f.a, ordered.id))).toMatchObject({
      stage: 'to_pack',
      amountPaid: 500_00n,
    });
    expect(checkoutPage(await f.checkouts.view(secret)).html).toContain(
      `Your order #${ordered.number} is placed. A will be in touch before sending it.`,
    );
  });

  it('asks for a percentage, the delivery charge, or only above a total', async () => {
    unwrap(await giveAccount(true));
    unwrap(
      await f.delivery.update(f.a, {
        charge: '250',
        freeAbove: '10,000',
        zones: [{ name: 'Karachi', cities: ['Karachi'], charge: '150' }],
      }),
    );
    // 20% of Rs 4,000.
    unwrap(await f.codRules.update(f.a, { advance: { percentage: 20 } }));
    expect(await order()).toMatchObject({ advanceDue: 800_00n, codAmount: 3_450_00n });
    // The city's delivery charge, known as it is placed; nothing where delivery is free.
    unwrap(await f.codRules.update(f.a, { advance: { deliveryCharge: true } }));
    expect(await order(1, 'Karachi')).toMatchObject({ advanceDue: 150_00n, codAmount: 4_000_00n });
    const free = await order(3);
    expect(free).toMatchObject({
      shipping: 0n,
      advanceDue: 0n,
      stage: 'needs_confirmation',
      confirmationStatus: 'pending',
    });
    // Above Rs 5,000 of items alone.
    unwrap(await f.codRules.update(f.a, { advance: { amount: '1,000', above: '5,000' } }));
    expect(await order(1)).toMatchObject({ advanceDue: 0n, stage: 'needs_confirmation' });
    expect(await order(2)).toMatchObject({ advanceDue: 1_000_00n, stage: 'awaiting_payment' });
    // Paid by transfer, there is nothing ahead to ask for.
    const { secret, view } = await checkout(2);
    expect(
      placed(await f.checkouts.place(secret, view.shown, { ...FORM, payment: 'bank_transfer' })),
    ).toMatchObject({ paymentMethod: 'bank_transfer', advanceDue: 0n, total: 8_250_00n });
  });

  it('asks it only to the cities the shop names, and of customers who refused parcels before', async () => {
    unwrap(await giveAccount());
    unwrap(await f.delivery.update(f.a, { charge: '250' }));
    await f.admin.query('DELETE FROM platform.outbox_events');
    const saved = unwrap(
      await f.codRules.update(f.a, { advance: { amount: '500', cities: ['Quetta', 'khi'] } }),
    );
    expect(saved.advance).toEqual({
      kind: 'fixed_amount',
      amount: 500_00n,
      ...EVERY_ORDER,
      cities: ['Quetta', 'Karachi'],
    });
    // The page says where before the city is typed; placing asks it there alone.
    const opened = await checkout();
    expect(checkoutPage(opened.view).html).toContain(
      'On orders to Quetta or Karachi, you pay Rs 500 in advance by bank transfer.',
    );
    expect(await order(1, 'karachi')).toMatchObject({
      advanceDue: 500_00n,
      stage: 'awaiting_payment',
    });
    expect(await order(1, 'Lahore')).toMatchObject({
      advanceDue: 0n,
      stage: 'needs_confirmation',
    });
    // Its cities changed while a page is open: the page is shown again.
    unwrap(await f.codRules.update(f.a, { advance: { amount: '500', cities: ['Quetta'] } }));
    const again = open(await f.checkouts.place(opened.secret, opened.view.shown, FORM));
    expect(again.problem).toEqual({ kind: 'changed' });

    // Of customers who refused a parcel before, wherever they are; a number new to the shop isn't
    // looked into until it places an order.
    unwrap(await f.codRules.update(f.a, { advance: { amount: '500', refusedDeliveries: 1 } }));
    const phone = '0333-7654321';
    const first = await checkout();
    const refused = placed(
      await f.checkouts.place(first.secret, first.view.shown, { ...FORM, phone }),
    );
    expect(refused.advanceDue).toBe(0n);
    unwrap(await f.orders.confirm(f.a, refused.id));
    const parcel = unwrap(await f.fulfillments.fulfill(f.a, refused.id, {})).fulfillmentId;
    unwrap(await f.fulfillments.markReturning(f.a, parcel));
    // Their next order asks it, from their number however it is written; another's doesn't.
    const next = await checkout();
    expect(
      placed(
        await f.checkouts.place(next.secret, next.view.shown, {
          ...FORM,
          phone: '+92 333 7654321',
        }),
      ),
    ).toMatchObject({ advanceDue: 500_00n, stage: 'awaiting_payment' });
    expect(await order()).toMatchObject({ advanceDue: 0n });

    // Both: of a customer who refused before, in Quetta alone.
    unwrap(
      await f.codRules.update(f.a, {
        advance: { amount: '500', cities: ['Quetta'], refusedDeliveries: 1 },
      }),
    );
    // A day on, as checkout takes three orders a day from a number (CHK-18).
    await f.admin.query(`UPDATE orders.orders SET created_at = created_at - interval '25 hours'`);
    for (const [city, advanceDue] of [
      ['Lahore', 0n],
      ['Quetta', 500_00n],
    ] as const) {
      const { secret, view } = await checkout();
      expect(
        placed(await f.checkouts.place(secret, view.shown, { ...FORM, phone, city })).advanceDue,
      ).toBe(advanceDue);
    }
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'cod_settings.updated')
        .map((event) => event.payload),
    ).toEqual([
      { changed: ['advance'] },
      { changed: ['advance'] },
      { changed: ['advance'] },
      { changed: ['advance'] },
    ]);
  });

  it('asks it of customers new to the shop alone, and of orders scored high instead of holding them', async () => {
    unwrap(await giveAccount());
    unwrap(await f.delivery.update(f.a, { charge: '250' }));
    await f.admin.query('DELETE FROM platform.outbox_events');
    // New customers alone: none of their orders delivered before, by any of their numbers.
    const saved = unwrap(
      await f.codRules.update(f.a, { advance: { deliveryCharge: true, newCustomers: true } }),
    );
    expect(saved.advance).toEqual({ kind: 'delivery', ...EVERY_ORDER, newCustomers: true });
    const opened = await checkout();
    expect(checkoutPage(opened.view).html).toContain(
      'If no order from this shop has reached you before, you pay the delivery charge in ' +
        'advance by bank transfer.',
    );
    const phone = '0345-1112233';
    const first = placed(
      await f.checkouts.place(opened.secret, opened.view.shown, { ...FORM, phone }),
    );
    expect(first).toMatchObject({ advanceDue: 250_00n, stage: 'awaiting_payment' });
    // Delivered, they are new no more.
    unwrap(await f.orders.recordPayment(f.a, first.id));
    const parcel = unwrap(await f.fulfillments.fulfill(f.a, first.id, {})).fulfillmentId;
    unwrap(await f.fulfillments.markDelivered(f.a, parcel));
    const next = await checkout();
    expect(
      placed(await f.checkouts.place(next.secret, next.view.shown, { ...FORM, phone })),
    ).toMatchObject({ advanceDue: 0n, stage: 'needs_confirmation' });

    // By risk: an order its rules score 0.30 or more is asked for it instead of waiting for
    // review, and keeps its score; one scored lower isn't, and waits as before.
    await f.admin.query(
      `INSERT INTO orders.risk_settings (shop_id, hold_at, high_value) VALUES ($1, 30, 1500000)`,
      [f.a.shopId],
    );
    unwrap(await f.codRules.update(f.a, { advance: { amount: '500', riskScore: 0.3 } }));
    const page = await checkout();
    expect(checkoutPage(page.view).html).toContain(
      'If the shop&#39;s checks on your order call for it, you pay Rs 500 in advance by bank ' +
        'transfer.',
    );
    // A first order with a short address and no house number: 0.35.
    const vague = { ...FORM, phone: '0321-5556677', address1: 'Bazaar' };
    const risky = placed(await f.checkouts.place(page.secret, page.view.shown, vague));
    expect(risky).toMatchObject({
      advanceDue: 500_00n,
      stage: 'awaiting_payment',
      confirmationStatus: 'not_required',
      risk: { score: 35, level: 'medium' },
      bankAccount: { iban: IBAN },
    });
    expect((await f.orders.timeline(f.a, risky.id, { first: 1 })).items[0]!.message).toBe(
      'Asks for Rs 500 in advance for its risk 0.35 (medium). The address has no house or ' +
        'street number; First order from this number; The address is very short',
    );
    // A first order with a full address: 0.10, asked nothing.
    expect(await order()).toMatchObject({
      advanceDue: 0n,
      stage: 'needs_confirmation',
      risk: { score: 10 },
      bankAccount: null,
    });
    // Asked only from 0.50, the same order waits for review, at the shop's 0.30.
    unwrap(await f.codRules.update(f.a, { advance: { amount: '500', riskScore: 0.5 } }));
    const held = await checkout();
    expect(
      placed(
        await f.checkouts.place(held.secret, held.view.shown, {
          ...vague,
          phone: '0321-5556678',
        }),
      ),
    ).toMatchObject({ advanceDue: 0n, stage: 'needs_review', risk: { score: 35 } });
  });

  it('asks for none without the account, and shows a page again once its advance changed', async () => {
    unwrap(await giveAccount());
    unwrap(await f.codRules.update(f.a, { advance: { amount: '500' } }));
    const before = await checkout();
    unwrap(await f.codRules.update(f.a, { advance: { amount: '700' } }));
    const again = open(await f.checkouts.place(before.secret, before.view.shown, FORM));
    expect(again.problem).toEqual({ kind: 'changed' });
    expect(again.payments.advance).toMatchObject({ amount: 700_00n });

    // The account taken away, it asks for none: an order paid on delivery, as before.
    unwrap(await f.bankTransfer.update(f.a, { account: null }));
    const changed = open(await f.checkouts.place(before.secret, again.shown, FORM));
    expect(changed.problem).toEqual({ kind: 'changed' });
    expect(changed.payments.advance).toBeNull();
    expect(checkoutPage(changed).html).not.toContain('in advance');
    expect(placed(await f.checkouts.place(before.secret, changed.shown, FORM))).toMatchObject({
      paymentMethod: 'cash_on_delivery',
      advanceDue: 0n,
      stage: 'needs_confirmation',
      bankAccount: null,
    });
  });

  let lehngas = 0;

  /** A checkout of `quantity` lehngas at `price`, and its page. */
  async function lehngaCheckout(price: string, quantity = 1) {
    const [lehnga] = await f.variantsOf(f.a, `Lehnga ${lehngas++}`, { price });
    await f.stock(f.a, lehnga!, 10);
    const token = await act(null, 'add', { items: [{ variantId: lehnga, quantity }] });
    const secret = (await f.checkouts.start(f.a.shopId, token))!;
    return { secret, view: open(await f.checkouts.view(secret)) };
  }

  it("asks what an order comes to past the law's cap in advance, where the shop has its account", async () => {
    // Without the account, a cart past the cap can't be paid on delivery at all.
    const without = await lehngaCheckout('110,000', 2);
    expect(without.view.payments).toMatchObject({
      codRefusal: { reason: 'law' },
      capAdvance: false,
    });
    expect(without.view.problem).toEqual({ kind: 'cod_limit' });

    unwrap(await giveAccount());
    unwrap(await f.codRules.update(f.a, { fee: '150' }));
    const { secret, view } = await lehngaCheckout('110,000', 2);
    expect(view.payments).toMatchObject({ codRefusal: null, capAdvance: true });
    // Delivery costs nothing anywhere here: the page knows what passes the cap.
    const page = checkoutPage(view).html;
    expect(page).toContain(
      'By law, cash on delivery collects at most Rs 200,000 an order, so you pay Rs 20,150 of ' +
        'this one in advance by bank transfer.',
    );
    expect(page).toMatch(/Pay on delivery<\/span>[\s\S]*?Rs 200,000/);
    const order = placed(await f.checkouts.place(secret, view.shown, FORM));
    expect(order).toMatchObject({
      paymentMethod: 'cash_on_delivery',
      // Paying ahead is the customer's say-so: no score.
      stage: 'awaiting_payment',
      risk: null,
      total: 220_150_00n,
      advanceDue: 20_150_00n,
      codAmount: 200_000_00n,
      bankAccount: { iban: IBAN },
    });
    expect(checkoutPage(await f.checkouts.view(secret)).html).toContain(
      `Pay Rs 20,150 in advance by bank transfer, with #${order.number} as the reference`,
    );

    // The shop's own advance is asked instead, where it is more.
    unwrap(await f.codRules.update(f.a, { advance: { amount: '50,000' } }));
    const own = await lehngaCheckout('110,000', 2);
    expect(checkoutPage(own.view).html).toContain('so you pay at least Rs 20,150 of this one');
    expect(
      placed(
        await f.checkouts.place(own.secret, own.view.shown, { ...FORM, phone: '0321-5556677' }),
      ),
    ).toMatchObject({ advanceDue: 50_000_00n, codAmount: 170_150_00n });
  });

  it('says so where delivery may take an order past the cap, and asks it only of those it does', async () => {
    unwrap(await giveAccount());
    unwrap(
      await f.delivery.update(f.a, {
        charge: '0',
        zones: [{ name: 'Karachi', cities: ['Karachi'], charge: '500' }],
      }),
    );
    // Rs 199,800.25 is within the cap, unless it goes to Karachi.
    const { secret, view } = await lehngaCheckout('199,800.25');
    expect(view.payments.capAdvance).toBe(true);
    expect(checkoutPage(view).html).toContain(
      'By law, cash on delivery collects at most Rs 200,000 an order: what an order comes to ' +
        'past that, you pay in advance by bank transfer.',
    );
    expect(placed(await f.checkouts.place(secret, view.shown, FORM))).toMatchObject({
      advanceDue: 0n,
      codAmount: 199_800_25n,
    });
    // To Karachi Rs 300.25 passes it: Rs 301 in advance, so that what is transferred is whole.
    const karachi = await lehngaCheckout('199,800.25');
    expect(
      placed(
        await f.checkouts.place(karachi.secret, karachi.view.shown, {
          ...FORM,
          city: 'Karachi',
          phone: '0321-5556677',
        }),
      ),
    ).toMatchObject({ total: 200_300_25n, advanceDue: 301_00n, codAmount: 199_999_25n });

    // A page shown before the shop gave its account said nothing of it: it is shown again first.
    unwrap(await f.bankTransfer.update(f.a, { account: null }));
    const before = await lehngaCheckout('199,800.25');
    expect(before.view.payments.capAdvance).toBe(false);
    unwrap(await giveAccount());
    const again = open(
      await f.checkouts.place(before.secret, before.view.shown, {
        ...FORM,
        city: 'Karachi',
        phone: '0333-5551234',
      }),
    );
    expect(again).toMatchObject({ problem: { kind: 'changed' }, payments: { capAdvance: true } });
  });
});
