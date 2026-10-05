import 'reflect-metadata';
import { CustomerService, StoreCreditService } from '@hatti/customers/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { formatMoney, money } from '@hatti/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import type { CheckoutForm, CheckoutView } from './checkout.service.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Store credit at checkout (ORD-09, ADR-186)', () => {
  let f: CheckoutFixture;
  let kurta: string;
  let customers: CustomerService;
  let credit: StoreCreditService;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
    customers = new CustomerService(f.db);
    credit = new StoreCreditService(f.db);
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

  /** A checkout of a kurta: its secret and its page as it opens. */
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

  /** Store credit for the customer with `phone`, made for them. */
  async function give(phone: string, amount: string) {
    const customer = unwrap(await customers.create(f.a, { phone, name: 'A customer' }));
    unwrap(await credit.credit(f.a, { customerId: customer.id }, { amount, currencyCode: 'PKR' }));
    return customer.id;
  }

  const problemOf = (view: CheckoutView) =>
    view.kind === 'open' ? view.problem : view.kind === 'placed' ? null : view.kind;

  /** The codes sent, the newest last. */
  const sent = async () =>
    (
      await f.admin.query<{ code: string }>(
        `SELECT variables ->> 'code' AS code FROM messaging.messages
          WHERE kind = 'one_time_code' ORDER BY created_at, id`,
      )
    ).rows;

  const orderCount = async () =>
    (await f.admin.query<{ count: number }>('SELECT count(*)::int AS count FROM orders.orders'))
      .rows[0]!.count;

  it('offers store credit once the shop gives it, and spends it once the shopper proves the number', async () => {
    // A shop that gave none offers none.
    const none = await checkout();
    expect(none.view.storeCredit).toBe(false);
    expect(checkoutPage(none.view).html).not.toContain('name="storeCredit"');

    const customerId = await give('0300 1234567', '1500');
    const { secret, view } = await checkout();
    expect(view.storeCredit).toBe(true);
    expect(checkoutPage(view).html).toContain('name="storeCredit"');

    // Asked for, the number is proved first, and nothing placed until it is.
    const asked = await f.checkouts.place(secret, view.shown, { ...FORM, storeCredit: '1' });
    expect(problemOf(asked)).toMatchObject({ kind: 'code', state: 'sent' });
    expect(await orderCount()).toBe(0);
    expect(checkoutPage(asked).html).toMatch(/name="storeCredit" value="1"\s+checked/);
    const [code] = await sent();

    const placed = await f.checkouts.place(secret, view.shown, {
      ...FORM,
      storeCredit: '1',
      code: code!.code,
    });
    if (placed.kind !== 'placed') throw new Error(`Expected it placed, got ${placed.kind}`);
    const { order } = placed;
    expect(placed.storeCredit).toBe(1_500_00n);
    expect(order).toMatchObject({
      customerId,
      amountPaid: 1_500_00n,
      codAmount: order.total - 1_500_00n,
      financialStatus: 'partially_paid',
    });
    // Placed as one whose number was proved.
    const { rows: proved } = await f.admin.query<{ phone_verified_at: Date | null }>(
      'SELECT phone_verified_at FROM orders.orders WHERE id = $1',
      [order.id],
    );
    expect(proved[0]!.phone_verified_at).toBeInstanceOf(Date);
    const page = checkoutPage(placed).html;
    expect(page).toContain('Store credit');
    expect(page).toContain('−Rs 1,500');
    expect(page).toContain(
      `You pay ${formatMoney(money(order.codAmount, 'PKR'))} when it arrives.`,
    );
    const [account] = await credit.accountsOf(f.a, customerId);
    expect(account!.balance).toBe(0n);
    // Its page later says the same.
    const again = await f.checkouts.view(secret);
    expect(again.kind === 'placed' && again.storeCredit).toBe(1_500_00n);

    // Proved by a code, the browser is spared a code where the shop's risk rules ask one, but
    // spending the number's credit asks one each time (ADR-199).
    unwrap(await credit.credit(f.a, { customerId }, { amount: '500', currencyCode: 'PKR' }));
    const next = await checkout();
    const client = { ip: null, userAgent: null, proof: placed.proof! };
    const spending = await f.checkouts.place(
      next.secret,
      next.view.shown,
      { ...FORM, storeCredit: '1' },
      { client },
    );
    expect(problemOf(spending)).toMatchObject({ kind: 'code', state: 'sent' });
  });

  it('says so when the number proved has none, and places nothing until it goes without', async () => {
    await give('0333 5551234', '500');
    const { secret, view } = await checkout();
    await f.checkouts.place(secret, view.shown, { ...FORM, storeCredit: '1' });
    const [code] = await sent();
    const refused = await f.checkouts.place(secret, view.shown, {
      ...FORM,
      storeCredit: '1',
      code: code!.code,
    });
    expect(problemOf(refused)).toEqual({ kind: 'no_store_credit' });
    expect(refused.kind === 'open' && refused.form.storeCredit).toBe('');
    expect(checkoutPage(refused).html).toContain('This number has no store credit with the shop');
    expect(await orderCount()).toBe(0);

    const placed = await f.checkouts.place(secret, view.shown, FORM);
    expect(placed.kind === 'placed' && placed.storeCredit).toBe(0n);
    expect(await orderCount()).toBe(1);
  });
});
