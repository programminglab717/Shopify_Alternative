import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { CheckoutFunctions, type CheckoutFunctionInput } from './checkout-functions.js';
import { checkoutPage } from './checkout-pages.js';
import type { CheckoutForm, CheckoutView } from './checkout.service.js';
import { checkoutFixture, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

/** The shop's apps' functions as a test sets them: what each hides or says, and what each read. */
class FakeFunctions extends CheckoutFunctions {
  hidden: string[] = [];
  errors: string[] = [];
  readonly asked: CheckoutFunctionInput[] = [];

  hiddenPaymentMethods(_tx: unknown, _shopId: string, input: CheckoutFunctionInput) {
    this.asked.push(input);
    return Promise.resolve(this.hidden);
  }

  validationErrors(_tx: unknown, _shopId: string, input: CheckoutFunctionInput) {
    this.asked.push(input);
    return Promise.resolve(this.errors);
  }
}

describe.skipIf(!server)("Apps' functions at checkout (DEV-07, ADR-868)", () => {
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
    address2: 'Gulberg',
    landmark: 'near Jamia Masjid',
    province: '',
    payment: '',
    code: '',
    resend: '',
  };

  const open = (view: CheckoutView) => {
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    return view;
  };

  it("hides the ways to pay the shop's functions hide, and refuses an order a validation refuses", async () => {
    const functions = new FakeFunctions();
    const checkouts = f.checkoutsWithFunctions(functions);
    const action = parseAction('add', { items: [{ variantId: kurta, quantity: 2 }] });
    if ('code' in action) throw new Error('refused');
    const added = await f.carts.act(f.a.shopId, null, action);
    if (!added.ok) throw new Error('refused');
    const secret = (await checkouts.start(f.a.shopId, added.token!))!;

    // Nothing hidden: cash on delivery as ever, and what the function read.
    const shown = open(await checkouts.view(secret));
    expect(shown.payments.codRefusal).toBeNull();
    expect(functions.asked.at(-1)).toMatchObject({
      cart: { subtotal: 400_000, currency: 'PKR', lines: [{ quantity: 2, price: 200_000 }] },
      deliveryAddress: null,
      paymentMethods: ['cash_on_delivery'],
    });

    // Cash on delivery hidden: no way left to pay, the page says so.
    functions.hidden = ['cash_on_delivery'];
    const hidden = open(await checkouts.view(secret));
    expect(hidden.payments.codRefusal).toEqual({ reason: 'app' });
    expect(checkoutPage(hidden).html).toContain(
      'Cash on delivery isn&#39;t available for this order.',
    );

    // A validation's words refuse the order, the form kept.
    functions.hidden = [];
    functions.errors = ['We deliver kurtas to Karachi only this week.'];
    const refused = open(await checkouts.place(secret, shown.shown, FORM));
    expect(refused.problem).toEqual({
      kind: 'validation',
      messages: ['We deliver kurtas to Karachi only this week.'],
    });
    expect(refused.form.address1).toBe('House 12, Street 4');
    const page = checkoutPage(refused);
    expect(page.status).toBe(422);
    expect(page.html).toContain('We deliver kurtas to Karachi only this week.');
    expect(functions.asked.at(-1)).toMatchObject({
      deliveryAddress: { city: 'Lahore', province: '' },
      paymentMethods: ['cash_on_delivery'],
    });

    functions.errors = [];
    expect((await checkouts.place(secret, shown.shown, FORM)).kind).toBe('placed');
  });
});
