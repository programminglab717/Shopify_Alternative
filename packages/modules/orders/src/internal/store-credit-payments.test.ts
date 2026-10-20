import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { toPublicId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

const HOUR = 3_600_000;
const rupees = (amount: string, expiresAt?: Date) => ({
  amount,
  currencyCode: 'PKR',
  ...(expiresAt ? { expiresAt } : {}),
});

const ACCOUNT = {
  title: 'Zari Textiles',
  bankName: 'Standard Chartered',
  iban: 'PK36SCBL0000001123456702',
};

describe.skipIf(!server)('Orders paid with store credit (ORD-09, ADR-185)', () => {
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
  });

  const latest = async (orderId: string, first = 1) =>
    (await f.orders.timeline(f.a, orderId, { first })).items.map((entry) => entry.message);

  /** A customer's account's ledger, the newest first: kind, event, signed amount, order. */
  async function ledger(customerId: string) {
    const [account] = await f.storeCredit.accountsOf(f.a, customerId);
    const page = await f.storeCredit.transactions(f.a, account!.id, { first: 20 });
    return {
      balance: account!.balance,
      entries: page.items.map((item) => [item.kind, item.event, item.amount, item.orderId]),
    };
  }

  it('pays a cash-on-delivery order with store credit, the cash at the door dropping by it', async () => {
    const order = await f.order(f.a, [kurta], { shippingPrice: '250' });
    expect(order).toMatchObject({ total: 2_250_00n, codAmount: 2_250_00n, amountPaid: 0n });
    const owner = { customerId: order.customerId };
    unwrap(await f.storeCredit.credit(f.a, owner, rupees('1500', new Date(Date.now() + HOUR))));
    unwrap(await f.storeCredit.credit(f.a, owner, rupees('300')));

    // Nothing, or more than it owes, is refused.
    expect(errorsOf(await f.orders.payWithStoreCredit(f.a, order.id, { amount: '0' }))).toEqual([
      ['amount', 'INVALID'],
    ]);
    expect(await f.orders.payWithStoreCredit(f.a, order.id, { amount: '2,250.01' })).toMatchObject({
      ok: false,
      errors: [{ field: ['amount'], message: 'Give an amount up to the Rs 2,250 it owes' }],
    });

    const part = unwrap(await f.orders.payWithStoreCredit(f.a, order.id, { amount: '1,000' }));
    expect(part).toMatchObject({
      amountPaid: 1_000_00n,
      codAmount: 1_250_00n,
      financialStatus: 'partially_paid',
      stage: order.stage,
    });
    expect(await latest(order.id)).toEqual([
      'Paid Rs 1,000 with store credit: Rs 1,250 is left to collect at the door',
    ]);
    // The rest of the credit, as much as it covers: Rs 500 left of what expires, then Rs 300.
    const rest = unwrap(await f.orders.payWithStoreCredit(f.a, order.id));
    expect(rest).toMatchObject({ amountPaid: 1_800_00n, codAmount: 450_00n });
    expect(await ledger(order.customerId)).toEqual({
      balance: 0n,
      entries: [
        ['debit', 'order_payment', -800_00n, order.id],
        ['debit', 'order_payment', -1_000_00n, order.id],
        ['credit', 'adjustment', 300_00n, null],
        ['credit', 'adjustment', 1_500_00n, null],
      ],
    });
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'order.paid')
        .map((event) => event.payload.amountPaid),
    ).toEqual(['100000', '180000']);
    expect(await f.orders.payWithStoreCredit(f.a, order.id)).toEqual({
      ok: false,
      errors: [
        {
          field: ['amount'],
          code: 'INSUFFICIENT_FUNDS',
          message: 'This customer has no store credit',
        },
      ],
    });
  });

  it('pays an advance still owed first, then the cash at the door; in full, nothing is left', async () => {
    unwrap(await f.bankTransfer.update(f.a, { enabled: true, account: ACCOUNT }));
    const order = await f.order(f.a, [kurta], { shippingPrice: '250', advanceDue: '500' });
    expect(order).toMatchObject({ stage: 'awaiting_payment', codAmount: 1_750_00n });
    unwrap(await f.storeCredit.credit(f.a, { customerId: order.customerId }, rupees('5000')));

    // Rs 700: Rs 500 is the advance, and Rs 200 comes off the cash at the door.
    const advanced = unwrap(await f.orders.payWithStoreCredit(f.a, order.id, { amount: '700' }));
    expect(advanced).toMatchObject({ amountPaid: 700_00n, codAmount: 1_550_00n, stage: 'to_pack' });
    const full = unwrap(await f.orders.payWithStoreCredit(f.a, order.id));
    expect(full).toMatchObject({
      amountPaid: 2_250_00n,
      codAmount: 0n,
      financialStatus: 'paid',
      paidAt: expect.any(Date),
    });
    expect(await latest(order.id)).toEqual(['Paid Rs 1,550 with store credit, paying it in full']);
    expect(await f.orders.payWithStoreCredit(f.a, order.id)).toMatchObject({
      ok: false,
      errors: [{ field: ['id'], message: 'The order is paid in full' }],
    });
  });

  it('gives the credit back to the credits it came from when the order is cancelled', async () => {
    const order = await f.order(f.a, [kurta]);
    const owner = { customerId: order.customerId };
    // Its credit expires an hour ago; it paid two hours ago, while it had not.
    const paidAt = new Date(Date.now() - 2 * HOUR);
    unwrap(
      await f.storeCredit.credit(f.a, owner, rupees('600', new Date(Date.now() - HOUR)), paidAt),
    );
    unwrap(await f.storeCredit.credit(f.a, owner, rupees('1000'), paidAt));
    unwrap(await f.orders.payWithStoreCredit(f.a, order.id, { amount: '1,200' }, paidAt));

    const cancelled = unwrap(await f.orders.cancel(f.a, order.id, { reason: 'customer' }));
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      amountPaid: 0n,
      financialStatus: 'voided',
    });
    expect(await latest(order.id, 2)).toEqual([
      'Gave Rs 1,200 of store credit, which paid it, back to its customer',
      'Cancelled because the customer cancelled',
    ]);
    // The Rs 600 went back to the credit that expired since, which ends again; the Rs 600 from
    // the other is the customer's again.
    const { balance, entries } = await ledger(order.customerId);
    expect(balance).toBe(1_000_00n);
    expect(entries).toEqual([
      ['expiration', null, -600_00n, null],
      ['debit_revert', 'order_cancellation', 1_200_00n, order.id],
      ['debit', 'order_payment', -1_200_00n, order.id],
      ['credit', 'adjustment', 1_000_00n, null],
      ['credit', 'adjustment', 600_00n, null],
    ]);
    // Cancelled again, nothing more is given back.
    unwrap(await f.orders.cancel(f.a, order.id, { reason: 'customer' }));
    expect((await ledger(order.customerId)).entries).toHaveLength(5);
  });

  it('refunds as store credit what the credit paid first, each part expiring as its credit did (ADR-661)', async () => {
    const order = await f.order(f.a, [kurta], { shippingPrice: '250' });
    const owner = { customerId: order.customerId };
    const soon = new Date(Date.now() + 2 * HOUR);
    const later = new Date(Date.now() + 90 * 24 * HOUR);
    // One that expires soon, which pays first; one that never does.
    unwrap(await f.storeCredit.credit(f.a, owner, rupees('1500', soon)));
    unwrap(await f.storeCredit.credit(f.a, owner, rupees('300')));
    unwrap(await f.orders.payWithStoreCredit(f.a, order.id, { amount: '1,800' }));
    const [account] = await f.storeCredit.accountsOf(f.a, order.customerId);
    /** The refunds' credits, the oldest first: amount, expiry, and which credit it restores. */
    const refunded = async () =>
      (
        await f.admin.query<{ amount: string; expires_at: Date | null; restores: string | null }>(
          `SELECT r.amount::text, r.expires_at, s.amount::text AS restores
             FROM customers.store_credit_transactions r
             LEFT JOIN customers.store_credit_transactions s ON s.id = r.source_id
            WHERE r.account_id = $1 AND r.event = 'order_refund'
            ORDER BY r.created_at, r.id`,
          [account!.id],
        )
      ).rows.map((row) => [row.amount, row.expires_at?.getTime() ?? null, row.restores]);

    // The one that never expires was spent last: it comes back first.
    const first = unwrap(
      await f.refunds.refund(f.a, order.id, {
        amount: '500',
        method: 'store_credit',
        storeCreditExpiresAt: later,
      }),
    );
    expect(await refunded()).toEqual([
      ['30000', null, '30000'],
      ['20000', soon.getTime(), '150000'],
    ]);
    // Named to the refund by the first of them.
    const page = await f.storeCredit.transactions(f.a, account!.id, { first: 10 });
    const named = page.items.find(
      (item) => toPublicId('storeCreditTransaction', item.id) === first.refund.reference,
    );
    expect(named).toMatchObject({ kind: 'credit', amount: 30_000n, refundId: first.refund.id });
    // Then what is left of the one expiring soon, and past what the credit paid, the refund's own.
    unwrap(
      await f.refunds.refund(f.a, order.id, {
        amount: '1,300',
        method: 'store_credit',
        storeCreditExpiresAt: later,
      }),
    );
    expect((await refunded()).slice(2)).toEqual([['130000', soon.getTime(), '150000']]);
    expect((await ledger(order.customerId)).balance).toBe(1_800_00n);
    // Told once a refund, of all of it.
    const { rows: told } = await f.admin.query<{ amount: string }>(
      `SELECT payload ->> 'amount' AS amount FROM platform.outbox_events
        WHERE event_type = 'store_credit.credited' AND payload ->> 'event' = 'order_refund'
        ORDER BY id`,
    );
    expect(told.map((row) => row.amount)).toEqual(['50000', '130000']);
  });

  it("refunds the rest as the shop says once the credit's part is given back, and none from an expired credit (ADR-661)", async () => {
    const order = await f.order(f.a, [kurta]);
    const owner = { customerId: order.customerId };
    const paidAt = new Date(Date.now() - 2 * HOUR);
    const later = new Date(Date.now() + 90 * 24 * HOUR);
    // Expired since it paid: what came from it comes back as the refund's own.
    unwrap(
      await f.storeCredit.credit(f.a, owner, rupees('400', new Date(Date.now() - HOUR)), paidAt),
    );
    unwrap(await f.orders.payWithStoreCredit(f.a, order.id, { amount: '400' }, paidAt));
    unwrap(await f.orders.recordPayment(f.a, order.id, { amount: '1,600' }));
    unwrap(
      await f.refunds.refund(f.a, order.id, {
        amount: '700',
        method: 'store_credit',
        storeCreditExpiresAt: later,
      }),
    );
    const [account] = await f.storeCredit.accountsOf(f.a, order.customerId);
    const { rows } = await f.admin.query<{ amount: string; expires_at: Date; source_id: null }>(
      `SELECT amount::text, expires_at, source_id FROM customers.store_credit_transactions
        WHERE account_id = $1 AND event = 'order_refund'`,
      [account!.id],
    );
    expect(rows).toEqual([{ amount: '70000', expires_at: later, source_id: null }]);
  });

  it('gives the credit back with a parcel that came back, where the shop says so (ADR-610)', async () => {
    /** An order paid Rs 1,000 in store credit, shipped and refused: its parcel back with the shop. */
    async function refusedWithCredit() {
      const order = await f.order(f.a, [kurta]);
      unwrap(await f.storeCredit.credit(f.a, { customerId: order.customerId }, rupees('1000')));
      unwrap(await f.orders.payWithStoreCredit(f.a, order.id, { amount: '1,000' }));
      unwrap(await f.orders.confirm(f.a, order.id));
      const { fulfillmentId } = unwrap(await f.fulfillments.fulfill(f.a, order.id, {}));
      unwrap(await f.fulfillments.markReturning(f.a, fulfillmentId));
      const back = unwrap(await f.fulfillments.receiveReturn(f.a, fulfillmentId));
      return { order, back: back.order };
    }

    // By default the credit stays spent, as an advance does.
    const kept = await refusedWithCredit();
    expect(kept.back).toMatchObject({ stage: 'returned', amountPaid: 1_000_00n });
    expect((await ledger(kept.order.customerId)).balance).toBe(0n);
    expect((await latest(kept.order.id))[0]).toMatch(/^Parcel checked back in/);

    expect(unwrap(await f.orderSettings.update(f.a, { creditBackOnReturn: true }))).toMatchObject({
      creditBackOnReturn: true,
    });
    const given = await refusedWithCredit();
    expect(given.back).toMatchObject({
      stage: 'returned',
      amountPaid: 0n,
      financialStatus: 'voided',
    });
    expect(await latest(given.order.id, 2)).toEqual([
      'Gave Rs 1,000 of store credit, which paid it, back to its customer, as its parcel came back',
      'Parcel checked back in: 1 item back in stock',
    ]);
    const { balance, entries } = await ledger(given.order.customerId);
    expect(balance).toBe(1_000_00n);
    expect(entries[0]).toEqual(['debit_revert', 'order_cancellation', 1_000_00n, given.order.id]);
  });

  it('leaves to staff credit refunds took the place of, and takes none on a closed order', async () => {
    const order = await f.order(f.a, [kurta]);
    unwrap(await f.storeCredit.credit(f.a, { customerId: order.customerId }, rupees('1000')));
    unwrap(await f.orders.payWithStoreCredit(f.a, order.id, { amount: '1,000' }));
    unwrap(await f.orders.recordPayment(f.a, order.id, { amount: '500' }));
    unwrap(await f.refunds.refund(f.a, order.id, { amount: '1,200', method: 'cash' }));

    const cancelled = unwrap(await f.orders.cancel(f.a, order.id, { reason: 'inventory' }));
    // Only Rs 300 of what was paid is left unrefunded: the credit stays spent.
    expect(cancelled).toMatchObject({
      amountPaid: 1_500_00n,
      amountRefunded: 1_200_00n,
      financialStatus: 'partially_refunded',
    });
    expect(await latest(order.id)).toEqual([
      'Rs 1,000 of store credit paid it, more than refunds left of what was paid: give back ' +
        'what is owed as a refund',
    ]);
    expect((await ledger(order.customerId)).balance).toBe(0n);
    expect(await f.orders.payWithStoreCredit(f.a, order.id)).toMatchObject({
      ok: false,
      errors: [{ field: ['id'], message: "A cancelled order can't be paid" }],
    });
  });
});
