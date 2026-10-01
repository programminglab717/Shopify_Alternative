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
  checkCodRules,
  type CodAdvanceInput,
  type CodAdvanceValue,
} from './cod-rules.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

describe('advanceOf', () => {
  const order = { items: 4_000_00n, delivery: 250_00n };

  it('asks for an amount, a percentage of the items or the delivery charge', () => {
    expect(advanceOf(null, order, 'PKR')).toBe(0n);
    const amount = (value: bigint): CodAdvanceValue => ({
      kind: 'fixed_amount',
      amount: value,
      above: null,
    });
    expect(advanceOf(amount(500_00n), order, 'PKR')).toBe(500_00n);
    // Never more than the items.
    expect(advanceOf(amount(5_000_00n), order, 'PKR')).toBe(4_000_00n);
    // A percentage to the rupee, half up: 12.5% of Rs 3,999 is Rs 499.875.
    const share = (bps: number): CodAdvanceValue => ({
      kind: 'percentage',
      percentageBps: bps,
      above: null,
    });
    expect(advanceOf(share(1_250), { items: 3_999_00n, delivery: 0n }, 'PKR')).toBe(500_00n);
    expect(advanceOf(share(10_000), order, 'PKR')).toBe(4_000_00n);
    const delivery: CodAdvanceValue = { kind: 'delivery', above: null };
    expect(advanceOf(delivery, order, 'PKR')).toBe(250_00n);
    // Nothing where delivery is free; not known before the city is.
    expect(advanceOf(delivery, { ...order, delivery: 0n }, 'PKR')).toBe(0n);
    expect(advanceOf(delivery, { ...order, delivery: null }, 'PKR')).toBeNull();
  });

  it('asks only on orders whose items come to more than its total', () => {
    const above: CodAdvanceValue = { kind: 'delivery', above: 4_000_00n };
    expect(advanceOf(above, { items: 4_000_00n, delivery: null }, 'PKR')).toBe(0n);
    expect(advanceOf(above, { items: 4_000_01n, delivery: null }, 'PKR')).toBeNull();
    expect(advanceOf(above, { items: 4_000_01n, delivery: 250_00n }, 'PKR')).toBe(250_00n);
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
      above: null,
    });
    expect(advance({ percentage: 12.5, above: '10,000' })).toEqual({
      kind: 'percentage',
      percentageBps: 1_250,
      above: 10_000_00n,
    });
    expect(advance({ deliveryCharge: true, above: ' ', amount: '' })).toEqual({
      kind: 'delivery',
      above: null,
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

  /** A cash-on-delivery order placed through a checkout of `quantity` kurtas, to `city`. */
  async function order(quantity = 1, city = 'Lahore') {
    const { secret, view } = await checkout(quantity);
    return placed(await f.checkouts.place(secret, view.shown, { ...FORM, city }));
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
    expect(saved.advance).toEqual({ kind: 'fixed_amount', amount: 500_00n, above: 5_000_00n });
    // The same again changes nothing; another kind replaces it, as stored.
    unwrap(await f.codRules.update(f.a, { advance: { amount: '500.00', above: '5000' } }));
    unwrap(await f.codRules.update(f.a, { advance: { percentage: 20 } }));
    expect((await f.codRules.get(f.a)).advance).toEqual({
      kind: 'percentage',
      percentageBps: 2_000,
      above: null,
    });
    unwrap(await f.codRules.update(f.a, { advance: { deliveryCharge: true } }));
    expect((await f.codRules.get(f.a)).advance).toEqual({ kind: 'delivery', above: null });
    // Without the account, its other rules still change, the advance kept.
    unwrap(await f.bankTransfer.update(f.a, { account: null }));
    expect(unwrap(await f.codRules.update(f.a, { fee: '100' })).advance).toEqual({
      kind: 'delivery',
      above: null,
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
    expect(view.payments.advance).toEqual({ kind: 'fixed_amount', amount: 500_00n, above: null });
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
});
