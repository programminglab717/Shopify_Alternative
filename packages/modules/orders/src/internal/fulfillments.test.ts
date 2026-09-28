import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrderRecord } from './records.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('FulfillmentService', () => {
  let f: OrdersFixture;
  let chappal: string;
  let khussa: string;

  /** A confirmed order for 2 chappals and 1 khussa, with 5 of each in stock. */
  async function confirmedOrder(extra: Record<string, unknown> = {}): Promise<OrderRecord> {
    const order = unwrap(
      await f.orders.create(f.a, {
        lineItems: [
          { variantId: chappal, quantity: 2 },
          { variantId: khussa, quantity: 1 },
        ],
        shippingAddress: ADDRESS,
        ...extra,
      }),
    );
    return order.confirmationStatus === 'pending'
      ? unwrap(await f.orders.confirm(f.a, order.id))
      : order;
  }

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

  it('ships an order in one parcel: the stock leaves, the order is in transit', async () => {
    const order = await confirmedOrder();
    await f.admin.query('DELETE FROM platform.outbox_events');
    const { order: shipped, fulfillmentId } = unwrap(
      await f.fulfillments.fulfill(f.a, order.id, {
        tracking: { company: 'TCS', number: '1234567890', url: 'https://www.tcsexpress.com/track' },
      }),
    );
    expect(shipped).toMatchObject({
      stage: 'in_transit',
      fulfillmentStatus: 'fulfilled',
      status: 'open',
      version: 3,
    });
    expect(shipped.lines.map((line) => line.fulfilledQuantity)).toEqual([2, 1]);
    expect(shipped.fulfillments).toMatchObject([
      {
        id: fulfillmentId,
        status: 'in_transit',
        locationId: order.locationId,
        trackingCompany: 'TCS',
        trackingNumber: '1234567890',
        trackingUrl: 'https://www.tcsexpress.com/track',
        lines: [
          { lineId: order.lines[0]!.id, quantity: 2, restockedQuantity: null },
          { lineId: order.lines[1]!.id, quantity: 1, restockedQuantity: null },
        ],
        deliveredAt: null,
      },
    ]);
    expect(await f.level(f.a, chappal)).toMatchObject({ onHand: 3, committed: 0, available: 3 });
    expect(await f.level(f.a, khussa)).toMatchObject({ onHand: 4, committed: 0, available: 4 });

    const timeline = await f.orders.timeline(f.a, order.id, { first: 1 });
    expect(timeline.items[0]).toMatchObject({
      kind: 'fulfilled',
      message: 'Shipped 3 items with TCS 1234567890',
    });
    expect(
      (await f.outbox()).find((event) => event.event_type === 'fulfillment.created'),
    ).toMatchObject({
      aggregate_id: fulfillmentId,
      payload: {
        orderId: order.id,
        status: 'in_transit',
        trackingCompany: 'TCS',
        trackingNumber: '1234567890',
        orderStage: 'in_transit',
        orderVersion: 3,
      },
    });
    // Staff find the order by the parcel's tracking number.
    const found = await f.orders.list(f.a, { first: 5, query: '1234567890' });
    expect(found.items.map((item) => item.id)).toEqual([order.id]);
  });

  it('ships only confirmed or prepaid orders, and only what is left to ship', async () => {
    const pending = unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId: chappal, quantity: 1 }],
        shippingAddress: ADDRESS,
      }),
    );
    expect(errorsOf(await f.fulfillments.fulfill(f.a, pending.id, {}))).toEqual([
      ['id', 'INVALID'],
    ]);

    const order = await confirmedOrder({ paymentMethod: 'prepaid' });
    const [chappals, khussas] = order.lines as [OrderRecord['lines'][0], OrderRecord['lines'][0]];
    const first = unwrap(
      await f.fulfillments.fulfill(f.a, order.id, {
        lineItems: [{ id: chappals.id, quantity: 1 }],
      }),
    );
    expect(first.order).toMatchObject({
      stage: 'partially_fulfilled',
      fulfillmentStatus: 'partially_fulfilled',
    });
    expect(
      errorsOf(
        await f.fulfillments.fulfill(f.a, order.id, {
          lineItems: [
            { id: chappals.id, quantity: 2 },
            { id: newId(), quantity: 1 },
          ],
        }),
      ),
    ).toEqual([
      ['input.lineItems.0.quantity', 'INVALID'],
      ['input.lineItems.1.id', 'NOT_FOUND'],
    ]);
    // Everything left: 1 chappal and the khussa.
    const rest = unwrap(await f.fulfillments.fulfill(f.a, order.id, {}));
    expect(rest.order).toMatchObject({ stage: 'in_transit', fulfillmentStatus: 'fulfilled' });
    expect(rest.order.fulfillments.map((parcel) => parcel.lines)).toEqual([
      [{ lineId: chappals.id, quantity: 1, restockedQuantity: null }],
      [
        { lineId: chappals.id, quantity: 1, restockedQuantity: null },
        { lineId: khussas.id, quantity: 1, restockedQuantity: null },
      ],
    ]);
    expect(errorsOf(await f.fulfillments.fulfill(f.a, order.id, {}))).toEqual([['id', 'INVALID']]);
    expect(errorsOf(await f.orders.cancel(f.a, order.id, { reason: 'customer' }))).toEqual([
      ['id', 'INVALID'],
    ]);
    expect(
      errorsOf(
        await f.fulfillments.fulfill(f.a, order.id, {
          tracking: { url: 'http://tcs.example.com' },
        }),
      ),
    ).toEqual([['input.trackingInfo.url', 'INVALID']]);
  });

  it('closes an order once it is delivered and paid', async () => {
    const cod = await confirmedOrder();
    const { fulfillmentId } = unwrap(await f.fulfillments.fulfill(f.a, cod.id, {}));
    const delivered = unwrap(await f.fulfillments.markDelivered(f.a, fulfillmentId));
    expect(delivered.order).toMatchObject({ stage: 'delivered', status: 'open' });
    expect(delivered.order.fulfillments[0]!.deliveredAt).toBeInstanceOf(Date);
    // Delivered twice is still delivered.
    expect(unwrap(await f.fulfillments.markDelivered(f.a, fulfillmentId)).order.version).toBe(
      delivered.order.version,
    );
    const paid = unwrap(await f.orders.markAsPaid(f.a, cod.id));
    expect(paid).toMatchObject({ stage: 'completed', status: 'closed', financialStatus: 'paid' });
    expect(paid.closedAt).toBeInstanceOf(Date);

    const prepaid = await confirmedOrder({ paymentMethod: 'prepaid' });
    const parcel = unwrap(await f.fulfillments.fulfill(f.a, prepaid.id, {}));
    const done = unwrap(await f.fulfillments.markDelivered(f.a, parcel.fulfillmentId));
    expect(done.order).toMatchObject({ stage: 'completed', status: 'closed' });
    expect(errorsOf(await f.fulfillments.markReturning(f.a, parcel.fulfillmentId))).toEqual([
      ['id', 'INVALID'],
    ]);
  });

  it('checks a refused parcel back in: restocked or written off, and the order voided', async () => {
    const order = await confirmedOrder();
    const { fulfillmentId } = unwrap(await f.fulfillments.fulfill(f.a, order.id, {}));
    const returning = unwrap(await f.fulfillments.markReturning(f.a, fulfillmentId));
    expect(returning.order).toMatchObject({ stage: 'returning', status: 'open' });

    const [chappals] = order.lines;
    const back = unwrap(
      await f.fulfillments.receiveReturn(f.a, fulfillmentId, [
        { lineItemId: chappals!.id, quantity: 2 },
      ]),
    );
    expect(back.order).toMatchObject({
      stage: 'returned',
      status: 'closed',
      fulfillmentStatus: 'returned',
      financialStatus: 'voided',
    });
    expect(back.order.fulfillments[0]).toMatchObject({
      status: 'returned',
      lines: [
        { lineId: chappals!.id, quantity: 2, restockedQuantity: 2 },
        { quantity: 1, restockedQuantity: 0 },
      ],
    });
    // The chappals are back on the shelf; the khussa was written off.
    expect(await f.level(f.a, chappal)).toMatchObject({ onHand: 5, available: 5 });
    expect(await f.level(f.a, khussa)).toMatchObject({ onHand: 4, available: 4 });
    const history = await f.inventory.history(f.a, chappal, { first: 1 });
    expect(history.items[0]).toMatchObject({ reason: 'restock', delta: 2 });
    const timeline = await f.orders.timeline(f.a, order.id, { first: 2 });
    expect(timeline.items.map((entry) => entry.message)).toEqual([
      'Parcel checked back in: 2 items back in stock, 1 item written off as damaged',
      'Refused or undeliverable: the parcel is coming back',
    ]);

    expect(errorsOf(await f.fulfillments.receiveReturn(f.a, fulfillmentId))).toEqual([
      ['id', 'INVALID'],
    ]);
    expect(errorsOf(await f.fulfillments.markDelivered(f.a, fulfillmentId))).toEqual([
      ['id', 'INVALID'],
    ]);
    expect(errorsOf(await f.orders.markAsPaid(f.a, order.id))).toEqual([['id', 'INVALID']]);
  });

  it('follows two parcels: one delivered, one refused', async () => {
    const order = await confirmedOrder();
    const [chappals, khussas] = order.lines;
    const first = unwrap(
      await f.fulfillments.fulfill(f.a, order.id, {
        lineItems: [{ id: chappals!.id, quantity: 2 }],
      }),
    );
    const second = unwrap(await f.fulfillments.fulfill(f.a, order.id, {}));
    unwrap(await f.fulfillments.markDelivered(f.a, first.fulfillmentId));
    expect(unwrap(await f.fulfillments.markReturning(f.a, second.fulfillmentId)).order.stage).toBe(
      'returning',
    );
    // Checked in without saying what to restock: everything is.
    const back = unwrap(await f.fulfillments.receiveReturn(f.a, second.fulfillmentId));
    expect(back.order).toMatchObject({
      stage: 'delivered',
      status: 'open',
      fulfillmentStatus: 'partially_returned',
      financialStatus: 'pending',
    });
    expect(back.order.fulfillments[1]!.lines).toEqual([
      { lineId: khussas!.id, quantity: 1, restockedQuantity: 1 },
    ]);
    expect(await f.level(f.a, khussa)).toMatchObject({ onHand: 5 });
    expect(unwrap(await f.orders.markAsPaid(f.a, order.id)).stage).toBe('completed');
  });

  it('sets tracking once a parcel is booked', async () => {
    const order = await confirmedOrder();
    const { fulfillmentId } = unwrap(await f.fulfillments.fulfill(f.a, order.id, {}));
    const tracked = unwrap(
      await f.fulfillments.updateTracking(f.a, fulfillmentId, {
        company: 'Leopards',
        number: 'LE7654321',
      }),
    );
    expect(tracked.order.fulfillments[0]).toMatchObject({
      trackingCompany: 'Leopards',
      trackingNumber: 'LE7654321',
      trackingUrl: null,
      version: 2,
    });
    const timeline = await f.orders.timeline(f.a, order.id, { first: 1 });
    expect(timeline.items[0]!.message).toBe('Tracking set to Leopards LE7654321');
    expect(
      errorsOf(await f.fulfillments.updateTracking(f.a, fulfillmentId, { url: 'not a url' })),
    ).toEqual([['trackingInfo.url', 'INVALID']]);
  });

  it("keeps each shop's parcels to itself", async () => {
    const order = await confirmedOrder();
    const { fulfillmentId } = unwrap(await f.fulfillments.fulfill(f.a, order.id, {}));
    expect(errorsOf(await f.fulfillments.fulfill(f.b, order.id, {}))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    for (const attempt of [
      () => f.fulfillments.markDelivered(f.b, fulfillmentId),
      () => f.fulfillments.markReturning(f.b, fulfillmentId),
      () => f.fulfillments.receiveReturn(f.b, fulfillmentId),
      () => f.fulfillments.updateTracking(f.b, fulfillmentId, { number: 'X1' }),
    ]) {
      expect(errorsOf(await attempt())).toEqual([['id', 'NOT_FOUND']]);
    }
    expect((await f.orders.get(f.a, order.id))?.fulfillments[0]?.status).toBe('in_transit');
  });
});
