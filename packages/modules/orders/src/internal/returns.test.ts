import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrderRecord } from './records.js';
import { SalesReportService } from './sales-report.service.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('ReturnService', () => {
  let f: OrdersFixture;
  let chappal: string;
  let khussa: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [chappal] = (await f.variantsOf(f.a, 'Peshawari Chappal', { price: '3,499' })) as [string];
    [khussa] = (await f.variantsOf(f.a, 'Multani Khussa', { price: '2,250' })) as [string];
    await f.stock(f.a, chappal, 5);
    await f.stock(f.a, khussa, 5);
  });

  /** An order for 2 chappals and 1 khussa, confirmed; delivered unless told not to ship it. */
  async function anOrder(options: { deliver?: boolean } = {}): Promise<OrderRecord> {
    const placed = unwrap(
      await f.orders.create(f.a, {
        lineItems: [
          { variantId: chappal, quantity: 2 },
          { variantId: khussa, quantity: 1 },
        ],
        shippingAddress: ADDRESS,
      }),
    );
    const confirmed = unwrap(await f.orders.confirm(f.a, placed.id));
    if (options.deliver === false) return confirmed;
    const { fulfillmentId } = unwrap(
      await f.fulfillments.fulfill(f.a, placed.id, {
        tracking: { company: 'TCS', number: '1234567890' },
      }),
    );
    return unwrap(await f.fulfillments.markDelivered(f.a, fulfillmentId)).order;
  }

  const lineOf = (order: OrderRecord, variantId: string) =>
    order.lines.find((line) => line.variantId === variantId)!;

  it('records delivered items coming back, and checks them in: restocked or written off', async () => {
    const order = await anOrder();
    const shop = await f.primary(f.a);
    expect(await f.level(f.a, chappal)).toMatchObject({ onHand: 3 });
    const sales = new SalesReportService(f.db);
    const today = {
      placedFrom: new Date(Date.now() - 3_600_000),
      placedBefore: new Date(Date.now() + 3_600_000),
      interval: 'day' as const,
      topProducts: 1,
    };

    const { order: returning, return: back } = unwrap(
      await f.returns.create(f.a, {
        orderId: order.id,
        returnLineItems: [
          { lineItemId: lineOf(order, chappal).id, quantity: 1, reason: 'size_too_small' },
          { lineItemId: lineOf(order, khussa).id, quantity: 1, reason: 'defective' },
        ],
        trackingCompany: 'TCS',
        trackingNumber: 'RT 77',
        note: 'Wants size 9 instead',
      }),
    );
    expect(back).toMatchObject({
      number: 1,
      status: 'open',
      locationId: shop.id,
      trackingCompany: 'TCS',
      trackingNumber: 'RT 77',
      note: 'Wants size 9 instead',
      lines: [
        { lineId: lineOf(order, chappal).id, quantity: 1, reason: 'size_too_small' },
        { lineId: lineOf(order, khussa).id, quantity: 1, reason: 'defective' },
      ],
      actorKind: 'app',
      closedAt: null,
    });
    // The order stays delivered; nothing is back in stock until it arrives.
    expect(returning).toMatchObject({ stage: order.stage, version: order.version + 1 });
    expect(returning.returns).toEqual([back]);
    expect(await f.level(f.a, chappal)).toMatchObject({ onHand: 3 });
    const [recorded] = (await f.orders.timeline(f.a, order.id, { first: 1 })).items;
    expect(recorded).toMatchObject({
      kind: 'return',
      message:
        `Return #${order.number}-R1 recorded: 1 × Peshawari Chappal, too small; ` +
        `1 × Multani Khussa, faulty; coming back by TCS RT 77 to ${shop.name}`,
    });
    // Its items are the order's returns in the sales report from now, on the day it was placed.
    expect(unwrap(await sales.report(f.a, today)).totals.returns).toBe(5_749_00n);

    // The chappal goes back on the shelf; the faulty khussa is written off.
    const { return: checked } = unwrap(
      await f.returns.receive(f.a, back.id, [
        { lineItemId: lineOf(order, chappal).id, quantity: 1 },
      ]),
    );
    expect(checked).toMatchObject({
      status: 'closed',
      lines: [{ restockedQuantity: 1 }, { restockedQuantity: 0 }],
    });
    expect(checked.closedAt).toBeInstanceOf(Date);
    expect(await f.level(f.a, chappal)).toMatchObject({ onHand: 4, available: 4 });
    expect(await f.level(f.a, khussa)).toMatchObject({ onHand: 4 });
    const [received] = (await f.orders.timeline(f.a, order.id, { first: 1 })).items;
    expect(received).toMatchObject({
      kind: 'return',
      message: `Return #${order.number}-R1 checked in: 1 item back in stock, 1 item written off`,
    });
    const events = (await f.outbox()).filter((event) => event.event_type.startsWith('return.'));
    expect(events.map((event) => [event.event_type, event.aggregate_id, event.payload])).toEqual([
      ['return.created', back.id, expect.objectContaining({ orderId: order.id, status: 'open' })],
      ['return.closed', back.id, expect.objectContaining({ number: 1, status: 'closed' })],
    ]);
    expect(errorsOf(await f.returns.receive(f.a, back.id))).toEqual([['id', 'INVALID']]);

    // The other chappal may come back too, as the order's second return; the khussa may not.
    const second = unwrap(
      await f.returns.create(f.a, {
        orderId: order.id,
        returnLineItems: [
          { lineItemId: lineOf(order, chappal).id, quantity: 1, reason: 'unwanted' },
        ],
      }),
    );
    expect(second.return).toMatchObject({ number: 2 });
    const again = await f.returns.create(f.a, {
      orderId: order.id,
      returnLineItems: [{ lineItemId: lineOf(order, khussa).id, quantity: 1, reason: 'unwanted' }],
    });
    expect(!again.ok && again.errors[0]).toEqual({
      field: ['input', 'returnLineItems', '0', 'quantity'],
      code: 'INVALID',
      message: 'No "Multani Khussa" was delivered that is not coming back already',
    });
  });

  it('cancels a return still on its way, its items free to come back again', async () => {
    const order = await anOrder();
    const line = lineOf(order, chappal);
    const back = unwrap(
      await f.returns.create(f.a, {
        orderId: order.id,
        returnLineItems: [{ lineItemId: line.id, quantity: 2, reason: 'unwanted' }],
      }),
    ).return;
    const more = await f.returns.create(f.a, {
      orderId: order.id,
      returnLineItems: [{ lineItemId: line.id, quantity: 1, reason: 'unwanted' }],
    });
    expect(!more.ok && more.errors[0]!.message).toBe(
      'No "Peshawari Chappal" was delivered that is not coming back already',
    );

    const { return: cancelled } = unwrap(await f.returns.cancel(f.a, back.id));
    expect(cancelled).toMatchObject({ status: 'cancelled', closedAt: null });
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);
    const [entry] = (await f.orders.timeline(f.a, order.id, { first: 1 })).items;
    expect(entry).toMatchObject({
      message: `Return #${order.number}-R1 cancelled: nothing is coming back`,
    });
    expect(errorsOf(await f.returns.cancel(f.a, back.id))).toEqual([['id', 'INVALID']]);
    expect(errorsOf(await f.returns.receive(f.a, back.id))).toEqual([['id', 'INVALID']]);
    unwrap(
      await f.returns.create(f.a, {
        orderId: order.id,
        returnLineItems: [{ lineItemId: line.id, quantity: 2, reason: 'size_too_large' }],
        note: 'Ayesha will drop it at the shop',
      }),
    );
    // A return's note may name its customer: erased with their details, once the cash for the
    // order is in; what came back stays.
    unwrap(await f.orders.markAsPaid(f.a, order.id));
    unwrap(await f.customerData.erase(f.a, order.customerId));
    const erased = (await f.orders.get(f.a, order.id))!;
    expect(erased.returns.map((each) => [each.status, each.note, each.lines.length])).toEqual([
      ['cancelled', '', 1],
      ['open', '', 1],
    ]);
  });

  it('takes back only what was delivered, to a location of the shop', async () => {
    const shipped = await anOrder({ deliver: false });
    const create = (
      orderId: string,
      lineItems: { lineItemId: string; quantity: number }[],
      extra: { locationId?: string } = {},
      tenant = f.a,
    ) =>
      f.returns.create(tenant, {
        orderId,
        returnLineItems: lineItems.map((line) => ({ ...line, reason: 'other' as const })),
        ...extra,
      });
    const chappalLine = lineOf(shipped, chappal);
    // Not shipped: nothing to send back.
    expect(
      errorsOf(await create(shipped.id, [{ lineItemId: chappalLine.id, quantity: 1 }])),
    ).toEqual([['input.returnLineItems.0.quantity', 'INVALID']]);
    // Refused at the door: it comes back as the parcel it is.
    const { fulfillmentId } = unwrap(await f.fulfillments.fulfill(f.a, shipped.id, {}));
    unwrap(await f.fulfillments.markReturning(f.a, fulfillmentId));
    expect(
      errorsOf(await create(shipped.id, [{ lineItemId: chappalLine.id, quantity: 1 }])),
    ).toEqual([['input.returnLineItems.0.quantity', 'INVALID']]);

    const order = await anOrder();
    const line = lineOf(order, chappal);
    expect(errorsOf(await create(order.id, []))).toEqual([['input.returnLineItems', 'BLANK']]);
    expect(
      errorsOf(
        await create(order.id, [
          { lineItemId: line.id, quantity: 1 },
          { lineItemId: line.id, quantity: 1 },
        ]),
      ),
    ).toEqual([['input.returnLineItems.1.lineItemId', 'INVALID']]);
    expect(errorsOf(await create(order.id, [{ lineItemId: line.id, quantity: 0 }]))).toEqual([
      ['input.returnLineItems.0.quantity', 'INVALID'],
    ]);
    expect(errorsOf(await create(order.id, [{ lineItemId: newId(), quantity: 1 }]))).toEqual([
      ['input.returnLineItems.0.lineItemId', 'NOT_FOUND'],
    ]);
    const more = await create(order.id, [{ lineItemId: line.id, quantity: 3 }]);
    expect(!more.ok && more.errors[0]!.message).toBe(
      'Only 2 of "Peshawari Chappal" delivered can come back',
    );
    expect(
      errorsOf(
        await create(order.id, [{ lineItemId: line.id, quantity: 1 }], { locationId: newId() }),
      ),
    ).toEqual([['input.locationId', 'NOT_FOUND']]);
    expect(errorsOf(await create(newId(), [{ lineItemId: line.id, quantity: 1 }]))).toEqual([
      ['input.orderId', 'NOT_FOUND'],
    ]);
    // Another shop's order, and its returns, are not this one's.
    expect(
      errorsOf(await create(order.id, [{ lineItemId: line.id, quantity: 1 }], {}, f.b)),
    ).toEqual([['input.orderId', 'NOT_FOUND']]);
    const back = unwrap(await create(order.id, [{ lineItemId: line.id, quantity: 2 }])).return;
    expect(errorsOf(await f.returns.receive(f.b, back.id))).toEqual([['id', 'NOT_FOUND']]);
    expect(errorsOf(await f.returns.cancel(f.b, back.id))).toEqual([['id', 'NOT_FOUND']]);
    expect(
      errorsOf(await f.returns.receive(f.a, back.id, [{ lineItemId: newId(), quantity: 1 }])),
    ).toEqual([['restock.0.lineItemId', 'NOT_FOUND']]);
    expect(
      errorsOf(await f.returns.receive(f.a, back.id, [{ lineItemId: line.id, quantity: 3 }])),
    ).toEqual([['restock.0.quantity', 'INVALID']]);
    // Restocked whole when nothing is said: both chappals back where they came from, beside the
    // one left after the refused parcel's two, which are still on their way.
    expect(await f.level(f.a, chappal)).toMatchObject({ onHand: 1 });
    unwrap(await f.returns.receive(f.a, back.id));
    expect(await f.level(f.a, chappal)).toMatchObject({ onHand: 3 });
  });
});
