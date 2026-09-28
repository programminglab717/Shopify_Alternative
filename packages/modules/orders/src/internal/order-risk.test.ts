import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('COD risk', () => {
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
    await f.stock(f.a, kurta, 100);
  });

  /** Ships an order in one parcel, confirming it first if it needs confirming. */
  async function ship(orderId: string): Promise<string> {
    const order = unwrap(await f.orders.confirm(f.a, orderId));
    return unwrap(await f.fulfillments.fulfill(f.a, order.id, {})).fulfillmentId;
  }

  const codes = (order: { risk: { reasons: { code: string }[] } | null }) =>
    order.risk?.reasons.map((reason) => reason.code);

  it('scores cash-on-delivery orders when they are placed, and keeps why', async () => {
    const first = await f.order(f.a, [kurta]);
    expect(first).toMatchObject({ stage: 'needs_confirmation' });
    expect(first.risk).toEqual({
      score: 10,
      level: 'low',
      reasons: [{ code: 'first_order', message: 'First order from this number', weight: 10 }],
    });

    // Another while the first has not shipped: a possible duplicate.
    const second = await f.order(f.a, [kurta]);
    expect(second.risk).toEqual({
      score: 25,
      level: 'low',
      reasons: [
        {
          code: 'recent_order',
          message: 'Another order from this number in the last 6 hours: #1001',
          weight: 25,
        },
      ],
    });

    // Prepaid orders cannot come back unpaid.
    const prepaid = await f.order(f.a, [kurta], { paymentMethod: 'prepaid' });
    expect(prepaid.risk).toBeNull();

    const created = (await f.outbox()).filter((event) => event.event_type === 'order.created');
    expect(created.map((event) => event.payload.riskLevel)).toEqual(['low', 'low', null]);
  });

  it("holds an order at the shop's threshold, with the reasons on its timeline", async () => {
    // Refused at the door: it counts from when the parcel starts coming back.
    const refused = await f.order(f.a, [kurta]);
    unwrap(await f.fulfillments.markReturning(f.a, await ship(refused.id)));

    const pending = await f.order(f.a, [kurta]);
    expect(pending).toMatchObject({ stage: 'needs_confirmation', risk: { score: 35 } });
    expect(codes(pending)).toEqual(['refused_deliveries']);

    // A refusal and an unshipped order already: 60, the default threshold.
    const held = await f.order(f.a, [kurta]);
    expect(held).toMatchObject({
      confirmationStatus: 'needs_review',
      stage: 'needs_review',
      risk: { score: 60, level: 'high' },
    });
    const timeline = await f.orders.timeline(f.a, held.id, { first: 5 });
    expect(timeline.items.map((entry) => [entry.kind, entry.actorKind, entry.message])).toEqual([
      [
        'held',
        'system',
        'Held for review: risk 0.60 (high). Refused a delivery from this shop; ' +
          'Another order from this number in the last 6 hours: #1002',
      ],
      ['created', 'app', 'Order #1003 placed through the API: Rs 2,000, cash on delivery'],
    ]);
    const created = (await f.outbox()).filter((event) => event.event_type === 'order.created');
    expect(created.at(-1)!.payload).toMatchObject({ riskLevel: 'high', stage: 'needs_review' });

    // Staff review it and let it go ahead.
    expect(unwrap(await f.orders.confirm(f.a, held.id))).toMatchObject({ stage: 'to_fulfill' });

    // The customer's delivery history counts the parcel coming back as returned too.
    const stats = await f.orders.customerStats(f.a, [held.customerId]);
    expect(stats.get(held.customerId)).toMatchObject({ count: 3, returned: 1, inProgress: 2 });
  });

  it('trusts customers who took their deliveries', async () => {
    for (let index = 0; index < 2; index++) {
      const order = await f.order(f.a, [kurta]);
      unwrap(await f.fulfillments.markDelivered(f.a, await ship(order.id)));
    }
    // Rs 16,000 is high value, and this customer took delivery twice.
    const large = unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 8 }],
        shippingAddress: ADDRESS,
      }),
    );
    expect(large.risk).toMatchObject({ score: 0, level: 'low' });
    expect(large.risk!.reasons).toEqual([
      { code: 'high_value', message: 'High value: Rs 16,000', weight: 20 },
      {
        code: 'trusted_customer',
        message: 'Took delivery of 2 orders before, and refused none',
        weight: -20,
      },
    ]);
  });

  it('counts only unshipped orders from the last 6 hours as possible duplicates', async () => {
    const shipped = await f.order(f.a, [kurta]);
    await ship(shipped.id);
    const cancelled = await f.order(f.a, [kurta]);
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    const older = await f.order(f.a, [kurta]);
    await f.admin.query(
      `UPDATE orders.orders SET created_at = now() - interval '7 hours' WHERE id = $1`,
      [older.id],
    );
    const latest = await f.order(f.a, [kurta]);
    expect(latest.risk).toEqual({ score: 0, level: 'low', reasons: [] });
  });

  it("follows the shop's policy", async () => {
    expect(await f.riskSettings.get(f.a)).toEqual({
      holdAt: 60,
      highValue: 1_500_000n,
      updatedAt: null,
    });
    expect(errorsOf(await f.riskSettings.update(f.a, { holdAt: 0 }))).toEqual([
      ['input.holdAt', 'INVALID'],
    ]);
    expect(errorsOf(await f.riskSettings.update(f.a, { holdAt: 1.5, highValue: '0' }))).toEqual([
      ['input.holdAt', 'INVALID'],
      ['input.highValue', 'INVALID'],
    ]);
    expect(errorsOf(await f.riskSettings.update(f.a, { holdAt: 0.555, highValue: null }))).toEqual([
      ['input.holdAt', 'INVALID'],
      ['input.highValue', 'BLANK'],
    ]);

    const saved = unwrap(await f.riskSettings.update(f.a, { holdAt: 0.3, highValue: '5,000' }));
    expect(saved).toMatchObject({ holdAt: 30, highValue: 500_000n });
    expect(saved.updatedAt).toBeInstanceOf(Date);
    expect(await f.riskSettings.get(f.b)).toMatchObject({ holdAt: 60, updatedAt: null });
    const settingsEvents = async () =>
      (await f.outbox()).filter((event) => event.event_type === 'order_risk_settings.updated');
    expect(await settingsEvents()).toEqual([
      {
        event_type: 'order_risk_settings.updated',
        aggregate_id: f.a.shopId,
        payload: {
          holdAt: 30,
          highValue: '500000',
          currency: 'PKR',
          actorKind: 'app',
          actorId: f.a.actor.kind === 'app' ? f.a.actor.tokenId : null,
        },
      },
    ]);
    // Saving what is there already changes nothing.
    unwrap(await f.riskSettings.update(f.a, { holdAt: 0.3 }));
    expect(await settingsEvents()).toHaveLength(1);

    // Rs 6,000 is high value now; with a first order, that is 30.
    const large = { lineItems: [{ variantId: kurta, quantity: 3 }], shippingAddress: ADDRESS };
    const held = unwrap(await f.orders.create(f.a, large));
    expect(held).toMatchObject({ stage: 'needs_review', risk: { score: 30, level: 'medium' } });

    // null holds none: orders are still scored.
    unwrap(await f.riskSettings.update(f.a, { holdAt: null }));
    expect(await f.riskSettings.get(f.a)).toMatchObject({ holdAt: null, highValue: 500_000n });
    const scored = unwrap(await f.orders.create(f.a, large));
    expect(scored).toMatchObject({ stage: 'needs_confirmation', risk: { score: 45 } });
    expect(codes(scored)).toEqual(['recent_order', 'high_value']);
  });

  it('scores an order again when its address changes, and holds it if that makes it risky', async () => {
    unwrap(await f.riskSettings.update(f.a, { holdAt: 0.4 }));
    const order = await f.order(f.a, [kurta]);
    expect(order.risk).toMatchObject({ score: 10 });

    const vague = { ...ADDRESS, address1: 'Masjid', city: 'Unknownabad' };
    const changed = unwrap(await f.orders.update(f.a, order.id, { shippingAddress: vague }));
    expect(changed).toMatchObject({ stage: 'needs_review', risk: { score: 45, level: 'medium' } });
    const timeline = await f.orders.timeline(f.a, order.id, { first: 2 });
    expect(timeline.items.map((entry) => entry.message)).toEqual([
      'Held for review: risk 0.45 (medium). The address has no house or street number; ' +
        'First order from this number; The address is very short; ' +
        '"Unknownabad" is not a city couriers know by that spelling',
      'Changed the shipping address',
    ]);

    // Reviewed, then corrected by staff: still risky, but it already was, so it goes ahead.
    unwrap(await f.orders.confirm(f.a, order.id));
    const corrected = unwrap(
      await f.orders.update(f.a, order.id, {
        shippingAddress: { ...vague, address1: 'Masjid Rd' },
      }),
    );
    expect(corrected).toMatchObject({ stage: 'to_fulfill', risk: { score: 45 } });

    // A full address brings it down again.
    const fixed = unwrap(await f.orders.update(f.a, order.id, { shippingAddress: ADDRESS }));
    expect(fixed).toMatchObject({ stage: 'to_fulfill', risk: { score: 10, level: 'low' } });

    // Prepaid orders stay unscored.
    const prepaid = await f.order(f.a, [kurta], { paymentMethod: 'prepaid' });
    const moved = unwrap(await f.orders.update(f.a, prepaid.id, { shippingAddress: vague }));
    expect(moved).toMatchObject({ stage: 'to_fulfill', risk: null });
  });

  it('lists orders by risk level', async () => {
    const low = await f.order(f.a, [kurta]);
    const medium = await f.order(f.a, [kurta], {
      shippingAddress: {
        ...ADDRESS,
        phone: '0333-5551234',
        address1: 'Masjid',
        city: 'Unknownabad',
      },
    });
    await f.order(f.a, [kurta], { paymentMethod: 'prepaid' });
    expect(medium.risk).toMatchObject({ score: 45, level: 'medium' });

    const ids = async (riskLevel: 'low' | 'medium' | 'high') =>
      (await f.orders.list(f.a, { first: 10, riskLevel })).items.map((order) => order.id);
    expect(await ids('low')).toEqual([low.id]);
    expect(await ids('medium')).toEqual([medium.id]);
    expect(await ids('high')).toEqual([]);
    expect((await f.orders.list(f.b, { first: 10, riskLevel: 'low' })).items).toEqual([]);
  });
});
