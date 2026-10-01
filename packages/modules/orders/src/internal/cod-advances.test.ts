import 'reflect-metadata';
import type { MutationResult } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { orderLinkPage } from './link-pages.js';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

const ACCOUNT = {
  title: 'Zari Textiles',
  bankName: 'Standard Chartered',
  iban: 'PK36SCBL0000001123456702',
  raastId: '0300 1234567',
};

describe.skipIf(!server)('An advance on cash on delivery', () => {
  let f: OrdersFixture;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 10);
    unwrap(await f.bankTransfer.update(f.a, { enabled: true, account: ACCOUNT }));
  });

  const latest = async (orderId: string) =>
    (await f.orders.timeline(f.a, orderId, { first: 1 })).items.map((entry) => entry.message);

  /** Why a change was refused: its first error's message; null if it was not. */
  const refusalOf = (result: MutationResult<unknown>) =>
    result.ok ? null : result.errors[0]!.message;

  it('waits for the advance it asks for, then for nothing but the courier', async () => {
    const order = await f.order(f.a, [kurta], { shippingPrice: '250', advanceDue: '500' });
    expect(order).toMatchObject({
      paymentMethod: 'cash_on_delivery',
      stage: 'awaiting_payment',
      // Paying the advance is the customer's say-so: no call, no score.
      confirmationStatus: 'not_required',
      risk: null,
      financialStatus: 'pending',
      total: 2_250_00n,
      amountPaid: 0n,
      advanceDue: 500_00n,
      codAmount: 1_750_00n,
      bankAccount: { iban: ACCOUNT.iban, raastId: '+923001234567' },
    });
    expect((await f.orders.home(f.a)).awaitingPayment).toEqual({ count: 1, total: 2_250_00n });
    expect(refusalOf(await f.orders.markPacked(f.a, order.id))).toBe(
      'Only confirmed or paid orders can be packed',
    );
    expect(refusalOf(await f.fulfillments.fulfill(f.a, order.id, {}))).toBe(
      'Record the advance it asks for once it is in',
    );

    // Recorded by hand, as it waits for it: then it is to pack.
    const paid = unwrap(await f.orders.recordPayment(f.a, order.id));
    expect(paid).toMatchObject({
      stage: 'to_pack',
      financialStatus: 'partially_paid',
      amountPaid: 500_00n,
      codAmount: 1_750_00n,
    });
    expect(await latest(order.id)).toEqual([
      'Recorded a payment of Rs 500 by bank transfer: the advance it asked for',
    ]);
    const paidEvents = (await f.outbox()).filter((event) => event.event_type === 'order.paid');
    expect(paidEvents.at(-1)?.payload).toMatchObject({ amountPaid: '50000', stage: 'to_pack' });
    // No more than it owes; then the rest, as the courier's cash comes in.
    expect(errorsOf(await f.orders.recordPayment(f.a, order.id, { amount: '1,751' }))).toEqual([
      ['amount', 'INVALID'],
    ]);
    unwrap(await f.orders.markPacked(f.a, order.id));
    unwrap(await f.fulfillments.fulfill(f.a, order.id, {}));
    const full = unwrap(await f.orders.recordPayment(f.a, order.id));
    expect(full).toMatchObject({ financialStatus: 'paid', amountPaid: 2_250_00n });
    expect(await latest(order.id)).toEqual(['Recorded a payment of Rs 1,750, paying it in full']);
    expect(refusalOf(await f.orders.recordPayment(f.a, order.id))).toBe(
      'The order is paid in full',
    );
  });

  it('asks for one only on cash on delivery, from a shop with an account, within the law', async () => {
    const place = (extra: Record<string, unknown>, tenant = f.a) =>
      f.orders.create(tenant, {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: '0300-1234567',
          address1: 'House 12, Street 4',
          city: 'khi',
        },
        ...extra,
      });
    expect(errorsOf(await place({ paymentMethod: 'prepaid', advanceDue: '500' }))).toEqual([
      ['input.advanceDue', 'INVALID'],
    ]);
    expect(refusalOf(await place({ advancePaid: '200', advanceDue: '500' }))).toBe(
      'Ask for an advance, or give the one paid already: not both',
    );
    expect(errorsOf(await place({ advanceDue: '2,001' }))).toEqual([
      ['input.advanceDue', 'INVALID'],
    ]);
    // The customer pays it into the shop's account: no account, no advance.
    const [shawl] = (await f.variantsOf(f.b, 'Shawl')) as [string];
    await f.stock(f.b, shawl, 5);
    const elsewhere = await f.orders.create(f.b, {
      lineItems: [{ variantId: shawl, quantity: 1 }],
      shippingAddress: { name: 'Sana', phone: '0321-5556677', address1: 'House 5', city: 'lhr' },
      advanceDue: '100',
    });
    expect(refusalOf(elsewhere)).toBe(
      "Asking for an advance needs the shop's bank account, which its customer pays it into",
    );
    expect(await f.level(f.b, shawl)).toMatchObject({ committed: 0 });
    // The law's Rs 200,000 cap is on what the door collects: what the advance leaves.
    const [lehnga] = (await f.variantsOf(f.a, 'Lehnga', { price: '250,000' })) as [string];
    await f.stock(f.a, lehnga, 2);
    const big = (advanceDue: string) =>
      f.orders.create(f.a, {
        lineItems: [{ variantId: lehnga, quantity: 1 }],
        shippingAddress: { name: 'Hina', phone: '0333-4445566', address1: 'House 9', city: 'lhr' },
        advanceDue,
      });
    expect(errorsOf(await big('40,000'))).toEqual([['input.advanceDue', 'COD_LIMIT']]);
    expect(unwrap(await big('50,000'))).toMatchObject({ codAmount: 200_000_00n });
  });

  it("tells the customer, on the order's page, what to pay ahead and what at the door", async () => {
    const order = await f.order(f.a, [kurta], { advanceDue: '500' });
    const link = unwrap(await f.links.createLink(f.a, order.id));
    expect(decodeURIComponent(link.whatsappUrl.split('?text=')[1]!)).toContain(
      `Pay the advance on your order #${order.number} from A by bank transfer:`,
    );
    const token = link.url.slice('https://hatti.test/o/'.length);
    const view = await f.links.viewLink(token);
    if (view.kind !== 'order') throw new Error(`Expected an order, got ${view.kind}`);
    expect(view.cancellable).toBe(true);
    const page = orderLinkPage(view).html;
    expect(page).toContain(
      `Your order #${order.number} is placed. Pay Rs 500 in advance by bank transfer, with ` +
        `#${order.number} as the reference: A sends your order once it is in.`,
    );
    expect(page).toContain('You pay Rs 1,500 when it arrives.');
    expect(page).toMatch(/Pay the advance by bank transfer<\/span>[\s\S]*Rs 500/);
    expect(page).toMatch(/Advance by bank transfer<\/span>[\s\S]*?-Rs 500/);
    expect(page).toMatch(/Pay on delivery<\/span>[\s\S]*?Rs 1,500/);
    // Its receipt is taken as a transfer's is.
    const sent = await f.links.sendReceipt(token, { data: Buffer.from('%PDF-1.7\n') });
    expect(sent.kind === 'order' && sent.problem).toBeNull();
    expect((await f.orders.home(f.a)).transfersToCheck.count).toBe(1);
    // Paid, it is the shop's to cancel, and the page no longer asks for it.
    unwrap(await f.orders.recordPayment(f.a, order.id));
    const after = await f.links.viewLink(token);
    if (after.kind !== 'order') throw new Error(`Expected an order, got ${after.kind}`);
    expect(after.cancellable).toBe(false);
    expect(orderLinkPage(after).html).not.toContain('in advance by bank transfer');
  });
});
