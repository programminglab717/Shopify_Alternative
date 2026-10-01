import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SalesReportService,
  averageOrderValue,
  netSales,
  type SalesReportInput,
} from './sales-report.service.js';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('SalesReportService', () => {
  let f: OrdersFixture;
  let sales: SalesReportService;
  let kurta: string;
  let shawl: string;

  // Monday 28 September to Wednesday 30 September 2026, in Karachi.
  const days = (extra: Partial<SalesReportInput> = {}): SalesReportInput => ({
    placedFrom: new Date('2026-09-28T00:00:00+05:00'),
    placedBefore: new Date('2026-10-01T00:00:00+05:00'),
    interval: 'day',
    topProducts: 10,
    ...extra,
  });

  /** Places an order, then dates it as if placed at `at`. */
  async function placedAt(at: string, lineItems: string[], extra: Record<string, unknown> = {}) {
    const order = await f.order(f.a, lineItems, extra);
    await f.admin.query('UPDATE orders.orders SET created_at = $2 WHERE id = $1', [order.id, at]);
    return order;
  }

  beforeAll(async () => {
    f = await ordersFixture(server!);
    sales = new SalesReportService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    [shawl] = (await f.variantsOf(f.a, 'Pashmina Shawl', { price: '5,000' })) as [string];
    await f.stock(f.a, kurta, 50);
    await f.stock(f.a, shawl, 50);
  });

  /**
   * In Karachi: two kurtas at 01:30 on the 29th (still the 28th in UTC), Rs 500 off and Rs 250
   * for delivery, and a shawl later that day; a kurta and a shawl, cancelled; a kurta on the
   * 30th, refused at the door; and a kurta just after the period.
   */
  async function aFewDaysOfOrders() {
    await placedAt('2026-09-28T20:30:00Z', [kurta, kurta], {
      discount: '500',
      shippingPrice: '250',
    });
    await placedAt('2026-09-29T10:00:00Z', [shawl]);
    const cancelled = await placedAt('2026-09-29T11:00:00Z', [kurta, shawl]);
    unwrap(await f.orders.cancel(f.a, cancelled.id, { reason: 'customer' }));
    const refused = await placedAt('2026-09-30T10:00:00Z', [kurta]);
    unwrap(await f.orders.confirm(f.a, refused.id));
    const parcel = unwrap(await f.fulfillments.fulfill(f.a, refused.id, {})).fulfillmentId;
    unwrap(await f.fulfillments.markReturning(f.a, parcel));
    await placedAt('2026-09-30T19:30:00Z', [kurta]);
  }

  const zero = { orders: 0, grossSales: 0n, discounts: 0n, returns: 0n, shipping: 0n };

  it("says what a period's orders came to, day by day in the shop's time", async () => {
    await aFewDaysOfOrders();
    const report = unwrap(await sales.report(f.a, days()));
    expect(report.periods).toEqual([
      { start: new Date('2026-09-28T00:00:00+05:00'), ...zero },
      {
        start: new Date('2026-09-29T00:00:00+05:00'),
        orders: 2,
        grossSales: 9_000_00n,
        discounts: 500_00n,
        returns: 0n,
        shipping: 250_00n,
      },
      // Refused: still an order, its items returns.
      {
        start: new Date('2026-09-30T00:00:00+05:00'),
        orders: 1,
        grossSales: 2_000_00n,
        discounts: 0n,
        returns: 2_000_00n,
        shipping: 0n,
      },
    ]);
    expect(report.totals).toEqual({
      orders: 3,
      grossSales: 11_000_00n,
      discounts: 500_00n,
      returns: 2_000_00n,
      shipping: 250_00n,
    });
    expect(netSales(report.totals)).toBe(8_500_00n);
    expect(averageOrderValue(report.totals)).toBe(3_500_00n);
    expect(averageOrderValue(zero)).toBeNull();

    expect(report.topProducts).toEqual([
      {
        productId: expect.any(String),
        title: 'Kurta',
        unitsSold: 3,
        orders: 2,
        grossSales: 6_000_00n,
      },
      {
        productId: expect.any(String),
        title: 'Pashmina Shawl',
        unitsSold: 1,
        orders: 1,
        grossSales: 5_000_00n,
      },
    ]);
    const top = unwrap(await sales.report(f.a, days({ topProducts: 1 }))).topProducts;
    expect(top.map((product) => product.title)).toEqual(['Kurta']);

    const other = unwrap(await sales.report(f.b, days()));
    expect(other.totals).toEqual(zero);
    expect(other.periods).toHaveLength(3);
  });

  it('divides the period into weeks from Monday, or months', async () => {
    await aFewDaysOfOrders();
    const weeks = unwrap(await sales.report(f.a, days({ interval: 'week' }))).periods;
    expect(weeks).toEqual([
      expect.objectContaining({ start: new Date('2026-09-28T00:00:00+05:00'), orders: 3 }),
    ]);
    const months = unwrap(
      await sales.report(
        f.a,
        days({ interval: 'month', placedBefore: new Date('2026-10-02T00:00:00+05:00') }),
      ),
    ).periods;
    expect(months).toEqual([
      expect.objectContaining({ start: new Date('2026-09-01T00:00:00+05:00'), orders: 3 }),
      // The kurta placed on the 1st.
      expect.objectContaining({ start: new Date('2026-10-01T00:00:00+05:00'), orders: 1 }),
    ]);
  });

  it('takes a period of a year at most', async () => {
    const from = new Date('2026-01-01T00:00:00+05:00');
    const after = (n: number) => new Date(from.getTime() + n * 86_400_000);
    const report = (placedBefore: Date) =>
      sales.report(f.a, { placedFrom: from, placedBefore, interval: 'month', topProducts: 10 });
    expect(errorsOf(await report(from))).toEqual([['placedBefore', 'INVALID']]);
    expect(errorsOf(await report(after(367)))).toEqual([['placedBefore', 'INVALID']]);
    expect(unwrap(await report(after(366))).periods).toHaveLength(13);
  });
});
