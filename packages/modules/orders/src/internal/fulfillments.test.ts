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

  it('checks a parcel back in by the tracking number on its label, as a scanner reads it', async () => {
    const shipped = async (number: string, company = 'Leopards') => {
      const order = await confirmedOrder();
      const parcel = unwrap(
        await f.fulfillments.fulfill(f.a, order.id, { tracking: { company, number } }),
      );
      return { order, id: parcel.fulfillmentId };
    };
    await f.stock(f.a, chappal, 20);
    await f.stock(f.a, khussa, 20);
    const refused = await shipped('LE 7001 234');
    unwrap(await f.fulfillments.markReturning(f.a, refused.id));
    // Found as couriers and scanners write it, in the order list too.
    const found = await f.orders.list(f.a, { first: 5, query: 'le7001234' });
    expect(found.items.map((order) => order.id)).toEqual([refused.order.id]);

    const back = unwrap(await f.fulfillments.receiveReturnByTracking(f.a, 'le7001234'));
    expect(back.fulfillmentId).toBe(refused.id);
    expect(back.order).toMatchObject({ stage: 'returned', fulfillmentStatus: 'returned' });
    expect(await f.level(f.a, chappal)).toMatchObject({ onHand: 20 });
    // Scanned again: it says so, at the box it was typed in.
    expect(errorsOf(await f.fulfillments.receiveReturnByTracking(f.a, 'LE7001234'))).toEqual([
      ['trackingNumber', 'INVALID'],
    ]);

    // A parcel the courier brings back before anyone marked it is checked in all the same.
    const early = await shipped('TCS-88', 'TCS');
    expect(unwrap(await f.fulfillments.receiveReturnByTracking(f.a, 'tcs-88')).order.stage).toBe(
      'returned',
    );

    // A number on two parcels still out names both orders; a delivered one is no return.
    const first = await shipped('M&P 55');
    const second = await shipped('m&p55');
    const both = await f.fulfillments.receiveReturnByTracking(f.a, 'M&P55');
    expect(both).toMatchObject({
      ok: false,
      errors: [
        {
          field: ['trackingNumber'],
          code: 'INVALID',
          message:
            `2 parcels still out have this tracking number, of orders #${first.order.number}, ` +
            `#${second.order.number}: check one in from its order`,
        },
      ],
    });
    const delivered = await shipped('PX-1');
    unwrap(await f.fulfillments.markDelivered(f.a, delivered.id));
    expect(errorsOf(await f.fulfillments.receiveReturnByTracking(f.a, 'px-1'))).toEqual([
      ['trackingNumber', 'INVALID'],
    ]);

    expect(errorsOf(await f.fulfillments.receiveReturnByTracking(f.a, 'NOPE-1'))).toEqual([
      ['trackingNumber', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.fulfillments.receiveReturnByTracking(f.a, ' \t'))).toEqual([
      ['trackingNumber', 'BLANK'],
    ]);
    // Another shop's parcels are not found.
    expect(errorsOf(await f.fulfillments.receiveReturnByTracking(f.b, 'tcs-88'))).toEqual([
      ['trackingNumber', 'NOT_FOUND'],
    ]);
    expect(early.order.id).not.toBe(refused.order.id);
  });

  it('lists the parcels coming back, the longest on its way first, by courier', async () => {
    const back = async (number: string, company: string, daysAgo: number) => {
      const order = await confirmedOrder();
      const { fulfillmentId } = unwrap(
        await f.fulfillments.fulfill(f.a, order.id, { tracking: { company, number } }),
      );
      unwrap(await f.fulfillments.markReturning(f.a, fulfillmentId));
      await f.admin.query(
        `UPDATE orders.fulfillments SET returning_at = $2::timestamptz - make_interval(days => $3)
          WHERE id = $1`,
        [fulfillmentId, '2026-10-01T09:00:00Z', daysAgo],
      );
      return { order, id: fulfillmentId };
    };
    await f.stock(f.a, chappal, 20);
    await f.stock(f.a, khussa, 20);
    const recent = await back('LE-2', 'Leopards', 2);
    const oldest = await back('LE-9', 'Leopards', 9);
    const middle = await back('TCS-5', 'TCS', 5);
    const at = new Date('2026-10-01T21:00:00Z');

    const page = await f.fulfillments.returning(f.a, { first: 2, at });
    expect(page.hasNextPage).toBe(true);
    expect(page.items).toMatchObject([
      {
        id: oldest.id,
        orderId: oldest.order.id,
        orderNumber: oldest.order.number,
        trackingCompany: 'Leopards',
        trackingNumber: 'LE-9',
        days: 9,
        units: 3,
      },
      { id: middle.id, days: 5 },
    ]);
    const last = page.items[1]!;
    const next = await f.fulfillments.returning(f.a, {
      first: 2,
      at,
      after: { returningAt: last.returningAt, id: last.id },
    });
    expect(next).toMatchObject({ items: [{ id: recent.id, days: 2 }], hasNextPage: false });

    // One courier's; and a parcel checked back in leaves the list.
    const leopards = await f.fulfillments.returning(f.a, { first: 10, at, courier: ' leopards ' });
    expect(leopards.items.map((parcel) => parcel.id)).toEqual([oldest.id, recent.id]);
    unwrap(await f.fulfillments.receiveReturn(f.a, oldest.id));
    const left = await f.fulfillments.returning(f.a, { first: 10, at });
    expect(left.items.map((parcel) => parcel.id)).toEqual([middle.id, recent.id]);
    expect((await f.fulfillments.returning(f.b, { first: 10, at })).items).toEqual([]);
  });

  it('writes off a parcel the courier lost, its order done apart from those refused', async () => {
    await f.stock(f.a, chappal, 20);
    await f.stock(f.a, khussa, 20);
    // Lost on its way out: nothing restocked, the order lost, closed and voided.
    const order = await confirmedOrder();
    const { fulfillmentId } = unwrap(
      await f.fulfillments.fulfill(f.a, order.id, { tracking: { company: 'TCS', number: '7790' } }),
    );
    const lost = unwrap(await f.fulfillments.markLost(f.a, fulfillmentId));
    expect(lost.order).toMatchObject({
      stage: 'lost',
      status: 'closed',
      financialStatus: 'voided',
      fulfillmentStatus: 'fulfilled',
    });
    expect(lost.order.fulfillments[0]).toMatchObject({
      status: 'lost',
      lostAt: expect.any(Date),
      lines: [{ restockedQuantity: 0 }, { restockedQuantity: 0 }],
    });
    expect(await f.level(f.a, chappal)).toMatchObject({ onHand: 18 });
    // Lost twice is still lost; and nothing more from its courier.
    expect(unwrap(await f.fulfillments.markLost(f.a, fulfillmentId)).order.version).toBe(
      lost.order.version,
    );
    for (const attempt of [f.fulfillments.markDelivered, f.fulfillments.markReturning]) {
      expect(errorsOf(await attempt.call(f.fulfillments, f.a, fulfillmentId))).toEqual([
        ['id', 'INVALID'],
      ]);
    }
    // It turns up: checked back in by its number, its items back on the shelf, and the order
    // still lost, not refused.
    const found = unwrap(await f.fulfillments.receiveReturnByTracking(f.a, '7790'));
    expect(found.order).toMatchObject({ stage: 'lost', status: 'closed' });
    expect(found.order.fulfillments[0]).toMatchObject({
      status: 'returned',
      lostAt: expect.any(Date),
      returnedAt: expect.any(Date),
    });
    expect(await f.level(f.a, chappal)).toMatchObject({ onHand: 20 });
    const timeline = await f.orders.timeline(f.a, order.id, { first: 2 });
    expect(timeline.items.map((entry) => entry.message)).toEqual([
      'Lost parcel turned up, checked back in: 3 items back in stock',
      'Lost by TCS 7790: 3 items written off',
    ]);

    // Lost on its way back, it leaves the parcels coming back.
    const second = await confirmedOrder();
    const back = unwrap(await f.fulfillments.fulfill(f.a, second.id, {}));
    unwrap(await f.fulfillments.markReturning(f.a, back.fulfillmentId));
    const lostBack = unwrap(await f.fulfillments.markLost(f.a, back.fulfillmentId));
    expect(lostBack.order.stage).toBe('lost');
    expect((await f.orders.timeline(f.a, second.id, { first: 1 })).items[0]!.message).toBe(
      'Lost by the courier on its way back: 3 items written off',
    );
    expect((await f.fulfillments.returning(f.a, { first: 10 })).items).toEqual([]);

    // A delivered parcel is not lost; one of two lost leaves the order to the other.
    const third = await confirmedOrder();
    const [chappals] = third.lines;
    const first = unwrap(
      await f.fulfillments.fulfill(f.a, third.id, {
        lineItems: [{ id: chappals!.id, quantity: 2 }],
      }),
    );
    const rest = unwrap(await f.fulfillments.fulfill(f.a, third.id, {}));
    unwrap(await f.fulfillments.markDelivered(f.a, first.fulfillmentId));
    expect(errorsOf(await f.fulfillments.markLost(f.a, first.fulfillmentId))).toEqual([
      ['id', 'INVALID'],
    ]);
    const partly = unwrap(await f.fulfillments.markLost(f.a, rest.fulfillmentId));
    expect(partly.order).toMatchObject({ stage: 'delivered', status: 'open' });

    // Lost before it reached them is the courier's doing; refused, though lost on its way back,
    // is still the customer's refusal.
    const stats = await f.orders.customerStats(f.a, [order.customerId]);
    expect(stats.get(order.customerId)).toMatchObject({
      count: 3,
      delivered: 1,
      returned: 1,
      lost: 1,
      inProgress: 0,
    });
    expect(errorsOf(await f.fulfillments.markLost(f.b, rest.fulfillmentId))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
  });

  it('claims what the courier lost, and follows the claim until it is settled', async () => {
    await f.stock(f.a, chappal, 20);
    await f.stock(f.a, khussa, 20);
    /** An order shipped with TCS under `number`, and its parcel. */
    const shipped = async (number: string) => {
      const order = await confirmedOrder();
      const { fulfillmentId } = unwrap(
        await f.fulfillments.fulfill(f.a, order.id, { tracking: { company: 'TCS', number } }),
      );
      return { order, id: fulfillmentId };
    };
    const claimOf = async (orderId: string) =>
      (await f.orders.get(f.a, orderId))!.fulfillments[0]!.claim;
    const latest = async (orderId: string) =>
      (await f.orders.timeline(f.a, orderId, { first: 1 })).items[0]!.message;

    // Only a lost parcel is claimed; its worth unless the shop says otherwise.
    const first = await shipped('7790');
    expect(errorsOf(await f.fulfillments.claim(f.a, first.id))).toEqual([['id', 'INVALID']]);
    unwrap(await f.fulfillments.markLost(f.a, first.id));
    await f.admin.query('DELETE FROM platform.outbox_events');
    const claimed = unwrap(await f.fulfillments.claim(f.a, first.id));
    expect(claimed.order.fulfillments[0]!.claim).toEqual({
      status: 'open',
      amount: 9_248_00n,
      paid: null,
      note: null,
      claimedAt: expect.any(Date),
      settledAt: null,
    });
    expect(await latest(first.order.id)).toBe('Claimed Rs 9,248 from TCS for the lost parcel 7790');
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'fulfillment.updated')
        .map((event) => [event.aggregate_id, event.payload.changed]),
    ).toEqual([[first.id, ['claim']]]);
    expect(errorsOf(await f.fulfillments.claim(f.a, first.id))).toEqual([['id', 'TAKEN']]);

    // Refused, it may still be paid, up to the order's total; paid, it is done with.
    unwrap(
      await f.fulfillments.settleClaim(f.a, first.id, { status: 'refused', note: 'Not insured' }),
    );
    expect(await claimOf(first.order.id)).toMatchObject({
      status: 'refused',
      note: 'Not insured',
      settledAt: expect.any(Date),
    });
    expect(await latest(first.order.id)).toBe(
      'TCS refused the claim for the lost parcel 7790: Not insured',
    );
    expect(
      errorsOf(await f.fulfillments.settleClaim(f.a, first.id, { status: 'refused' })),
    ).toEqual([['id', 'INVALID']]);
    for (const amount of [undefined, '0', '9,249', 'lots']) {
      const result = await f.fulfillments.settleClaim(f.a, first.id, { status: 'paid', amount });
      expect(errorsOf(result)).toEqual([['amount', amount === undefined ? 'BLANK' : 'INVALID']]);
    }
    unwrap(await f.fulfillments.settleClaim(f.a, first.id, { status: 'paid', amount: '5,000' }));
    expect(await claimOf(first.order.id)).toMatchObject({
      status: 'paid',
      amount: 9_248_00n,
      paid: 5_000_00n,
      note: 'Not insured',
    });
    expect(await latest(first.order.id)).toBe(
      'TCS paid Rs 5,000 on the claim for the lost parcel 7790',
    );
    expect(
      errorsOf(await f.fulfillments.settleClaim(f.a, first.id, { status: 'withdrawn' })),
    ).toEqual([['id', 'INVALID']]);

    // An amount of the shop's own, and a note; withdrawn, it may be filed again.
    const second = await shipped('7791');
    unwrap(await f.fulfillments.markLost(f.a, second.id));
    for (const input of [{ amount: '0' }, { amount: '9,248.01' }, { note: 'x'.repeat(501) }]) {
      expect(errorsOf(await f.fulfillments.claim(f.a, second.id, input))).toEqual([
        [Object.keys(input)[0]!, input.note ? 'TOO_LONG' : 'INVALID'],
      ]);
    }
    unwrap(
      await f.fulfillments.claim(f.a, second.id, { amount: '3,000', note: 'Complaint 12345' }),
    );
    expect(await claimOf(second.order.id)).toMatchObject({
      status: 'open',
      amount: 3_000_00n,
      note: 'Complaint 12345',
    });
    expect(await latest(second.order.id)).toBe(
      'Claimed Rs 3,000 from TCS for the lost parcel 7791: Complaint 12345',
    );
    unwrap(await f.fulfillments.settleClaim(f.a, second.id, { status: 'withdrawn' }));
    expect(await latest(second.order.id)).toBe('Claim on TCS for the lost parcel 7791 withdrawn');
    unwrap(await f.fulfillments.claim(f.a, second.id));
    expect(await claimOf(second.order.id)).toMatchObject({
      status: 'open',
      amount: 9_248_00n,
      note: null,
      settledAt: null,
    });

    // A lost parcel that turns up is owed by no one: its open claim is withdrawn.
    unwrap(await f.fulfillments.receiveReturnByTracking(f.a, '7791'));
    expect(await claimOf(second.order.id)).toMatchObject({ status: 'withdrawn' });
    expect(await latest(second.order.id)).toBe(
      'Lost parcel turned up, checked back in: 3 items back in stock; its claim on TCS withdrawn',
    );
    expect(errorsOf(await f.fulfillments.claim(f.a, second.id))).toEqual([['id', 'INVALID']]);

    // Each shop its own.
    expect(errorsOf(await f.fulfillments.claim(f.b, first.id))).toEqual([['id', 'NOT_FOUND']]);
    expect(
      errorsOf(await f.fulfillments.settleClaim(f.b, first.id, { status: 'withdrawn' })),
    ).toEqual([['id', 'NOT_FOUND']]);
  });

  it('lists the parcels the courier lost, the longest lost first, with their claims', async () => {
    await f.stock(f.a, chappal, 20);
    await f.stock(f.a, khussa, 20);
    const lost = async (number: string, company: string, daysAgo: number) => {
      const order = await confirmedOrder();
      const { fulfillmentId } = unwrap(
        await f.fulfillments.fulfill(f.a, order.id, { tracking: { company, number } }),
      );
      unwrap(await f.fulfillments.markLost(f.a, fulfillmentId));
      await f.admin.query(
        `UPDATE orders.fulfillments SET lost_at = $2::timestamptz - make_interval(days => $3)
          WHERE id = $1`,
        [fulfillmentId, '2026-10-01T09:00:00Z', daysAgo],
      );
      return { order, id: fulfillmentId };
    };
    const unclaimed = await lost('LE-1', 'Leopards', 3);
    const open = await lost('TCS-8', 'TCS', 8);
    const paid = await lost('LE-20', 'Leopards', 20);
    unwrap(await f.fulfillments.claim(f.a, open.id, { amount: '5,000' }));
    unwrap(await f.fulfillments.claim(f.a, paid.id));
    unwrap(await f.fulfillments.settleClaim(f.a, paid.id, { status: 'paid', amount: '9,248' }));
    const at = new Date('2026-10-01T21:00:00Z');

    const page = await f.fulfillments.lost(f.a, { first: 2, at });
    expect(page.hasNextPage).toBe(true);
    expect(page.items).toMatchObject([
      {
        id: paid.id,
        orderId: paid.order.id,
        orderNumber: paid.order.number,
        trackingCompany: 'Leopards',
        trackingNumber: 'LE-20',
        days: 20,
        units: 3,
        worth: 9_248_00n,
        claim: { status: 'paid', amount: 9_248_00n, paid: 9_248_00n },
      },
      { id: open.id, days: 8, claim: { status: 'open', amount: 5_000_00n, paid: null } },
    ]);
    const last = page.items[1]!;
    const next = await f.fulfillments.lost(f.a, {
      first: 2,
      at,
      after: { lostAt: last.lostAt, id: last.id },
    });
    expect(next).toMatchObject({
      items: [{ id: unclaimed.id, days: 3, claim: null }],
      hasNextPage: false,
    });

    // By their claims, and by courier.
    const ids = async (options: Partial<Parameters<typeof f.fulfillments.lost>[1]>) =>
      (await f.fulfillments.lost(f.a, { first: 10, at, ...options })).items.map((p) => p.id);
    expect(await ids({ claims: ['unclaimed', 'open'] })).toEqual([open.id, unclaimed.id]);
    expect(await ids({ claims: ['paid'] })).toEqual([paid.id]);
    expect(await ids({ claims: [] })).toEqual([]);
    expect(await ids({ courier: ' leopards ' })).toEqual([paid.id, unclaimed.id]);

    // The home counts those to claim, at their worth, and the claims still open.
    expect(await f.orders.home(f.a)).toMatchObject({
      lostToClaim: { count: 1, total: 9_248_00n },
      claimsOpen: { count: 1, total: 5_000_00n },
    });
    // One that turns up leaves the list.
    unwrap(await f.fulfillments.receiveReturn(f.a, unclaimed.id));
    expect(await ids({})).toEqual([paid.id, open.id]);
    expect((await f.orders.home(f.a)).lostToClaim).toEqual({ count: 0, total: 0n });
    expect((await f.fulfillments.lost(f.b, { first: 10, at })).items).toEqual([]);
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
