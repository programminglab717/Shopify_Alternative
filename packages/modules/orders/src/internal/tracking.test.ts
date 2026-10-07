import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { trackingPage } from './link-pages.js';
import { ordersFixture, unwrap, type OrdersFixture } from './test-support.js';
import { OrderTrackingService, type TrackingView } from './tracking.service.js';

const server = testDatabaseServer();

describe.skipIf(!server)('OrderTrackingService', () => {
  let f: OrdersFixture;
  let tracking: OrderTrackingService;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
    tracking = new OrderTrackingService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 50);
  });

  const orderOf = (view: TrackingView) => {
    if (view.kind !== 'order') throw new Error(`Expected an order, got ${view.problem}`);
    return view;
  };

  it('finds an order by its number or a parcel’s tracking number, with its mobile number (ADR-251)', async () => {
    // The fixture's orders are placed with 0300-1234567.
    const order = await f.order(f.a, [kurta]);
    unwrap(await f.orders.confirm(f.a, order.id));
    const { fulfillmentId } = unwrap(
      await f.fulfillments.fulfill(f.a, order.id, {
        tracking: { company: 'PostEx', number: 'PX123456' },
      }),
    );
    const system = { shopId: f.a.shopId, actor: 'system' as const };
    unwrap(
      await f.fulfillments.recordEvent(system, fulfillmentId, {
        status: 'out_for_delivery',
        message: 'With the rider',
        happenedAt: new Date(Date.now() - 60_000),
        sourceKey: 'shipment.status_changed:1',
      }),
    );
    const name = `#${order.number}`;

    for (const reference of [name, String(order.number), 'px123456', ' PX123456 ']) {
      const found = orderOf(
        await tracking.find(f.a.shopId, { reference, phone: '+92 300 1234567' }),
      );
      expect(found.order.id).toBe(order.id);
    }
    const found = orderOf(
      await tracking.find(f.a.shopId, { reference: name, phone: '03001234567' }),
    );
    const page = trackingPage(found);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Out for delivery');
    expect(page.html).toContain('PX123456');
    expect(page.html).toContain(`Your order ${name}`);
    // Nothing of where it goes, nor what is in it.
    expect(page.html).not.toContain('House 12');
    expect(page.html).not.toContain('Kurta');

    // Another number, another shop, or nothing typed: the form again, saying why alike.
    for (const [shopId, form] of [
      [f.a.shopId, { reference: name, phone: '0321-7654321' }],
      [f.a.shopId, { reference: 'PX999', phone: '0300-1234567' }],
      [f.a.shopId, { reference: name, phone: 'not a number' }],
      [f.b.shopId, { reference: name, phone: '0300-1234567' }],
    ] as const) {
      const view = await tracking.find(shopId, form);
      expect(view).toMatchObject({ kind: 'form', problem: 'not_found' });
      expect(trackingPage(view).status).toBe(404);
    }
    const blank = await tracking.find(f.a.shopId, { reference: ' ', phone: '0300-1234567' });
    expect(blank).toMatchObject({ kind: 'form', problem: 'blank' });
    const empty = trackingPage(await tracking.page(f.a.shopId));
    expect(empty.status).toBe(200);
    expect(empty.html).toContain('Track your order');
    expect(empty.html).toContain('اپنا آرڈر ٹریک کریں');
  });
});
