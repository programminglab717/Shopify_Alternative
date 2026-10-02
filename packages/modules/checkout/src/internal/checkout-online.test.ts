import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import type { CartActionName } from '@hatti/storefront-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import { shownOf, type CheckoutForm, type CheckoutView } from './checkout.service.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

const FORM: CheckoutForm = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  city: 'khi',
  address1: 'House 12, Street 4, Block 5',
  address2: '',
  landmark: '',
  province: '',
  payment: '',
  code: '',
  resend: '',
};

const SAFEPAY = { name: 'Safepay', origin: 'https://getsafepay.com' };

describe.skipIf(!server)('Paying online at checkout', () => {
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

  /** A checkout of `quantity` lawn suits at `price`, in stock: its secret and page. */
  async function started(price = '4,500', quantity = 1) {
    const [variant] = await f.variantsOf(f.a, 'Lawn 3-piece', { price });
    await f.stock(f.a, variant!, 50);
    const cart = await act(f.a, null, 'add', { items: [{ variantId: variant, quantity }] });
    const secret = await f.checkouts.start(f.a.shopId, cart);
    if (!secret) throw new Error('No checkout');
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(view.kind);
    return { secret, view };
  }

  function placed(view: CheckoutView | { url: string }) {
    if ('url' in view || view.kind !== 'placed') {
      throw new Error(`Expected the order placed, got ${JSON.stringify(view)}`);
    }
    return view;
  }

  it('offers paying online where the shop takes it, and places the order to wait for it', async () => {
    // No gateway: no paying online.
    const before = await started();
    expect(before.view.payments.online).toBeNull();
    expect(checkoutPage(before.view).html).not.toContain('value="online"');
    expect(
      await f.checkouts.place(before.secret, before.view.shown, { ...FORM, payment: 'online' }),
    ).toMatchObject({ kind: 'open', problem: { kind: 'changed' } });
    // An order paid on delivery has nothing to say of paying online, whatever its address says.
    placed(await f.checkouts.place(before.secret, before.view.shown, FORM));
    expect(placed(await f.checkouts.paidOnline(before.secret, {}))).toMatchObject({
      online: null,
      payment: null,
    });

    f.payments.gateway = SAFEPAY;
    const { secret, view } = await started();
    expect(view.payments.online).toEqual(SAFEPAY);
    // What the page offers is in what it showed: a gateway since makes the page stale.
    const digest = (online: typeof SAFEPAY | null) =>
      shownOf(
        view.cart,
        view.delivery,
        view.shop.policies,
        view.discount,
        {
          ...view.payments,
          online,
        },
        view.tax,
      );
    expect(digest(SAFEPAY)).toBe(view.shown);
    expect(digest(null)).not.toBe(view.shown);
    const page = checkoutPage(view).html;
    expect(page).toContain('<input type="radio" name="payment" value="online"');
    expect(page).toContain(
      'Pay online, by card or wallet: once your order is placed, you pay through Safepay, and ' +
        'A sends your order when the payment is in.',
    );

    // A transfer's discount and cash on delivery's fee are theirs, not paying online's.
    unwrap(
      await f.bankTransfer.update(f.a, {
        enabled: true,
        account: { title: 'A', bankName: 'Meezan Bank', iban: 'PK36 SCBL 0000 0011 2345 6702' },
        discount: { percentage: 5, cap: '300' },
      }),
    );
    unwrap(await f.codRules.update(f.a, { fee: '100' }));
    const again = await f.checkouts.view(secret);
    if (again.kind !== 'open') throw new Error(again.kind);
    const order = placed(
      await f.checkouts.place(secret, again.shown, { ...FORM, payment: 'online' }),
    ).order;
    expect(order).toMatchObject({
      paymentMethod: 'online',
      stage: 'awaiting_payment',
      confirmationStatus: 'not_required',
      financialStatus: 'pending',
      codFee: 0n,
      transferDiscount: 0n,
      codAmount: 0n,
      bankAccount: null,
      total: order.subtotal + order.shipping,
    });
    // Its thank-you page sends the shopper to pay it, through the gateway.
    const thanks = placed(await f.checkouts.view(secret));
    expect(thanks.online).toEqual({ gateway: SAFEPAY, amount: order.total });
    const shown = checkoutPage(thanks);
    expect(shown.html).toContain('<input type="hidden" name="action" value="pay" />');
    expect(shown.html).toContain(`Your order #${order.number} is placed. Pay Rs `);
    expect(shown.html).toContain('online, by card or wallet: A sends your order once it is paid.');
    expect(shown.html).not.toContain('Or transfer it to the account below.');
    expect(shown.contentSecurityPolicy).toContain("form-action 'self' https://getsafepay.com;");
  });

  it('sends the shopper to the gateway from the thank-you page, and says how it went', async () => {
    f.payments.gateway = SAFEPAY;
    const { secret, view } = await started();
    const order = placed(
      await f.checkouts.place(secret, view.shown, { ...FORM, payment: 'online' }),
    ).order;
    expect(await f.checkouts.payOnline(secret)).toEqual({
      url: 'https://pay.test/checkout?session=1',
    });
    expect(f.payments.started).toEqual([
      {
        shopId: f.a.shopId,
        orderId: order.id,
        returnUrl: `https://hatti.test/checkouts/${secret}/paid`,
        cancelUrl: `https://hatti.test/checkouts/${secret}`,
      },
    ]);
    // Another shop's storefront can't send it.
    expect(await f.checkouts.payOnline(secret, { shopId: f.b.shopId })).toEqual({
      kind: 'not_found',
    });
    // The gateway refusing: the page says so, with a 503.
    f.payments.answer = { error: 'Safepay: invalid client' };
    const refused = placed(await f.checkouts.payOnline(secret));
    expect(refused.payment).toBe('unavailable');
    expect(checkoutPage(refused).status).toBe(503);

    // Back from the gateway, as it says.
    f.payments.outcome = 'paid';
    const paid = placed(await f.checkouts.paidOnline(secret, { tracker: 't', sig: 's' }));
    expect(paid.payment).toBe('paid');
    expect(checkoutPage(paid).html).toContain(
      'Thank you: your payment is in, and A will send your order soon.',
    );
    expect(f.payments.returns).toEqual([{ orderId: order.id, form: { tracker: 't', sig: 's' } }]);
    f.payments.outcome = 'test';
    expect(placed(await f.checkouts.paidOnline(secret, {})).payment).toBe('test');
    // Nothing said yet, and the order still waits: waiting to hear.
    f.payments.outcome = null;
    const pending = placed(await f.checkouts.paidOnline(secret, {}));
    expect(pending.payment).toBe('pending');
    expect(checkoutPage(pending).html).toContain(
      'We haven&#39;t heard yet that your payment went through.',
    );
    expect(await f.checkouts.paidOnline('nothing-here-at-all-00', {})).toEqual({
      kind: 'not_found',
    });

    // Paid since, as by the gateway's webhook: the page offers nothing more to pay.
    await f.admin.query(
      `UPDATE orders.orders SET amount_paid = total, financial_status = 'paid', stage = 'to_pack'
        WHERE id = $1`,
      [order.id],
    );
    const done = placed(await f.checkouts.paidOnline(secret, {}));
    expect(done).toMatchObject({ online: null, payment: 'paid' });
    expect(checkoutPage(done).html).not.toContain('value="pay"');
    expect(await f.checkouts.payOnline(secret)).toMatchObject({ kind: 'placed', payment: null });
  });

  it("offers paying online when cash on delivery can't take the order", async () => {
    f.payments.gateway = SAFEPAY;
    // More than the law lets cash on delivery collect, and no transfers: online alone.
    const { secret, view } = await started('210,000');
    expect(view.problem).toBeNull();
    const page = checkoutPage(view).html;
    expect(page).toContain('<input type="hidden" name="payment" value="online" />');
    expect(page).not.toContain('value="cash_on_delivery"');
    const order = placed(await f.checkouts.place(secret, view.shown, FORM)).order;
    expect(order.paymentMethod).toBe('online');

    // The shop's rules keeping it from an order, with transfers too: a choice of the two.
    unwrap(
      await f.bankTransfer.update(f.a, {
        enabled: true,
        account: { title: 'A', bankName: 'Meezan Bank', iban: 'PK36 SCBL 0000 0011 2345 6702' },
      }),
    );
    unwrap(await f.codRules.update(f.a, { unavailableCities: ['Karachi'] }));
    const second = await started();
    const refused = await f.checkouts.place(second.secret, second.view.shown, {
      ...FORM,
      payment: 'cash_on_delivery',
    });
    if (refused.kind !== 'open') throw new Error(refused.kind);
    expect(refused.problem).toEqual({
      kind: 'cod_unavailable',
      refusal: { reason: 'city', city: 'Karachi' },
    });
    // A transfer is chosen for the shopper's next post; the page says both.
    expect(refused.form.payment).toBe('bank_transfer');
    expect(checkoutPage(refused).html).toContain(
      'Cash on delivery isn&#39;t available in Karachi. Pay online or by bank transfer instead.',
    );
  });

  it('places orders paid online through the API only where the shop takes payments online', async () => {
    const [variant] = await f.variantsOf(f.a, 'Kurta', { price: '2,000' });
    await f.stock(f.a, variant!, 5);
    const input = {
      lineItems: [{ variantId: variant!, quantity: 1 }],
      shippingAddress: {
        name: 'Ayesha Khan',
        phone: '0300 1234567',
        address1: 'House 12, Street 4',
        city: 'Lahore',
      },
      paymentMethod: 'online' as const,
    };
    const refused = await f.orders.create(f.a, input);
    expect(refused.ok ? null : refused.errors).toEqual([
      {
        field: ['input', 'paymentMethod'],
        code: 'INVALID',
        message: 'The shop takes no payments online: connect a payment gateway account first',
      },
    ]);
    f.payments.gateway = SAFEPAY;
    expect(unwrap(await f.orders.create(f.a, input))).toMatchObject({
      paymentMethod: 'online',
      stage: 'awaiting_payment',
      confirmationStatus: 'not_required',
    });
    // An advance is for cash on delivery.
    expect((await f.orders.create(f.a, { ...input, advanceDue: '500' })).ok).toBe(false);
  });
});
