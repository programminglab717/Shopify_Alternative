import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SalesReportService, totalSales } from './sales-report.service.js';
import { ordersFixture, unwrap, type OrdersFixture } from './test-support.js';
import { TodayService } from './today.service.js';

const server = testDatabaseServer();

describe.skipIf(!server)('TodayService', () => {
  let f: OrdersFixture;
  let days: TodayService;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
    days = new TodayService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 50);
  });

  /** Confirms an order and ships it in one parcel; the parcel's id. */
  async function shipped(orderId: string): Promise<string> {
    unwrap(await f.orders.confirm(f.a, orderId));
    return unwrap(await f.fulfillments.fulfill(f.a, orderId, {})).fulfillmentId;
  }

  it("says how the shop's day has gone, from midnight in its time zone (ADR-121)", async () => {
    const none = { count: 0, total: 0n };
    const empty = await days.today(f.a);
    // Midnight in Karachi is 19:00 the day before in UTC.
    expect(empty.since.getUTCHours()).toBe(19);
    expect(Date.now() - empty.since.getTime()).toBeLessThan(86_400_000);
    expect(empty).toMatchObject({
      sales: none,
      salesYesterday: none,
      delivered: none,
      returnedToOrigin: none,
    });
    const justBefore = new Date(empty.since.getTime() - 1000);

    // Today: a kurta with Rs 250 for delivery, two kurtas, and a kurta cancelled; and a kurta
    // placed a second before midnight.
    const first = await f.order(f.a, [kurta], { shippingPrice: '250' });
    const second = await f.order(f.a, [kurta, kurta]);
    const cancelled = await f.order(f.a, [kurta]);
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    const yesterdays = await f.order(f.a, [kurta]);
    await f.admin.query('UPDATE orders.orders SET created_at = $2 WHERE id = $1', [
      yesterdays.id,
      justBefore,
    ]);
    // And one placed a second after yesterday's midnight: yesterday by this time of day, which
    // the one a second before midnight was not (ADR-250).
    const early = await f.order(f.a, [kurta]);
    await f.admin.query('UPDATE orders.orders SET created_at = $2 WHERE id = $1', [
      early.id,
      new Date(empty.since.getTime() - 86_400_000 + 1000),
    ]);

    // Yesterday's order delivered today, the first refused today, and the second delivered a
    // second before midnight.
    unwrap(await f.fulfillments.markDelivered(f.a, await shipped(yesterdays.id)));
    unwrap(await f.fulfillments.markReturning(f.a, await shipped(first.id)));
    const before = await shipped(second.id);
    unwrap(await f.fulfillments.markDelivered(f.a, before));
    await f.admin.query('UPDATE orders.fulfillments SET delivered_at = $2 WHERE id = $1', [
      before,
      justBefore,
    ]);

    const today = await days.today(f.a);
    expect(today.since).toEqual(empty.since);
    // Two orders, Rs 6,250, less the kurta that came back: the sales report's today.
    const report = unwrap(
      await new SalesReportService(f.db).report(f.a, {
        placedFrom: today.since,
        placedBefore: new Date(today.since.getTime() + 86_400_000),
        interval: 'day',
        topProducts: 0,
      }),
    );
    expect(today.sales).toEqual({ count: 2, total: 425_000n });
    expect(today.sales.total).toBe(totalSales(report.totals));
    expect(today.salesYesterday).toEqual({ count: 1, total: 200_000n });
    // Parcels at their items' worth, whenever their orders were placed.
    expect(today.delivered).toEqual({ count: 1, total: 200_000n });
    expect(today.returnedToOrigin).toEqual({ count: 1, total: 200_000n });

    expect(await days.today(f.b)).toMatchObject({
      sales: none,
      salesYesterday: none,
      delivered: none,
      returnedToOrigin: none,
    });
  });
});
