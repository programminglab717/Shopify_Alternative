import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomerAnswers } from './customer-answers.js';
import { DeliveryRescueService } from './delivery-rescue.service.js';
import { ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Failed-delivery rescue (COD-08, ADR-388)', () => {
  let f: OrdersFixture;
  let answers: CustomerAnswers;
  let rescue: DeliveryRescueService;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
    answers = new CustomerAnswers(f.db, f.orders);
    rescue = new DeliveryRescueService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 10);
  });

  const system = () => ({ shopId: f.a.shopId, actor: 'system' as const });
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  /** A confirmed order shipped with PostEx: its ID and its parcel's. */
  async function shipped(number: string) {
    const order = await f.order(f.a, [kurta]);
    if (order.confirmationStatus === 'pending') unwrap(await f.orders.confirm(f.a, order.id));
    const { fulfillmentId } = unwrap(
      await f.fulfillments.fulfill(f.a, order.id, { tracking: { company: 'PostEx', number } }),
    );
    return { orderId: order.id, parcelId: fulfillmentId };
  }

  const step = async (
    parcelId: string,
    status: 'out_for_delivery' | 'attempted_delivery' | 'in_transit',
    minutesAgo: number,
    message?: string,
  ) =>
    unwrap(
      await f.fulfillments.recordEvent(system(), parcelId, {
        status,
        message,
        happenedAt: ago(minutesAgo),
      }),
    );

  it('lists parcels whose last step is a failed try, the answered first, and counts them', async () => {
    const first = await shipped('PX1');
    const second = await shipped('PX2');
    const moving = await shipped('PX3');
    await step(first.parcelId, 'attempted_delivery', 300, 'Customer not available');
    await step(first.parcelId, 'out_for_delivery', 200);
    await step(first.parcelId, 'attempted_delivery', 100, 'Phone off');
    await step(second.parcelId, 'attempted_delivery', 50, 'Address not found');
    // Out again after its try: on its way, nothing to rescue.
    await step(moving.parcelId, 'attempted_delivery', 90);
    await step(moving.parcelId, 'out_for_delivery', 10);

    const listed = await rescue.list(f.a, 50);
    expect(listed.count).toBe(2);
    expect(
      listed.parcels.map((parcel) => [
        parcel.id,
        parcel.trackingNumber,
        parcel.attempts,
        parcel.reason,
        parcel.answer,
      ]),
    ).toEqual([
      [second.parcelId, 'PX2', 1, 'Address not found', null],
      [first.parcelId, 'PX1', 2, 'Phone off', null],
    ]);
    expect(listed.parcels[0]).toMatchObject({
      orderId: second.orderId,
      customerName: 'Ayesha Khan',
      trackingCompany: 'PostEx',
    });
    expect(listed.parcels[0]!.city).toBeTruthy();

    // The customer whose parcel was tried earlier answers: theirs comes first.
    expect(await answers.rescue(f.a.shopId, first.orderId, 'call', 'on WhatsApp')).toBe(true);
    const answered = await rescue.list(f.a, 50);
    expect(answered.parcels.map((parcel) => [parcel.id, parcel.answer])).toEqual([
      [first.parcelId, 'call'],
      [second.parcelId, null],
    ]);
    expect(answered.parcels[0]!.answeredAt).toBeInstanceOf(Date);
    const [entry] = (await f.orders.timeline(f.a, first.orderId, { first: 1 })).items;
    expect([entry!.kind, entry!.actorKind, entry!.message]).toEqual([
      'customer_request',
      'system',
      'The customer asked on WhatsApp to be called before it is delivered again',
    ]);

    // Counted when none are listed; another shop has none.
    expect(await rescue.list(f.a, 0)).toEqual({ count: 2, parcels: [] });
    expect(await rescue.list(f.b, 50)).toEqual({ count: 0, parcels: [] });
  });

  it('keeps an answer for the try it answers alone, and none once the parcel moved on', async () => {
    const parcel = await shipped('PX9');
    // Nothing waits on a parcel not tried.
    expect(await answers.rescue(f.a.shopId, parcel.orderId, 'retry', 'on WhatsApp')).toBe(false);
    await step(parcel.parcelId, 'attempted_delivery', 120);
    expect(await answers.rescue(f.a.shopId, parcel.orderId, 'retry', 'on WhatsApp', ago(60))).toBe(
      true,
    );
    expect((await rescue.list(f.a, 50)).parcels[0]).toMatchObject({
      answer: 'retry',
      answeredAt: expect.any(Date),
    });
    const [entry] = (await f.orders.timeline(f.a, parcel.orderId, { first: 1 })).items;
    expect(entry!.message).toBe('The customer asked on WhatsApp to have it delivered again');

    // Tried again after the answer: that answer was for the try before.
    await step(parcel.parcelId, 'attempted_delivery', 30, 'Refused');
    expect((await rescue.list(f.a, 50)).parcels[0]).toMatchObject({
      attempts: 2,
      reason: 'Refused',
      answer: null,
      answeredAt: null,
    });

    // Delivered: off the list, and an answer after it finds nothing.
    unwrap(await f.fulfillments.markDelivered(f.a, parcel.parcelId));
    expect(await rescue.list(f.a, 50)).toEqual({ count: 0, parcels: [] });
    expect(await answers.rescue(f.a.shopId, parcel.orderId, 'call', 'on WhatsApp')).toBe(false);
    // Nor in another shop.
    expect(await answers.rescue(f.b.shopId, parcel.orderId, 'call', 'on WhatsApp')).toBe(false);
  });
});
