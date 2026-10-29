import 'reflect-metadata';
import { InventoryReportService } from '@hatti/inventory/public';
import { VariantService } from '@hatti/catalog/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { listAudit } from '@hatti/events';
import { xlsxRows } from '@hatti/xlsx/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOM_REPORT_LIMITS,
  CustomReportService,
  reportFilename,
  reportPeriodDays,
  type CustomReportInput,
} from './custom-reports.js';
import { SalesReportService } from './sales-report.service.js';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe('The days a custom report covers (ANL-06, ADR-817)', () => {
  // A Tuesday.
  const today = '2026-10-27';
  it.each([
    ['today', '2026-10-27', '2026-10-28'],
    ['yesterday', '2026-10-26', '2026-10-27'],
    ['last_7_days', '2026-10-20', '2026-10-27'],
    ['last_30_days', '2026-09-27', '2026-10-27'],
    ['last_90_days', '2026-07-29', '2026-10-27'],
    ['this_week', '2026-10-26', '2026-10-28'],
    ['last_week', '2026-10-19', '2026-10-26'],
    ['this_month', '2026-10-01', '2026-10-28'],
    ['last_month', '2026-09-01', '2026-10-01'],
    ['last_12_months', '2025-10-01', '2026-10-01'],
    ['this_year', '2026-01-01', '2026-10-28'],
  ] as const)('%s runs from %s to before %s', (period, fromDay, beforeDay) => {
    expect(reportPeriodDays(period, today)).toEqual({ fromDay, beforeDay });
  });

  it('starts a week on Monday, on a Sunday and on a Monday too', () => {
    expect(reportPeriodDays('this_week', '2026-11-01')).toEqual({
      fromDay: '2026-10-26',
      beforeDay: '2026-11-02',
    });
    expect(reportPeriodDays('last_week', '2026-10-26')).toEqual({
      fromDay: '2026-10-19',
      beforeDay: '2026-10-26',
    });
    expect(reportPeriodDays('last_month', '2026-01-15')).toEqual({
      fromDay: '2025-12-01',
      beforeDay: '2026-01-01',
    });
  });

  it("names a report's file in plain letters", () => {
    expect(reportFilename('Monthly sales — by channel!')).toBe('monthly-sales-by-channel');
    expect(reportFilename('ماہانہ')).toBe('report');
  });
});

describe.skipIf(!server)('Custom reports (ANL-06, ADR-817)', () => {
  let f: OrdersFixture;
  let reports: CustomReportService;
  let kurta: string;
  let shawl: string;

  const BY_DAY: CustomReportInput = {
    name: 'Daily net sales',
    breakdown: 'day',
    columns: ['net_sales', 'orders', 'profit'],
    period: 'last_month',
  };

  /** Places an order, then dates it as if placed at `at`. */
  async function placedAt(at: string, lineItems: string[], extra: Record<string, unknown> = {}) {
    const order = await f.order(f.a, lineItems, extra);
    await f.admin.query('UPDATE orders.orders SET created_at = $2 WHERE id = $1', [order.id, at]);
    return order;
  }

  beforeAll(async () => {
    f = await ordersFixture(server!);
    reports = new CustomReportService(
      f.db,
      new SalesReportService(f.db),
      new InventoryReportService(f.db, new VariantService(f.db)),
    );
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
    await f.admin.query('UPDATE catalog.variants SET cost = 120000 WHERE id = $1', [kurta]);
    // In Karachi: two kurtas on 29 September, Rs 500 off and Rs 250 for delivery, and a shawl
    // on the 30th; and a kurta in October, after the period.
    await placedAt('2026-09-29T10:00:00Z', [kurta, kurta], {
      discount: '500',
      shippingPrice: '250',
    });
    await placedAt('2026-09-30T10:00:00Z', [shawl]);
    await placedAt('2026-10-02T10:00:00Z', [kurta]);
  });

  it('is saved, changed, listed and deleted, its columns checked against its breakdown', async () => {
    const saved = unwrap(await reports.create(f.a, { ...BY_DAY, name: '  Daily net sales ' }));
    expect(saved).toMatchObject({ ...BY_DAY, id: expect.any(String) });
    const product = await reports.create(f.a, { ...BY_DAY, breakdown: 'product' });
    expect(errorsOf(product)).toEqual([['input.columns.0', 'INVALID']]);
    expect(!product.ok && product.errors[0]!.message).toBe(
      'A report of products has no column "net_sales"',
    );
    expect(errorsOf(await reports.create(f.a, { ...BY_DAY, columns: [] }))).toEqual([
      ['input.columns', 'BLANK'],
    ]);
    expect(errorsOf(await reports.create(f.a, { ...BY_DAY, name: ' ' }))).toEqual([
      ['input.name', 'BLANK'],
    ]);
    // The same column twice is shown once.
    const products = unwrap(
      await reports.update(f.a, saved.id, {
        name: 'Best sellers',
        breakdown: 'product',
        columns: ['units_sold', 'gross_profit', 'units_sold'],
        period: 'this_month',
      }),
    );
    expect(products.columns).toEqual(['units_sold', 'gross_profit']);
    unwrap(await reports.create(f.a, { ...BY_DAY, name: 'by channel', breakdown: 'source' }));
    expect((await reports.list(f.a)).map((each) => each.name)).toEqual([
      'Best sellers',
      'by channel',
    ]);
    // Another shop's is none of this one's.
    expect(await reports.get(f.b, saved.id)).toBeNull();
    expect(await reports.delete(f.b, saved.id)).toBe(false);
    expect(await reports.delete(f.a, saved.id)).toBe(true);
    expect(await reports.get(f.a, saved.id)).toBeNull();
    const audit = await f.db.tenant(f.a.shopId, (tx) => listAudit(tx, f.a.shopId, { first: 10 }));
    expect(audit.items.map((entry) => entry.action).sort()).toEqual([
      'custom_report.created',
      'custom_report.created',
      'custom_report.deleted',
      'custom_report.updated',
    ]);
  });

  it(`keeps ${CUSTOM_REPORT_LIMITS.perShop} a shop at most`, async () => {
    await f.admin.query(
      `INSERT INTO orders.custom_reports (shop_id, id, name, breakdown, columns, period)
       SELECT $1, gen_random_uuid(), 'Report ' || n, 'day', '{orders}', 'today'
         FROM generate_series(1, $2::int) n`,
      [f.a.shopId, CUSTOM_REPORT_LIMITS.perShop],
    );
    expect(errorsOf(await reports.create(f.a, BY_DAY))).toEqual([['input', 'TOO_MANY']]);
  });

  it("runs over its period as of the day, in the shop's time, its columns in its order", async () => {
    const at = new Date('2026-10-05T08:00:00Z');
    expect(await reports.periodOf(f.a.shopId, 'last_month', at)).toEqual({
      placedFrom: new Date('2026-09-01T00:00:00+05:00'),
      placedBefore: new Date('2026-10-01T00:00:00+05:00'),
    });
    const daily = unwrap(await reports.run(f.a, BY_DAY, true, at));
    expect(daily.columns).toEqual([
      { key: 'net_sales', title: 'Net sales', kind: 'amount' },
      { key: 'orders', title: 'Orders', kind: 'number' },
      { key: 'profit', title: 'Profit', kind: 'amount' },
    ]);
    expect(daily.rows).toHaveLength(30);
    expect(daily.rows.slice(28)).toEqual([
      { key: null, label: '2026-09-29', values: [3_500_00n, 1, 1_350_00n] },
      { key: null, label: '2026-09-30', values: [5_000_00n, 1, 5_000_00n] },
    ]);
    expect(daily.totals).toEqual([8_500_00n, 2, 6_350_00n]);

    // Without true profit on the plan, its lines are left out.
    expect(unwrap(await reports.run(f.a, BY_DAY, false, at)).columns.map((c) => c.key)).toEqual([
      'net_sales',
      'orders',
    ]);

    // By product, over a period given, as a schedule gives one.
    const over = {
      placedFrom: new Date('2026-09-01T00:00:00+05:00'),
      placedBefore: new Date('2026-11-01T00:00:00+05:00'),
    };
    const byProduct = unwrap(
      await reports.run(
        f.a,
        { breakdown: 'product', columns: ['units_sold', 'gross_profit'], period: 'today' },
        true,
        at,
        over,
      ),
    );
    expect(byProduct.rows.map(({ label, values }) => [label, ...values])).toEqual([
      ['Kurta', 3, 2_400_00n],
      ['Pashmina Shawl', 1, 5_000_00n],
    ]);
    expect(byProduct.totals).toBeNull();

    const byChannel = unwrap(
      await reports.run(
        f.a,
        {
          breakdown: 'source',
          columns: ['orders', 'net_sales', 'gross_profit', 'gross_margin'],
          period: 'today',
        },
        true,
        at,
        over,
      ),
    );
    // The fixture's orders come through an app.
    expect(byChannel.rows).toEqual([
      { key: 'api', label: 'Apps', values: [3, 10_500_00n, 6_900_00n, 0.6571] },
    ]);

    // By city and by customer (ADR-909): the fixture's orders all go to Ayesha in Karachi.
    const byCity = unwrap(
      await reports.create(f.a, { ...BY_DAY, name: 'by city', breakdown: 'city' }),
    );
    const cities = unwrap(await reports.run(f.a, byCity, true, at, over));
    expect(cities.rows).toEqual([
      { key: 'Karachi', label: 'Karachi', values: [10_500_00n, 3, 7_150_00n] },
    ]);
    const customers = unwrap(
      await reports.run(f.a, { ...BY_DAY, breakdown: 'customer' }, true, at, over),
    );
    expect(customers.rows.map(({ label, values }) => [label, ...values])).toEqual([
      ['Ayesha Khan', 10_500_00n, 3, 7_150_00n],
    ]);
  });

  it("reports each variant's stock, and what sold of it over the period (ADR-910)", async () => {
    // Its columns are stock's own.
    expect(
      errorsOf(
        await reports.create(f.a, { ...BY_DAY, breakdown: 'stock', columns: ['net_sales'] }),
      ),
    ).toEqual([['input.columns.0', 'INVALID']]);
    const report = unwrap(
      await reports.create(f.a, {
        name: 'Stock',
        breakdown: 'stock',
        columns: ['on_hand', 'available', 'units_sold', 'sell_through', 'unit_cost', 'stock_value'],
        period: 'today',
      }),
    );
    // The stock moved as the orders were placed, now; their dates aside.
    const at = new Date();
    const over = {
      placedFrom: new Date(at.getTime() - 86_400_000),
      placedBefore: new Date(at.getTime() + 86_400_000),
    };
    const stock = unwrap(await reports.run(f.a, report, true, at, over));
    expect(stock.columns.map((column) => [column.key, column.kind])).toEqual([
      ['on_hand', 'number'],
      ['available', 'number'],
      ['units_sold', 'number'],
      ['sell_through', 'ratio'],
      ['unit_cost', 'amount'],
      ['stock_value', 'amount'],
    ]);
    // Three kurtas and a shawl ordered, not yet shipped: on hand still, but not available.
    expect(stock.rows).toEqual([
      { key: kurta, label: 'Kurta', values: [50, 47, 3, 0.06, 1_200_00n, 60_000_00n] },
      { key: shawl, label: 'Pashmina Shawl', values: [50, 49, 1, 0.02, null, null] },
    ]);
    expect(stock.totals).toEqual([100, null, 4, 0.04, null, 60_000_00n]);

    // Over a period before any of it moved, nothing sold.
    const before = { placedFrom: new Date('2026-01-01'), placedBefore: new Date('2026-02-01') };
    const then = unwrap(await reports.run(f.a, report, true, at, before));
    expect(then.rows.map((row) => row.values[2])).toEqual([0, 0]);
  });

  it('exports a report as a workbook of one sheet, its total last', async () => {
    const saved = unwrap(await reports.create(f.a, { ...BY_DAY, name: 'Daily / net: sales' }));
    const at = new Date('2026-10-05T08:00:00Z');
    const file = unwrap(await reports.export(f.a, saved.id, true, at));
    expect(file.filename).toBe('daily-net-sales.xlsx');
    expect(file.contentType).toMatch(/spreadsheetml/);
    const [header, ...rows] = xlsxRows(file.content);
    expect(header).toEqual(['Day', 'Net sales', 'Orders', 'Profit']);
    expect(rows.slice(28)).toEqual([
      ['2026-09-29', 3500, 1, 1350],
      ['2026-09-30', 5000, 1, 5000],
      ['Total', 8500, 2, 6350],
    ]);
    expect(errorsOf(await reports.export(f.b, saved.id, true, at))).toEqual([['id', 'NOT_FOUND']]);
    const audit = await f.db.tenant(f.a.shopId, (tx) => listAudit(tx, f.a.shopId, { first: 10 }));
    expect(audit.items.find((entry) => entry.action === 'custom_report.exported')).toMatchObject({
      action: 'custom_report.exported',
      details: {
        placedFrom: '2026-08-31T19:00:00.000Z',
        placedBefore: '2026-09-30T19:00:00.000Z',
      },
    });
  });
});
