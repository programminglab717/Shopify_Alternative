import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { listAudit } from '@hatti/events';
import { toPublicId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Refunds', () => {
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
    await f.admin.query('DELETE FROM platform.audit_log');
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 20);
  });

  const timeline = async (orderId: string) =>
    (await f.orders.timeline(f.a, orderId, { first: 1 })).items.map((entry) => [
      entry.kind,
      entry.message,
    ]);

  it('records refunds up to what was paid, and the financial status follows', async () => {
    // Paid in advance: Rs 2,000 and Rs 250 for delivery.
    const order = await f.order(f.a, [kurta], { paymentMethod: 'prepaid', shippingPrice: '250' });
    await f.admin.query('DELETE FROM platform.outbox_events');

    const first = unwrap(
      await f.refunds.refund(f.a, order.id, {
        amount: '500',
        method: 'bank_transfer',
        reference: ' IBFT-778812 ',
        note: 'Stitching came apart',
      }),
    );
    expect(first.order).toMatchObject({
      financialStatus: 'partially_refunded',
      amountPaid: 225_000n,
      amountRefunded: 50_000n,
      stage: 'to_pack',
      version: order.version + 1,
    });
    expect(first.refund).toMatchObject({
      amount: 50_000n,
      method: 'bank_transfer',
      reference: 'IBFT-778812',
      note: 'Stitching came apart',
      actorKind: 'app',
    });
    expect(first.order.refunds).toEqual([first.refund]);
    expect(await timeline(order.id)).toEqual([['refunded', 'Refunded Rs 500 by bank transfer']]);
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      [
        'order.refunded',
        {
          refundId: first.refund.id,
          amount: '50000',
          amountRefunded: '50000',
          tax: '0',
          method: 'bank_transfer',
          stage: 'to_pack',
          version: first.order.version,
        },
      ],
    ]);
    const audit = await f.db.tenant(f.a.shopId, (tx) => listAudit(tx, f.a.shopId, { first: 5 }));
    expect(audit.items.map((item) => [item.action, item.subjectId, item.details])).toEqual([
      [
        'order.refunded',
        order.id,
        {
          number: order.number,
          refundId: toPublicId('refund', first.refund.id),
          amount: '500.00',
          tax: '0.00',
          method: 'BANK_TRANSFER',
        },
      ],
    ]);

    // Never more than what is left of what was paid.
    expect(
      await f.refunds.refund(f.a, order.id, { amount: '1,800', method: 'mobile_wallet' }),
    ).toEqual({
      ok: false,
      errors: [
        {
          field: ['input', 'amount'],
          code: 'INVALID',
          message: 'A refund can be at most Rs 1,750: what was paid and not refunded yet',
        },
      ],
    });
    const rest = unwrap(
      await f.refunds.refund(f.a, order.id, { amount: '1750', method: 'mobile_wallet' }),
    );
    expect(rest.order).toMatchObject({ financialStatus: 'refunded', amountRefunded: 225_000n });
    expect(rest.order.refunds.map((refund) => refund.method)).toEqual([
      'bank_transfer',
      'mobile_wallet',
    ]);
    expect(await timeline(order.id)).toEqual([
      ['refunded', 'Refunded Rs 1,750 to a mobile wallet'],
    ]);
    expect(await f.refunds.refund(f.a, order.id, { amount: '1', method: 'cash' })).toMatchObject({
      ok: false,
      errors: [{ field: ['id'], message: 'Nothing paid on this order is left to refund' }],
    });

    // Nothing has been paid on a cash-on-delivery order before it is delivered.
    const cod = await f.order(f.a, [kurta]);
    expect(
      errorsOf(await f.refunds.refund(f.a, cod.id, { amount: '100', method: 'cash' })),
    ).toEqual([['id', 'INVALID']]);
    expect(
      errorsOf(await f.refunds.refund(f.b, order.id, { amount: '1', method: 'cash' })),
    ).toEqual([['id', 'NOT_FOUND']]);
  });

  it('checks what it is asked to record', async () => {
    const order = await f.order(f.a, [kurta], { paymentMethod: 'prepaid' });
    const refund = (amount: string, extra: { reference?: string; note?: string } = {}) =>
      f.refunds.refund(f.a, order.id, { amount, method: 'other', ...extra });
    expect(errorsOf(await refund(''))).toEqual([['input.amount', 'BLANK']]);
    expect(errorsOf(await refund('0'))).toEqual([['input.amount', 'INVALID']]);
    expect(errorsOf(await refund('two hundred'))).toEqual([['input.amount', 'INVALID']]);
    expect(errorsOf(await refund('-5'))).toEqual([['input.amount', 'INVALID']]);
    expect(errorsOf(await refund('10', { reference: 'x'.repeat(101) }))).toEqual([
      ['input.reference', 'TOO_LONG'],
    ]);
    expect(errorsOf(await refund('10', { note: 'x'.repeat(5001) }))).toEqual([
      ['input.note', 'TOO_LONG'],
    ]);
    // Back through a payment gateway, without the payments module: nothing gives it back.
    const online = await f.refunds.refund(f.a, order.id, { amount: '10', method: 'online' });
    expect(online.ok ? null : online.errors).toEqual([
      { field: ['input', 'method'], code: 'INVALID', message: 'The shop takes no payments online' },
    ]);
    expect((await f.orders.get(f.a, order.id))!).toMatchObject({
      financialStatus: 'paid',
      amountRefunded: 0n,
      refunds: [],
    });
  });

  it('keeps completed orders completed, and counts spending net of refunds', async () => {
    const order = await f.order(f.a, [kurta], { shippingPrice: '250', advancePaid: '250' });
    // The advance goes back while the order is still open: the delivery charge is waived.
    const waived = unwrap(
      await f.refunds.refund(f.a, order.id, { amount: '250', method: 'mobile_wallet' }),
    );
    expect(waived.order).toMatchObject({
      financialStatus: 'refunded',
      stage: 'needs_confirmation',
    });

    unwrap(await f.orders.confirm(f.a, order.id));
    const parcel = unwrap(await f.fulfillments.fulfill(f.a, order.id, {}));
    unwrap(await f.fulfillments.markDelivered(f.a, parcel.fulfillmentId));
    // Cash collected at the door: paid in full, less the advance given back.
    const paid = unwrap(await f.orders.markAsPaid(f.a, order.id));
    expect(paid).toMatchObject({
      stage: 'completed',
      status: 'closed',
      financialStatus: 'partially_refunded',
      amountPaid: 225_000n,
      amountRefunded: 25_000n,
    });
    // Paying again changes nothing.
    expect(unwrap(await f.orders.markAsPaid(f.a, order.id)).version).toBe(paid.version);

    // A closed order still takes refunds, and stays completed.
    const damaged = unwrap(
      await f.refunds.refund(f.a, order.id, { amount: '300', method: 'cash', note: 'Torn sleeve' }),
    );
    expect(damaged.order).toMatchObject({
      stage: 'completed',
      status: 'closed',
      financialStatus: 'partially_refunded',
      amountRefunded: 55_000n,
    });
    const stats = await f.orders.customerStats(f.a, [order.customerId]);
    expect(stats.get(order.customerId)!.amountSpent).toBe(225_000n - 55_000n);
  });

  it("clears refunds' notes and references when the customer's data is erased", async () => {
    const order = await f.order(f.a, [kurta], { paymentMethod: 'prepaid' });
    unwrap(
      await f.refunds.refund(f.a, order.id, {
        amount: '2000',
        method: 'mobile_wallet',
        reference: 'JC-0300-1234567',
        note: "Sent to Ayesha's JazzCash, 0300 1234567",
      }),
    );
    unwrap(await f.orders.cancel(f.a, order.id, { reason: 'inventory' }));
    unwrap(await f.customerData.erase(f.a, order.customerId));
    const erased = (await f.orders.get(f.a, order.id))!;
    expect(erased.refunds).toMatchObject([
      { amount: 200_000n, method: 'mobile_wallet', reference: null, note: '' },
    ]);
    expect(erased).toMatchObject({ financialStatus: 'refunded', amountRefunded: 200_000n });
  });
});
