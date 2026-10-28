import 'reflect-metadata';
import { parseSegmentQuery } from '@hatti/customers/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CustomerRfmService,
  RFM_FREQUENCIES,
  RFM_RECENCIES,
  rfmQuery,
} from './customer-rfm.service.js';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe("A group's segment query (ANL-04, ADR-887)", () => {
  it('reads as segments do, its lines where the grid draws them', () => {
    expect(rfmQuery('recent', 'many', 30, 90)).toBe(
      'delivered_orders >= 4 AND last_order_date > -30d',
    );
    expect(rfmQuery('slipping', 'few', 30, 90)).toBe(
      'delivered_orders BETWEEN 2 AND 3 AND last_order_date <= -30d AND last_order_date > -90d',
    );
    expect(rfmQuery('lapsed', 'once', 60, 180)).toBe(
      'delivered_orders <= 1 AND last_order_date <= -180d',
    );
    for (const recency of RFM_RECENCIES) {
      for (const frequency of RFM_FREQUENCIES) {
        expect(() => parseSegmentQuery(rfmQuery(recency, frequency, 30, 90))).not.toThrow();
      }
    }
  });
});

describe.skipIf(!server)('Customers by how recently and often they buy (ANL-04, ADR-887)', () => {
  let f: OrdersFixture;
  let rfm: CustomerRfmService;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
    rfm = new CustomerRfmService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 50);
  });

  /** An order from `phone`, placed `daysAgo` in Karachi, delivered or not. */
  async function orderedAt(phone: string, daysAgo: number, delivered = true) {
    const order = await f.order(f.a, [kurta], { shippingAddress: { ...ADDRESS, phone } });
    await f.admin.query(
      `UPDATE orders.orders
          SET created_at = now() - make_interval(days => $2),
              stage = CASE WHEN $3 THEN 'delivered' ELSE stage END
        WHERE id = $1`,
      [order.id, daysAgo, delivered],
    );
    return order;
  }

  it('groups customers by their last order and their delivered orders, with what they spent', async () => {
    // Bought four times, the last a week ago: a champion.
    for (const days of [200, 100, 40, 7]) await orderedAt('0300-1111111', days);
    // Bought twice, the last two months ago: needs attention.
    await orderedAt('0300-2222222', 120);
    await orderedAt('0300-2222222', 60);
    // Ordered yesterday, the parcel on its way: new.
    await orderedAt('0300-3333333', 1, false);
    // Bought once, half a year ago: lost.
    await orderedAt('0300-4444444', 180);
    // Another shop's customers are its own.
    await f.order(f.b, [(await f.variantsOf(f.b, 'Shawl', { price: '500' }))[0]!]);

    const report = unwrap(await rfm.report(f.a, { recentDays: 30, lapsedDays: 90 }));
    expect(report.customers).toBe(4);
    expect(report.groups.map((group) => group.name)).toEqual([
      'champions',
      'potential_loyalists',
      'new_customers',
      'loyal',
      'needs_attention',
      'about_to_sleep',
      'cant_lose',
      'at_risk',
      'lost',
    ]);
    const counted = Object.fromEntries(
      report.groups.filter((group) => group.customers > 0).map((group) => [group.name, group]),
    );
    expect(Object.keys(counted).sort()).toEqual([
      'champions',
      'lost',
      'needs_attention',
      'new_customers',
    ]);
    expect(counted.champions).toMatchObject({
      recency: 'recent',
      frequency: 'many',
      customers: 1,
      averageOrders: 4,
      query: 'delivered_orders >= 4 AND last_order_date > -30d',
    });
    expect(counted.needs_attention).toMatchObject({ customers: 1, averageOrders: 2 });
    expect(counted.new_customers).toMatchObject({ customers: 1, averageOrders: 0 });
    expect(counted.lost).toMatchObject({ customers: 1, averageOrders: 1 });

    // Drawn further back, the one two months ago is recent, and half a year is not yet lapsed.
    const longer = unwrap(await rfm.report(f.a, { recentDays: 90, lapsedDays: 365 }));
    const names = longer.groups.filter((group) => group.customers > 0).map((group) => group.name);
    expect(names.sort()).toEqual([
      'about_to_sleep',
      'champions',
      'new_customers',
      'potential_loyalists',
    ]);
  });

  it('draws its lines from 1 to 730 days, lapsed past recent', async () => {
    expect(errorsOf(await rfm.report(f.a, { recentDays: 0, lapsedDays: 90 }))).toEqual([
      ['recentDays', 'INVALID'],
    ]);
    expect(errorsOf(await rfm.report(f.a, { recentDays: 90, lapsedDays: 90 }))).toEqual([
      ['lapsedDays', 'INVALID'],
    ]);
  });
});
