import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import type { Tx } from '@hatti/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InventoryReportService } from './inventory-report.service.js';
import { inventoryFixture, unwrap, type InventoryFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Inventory reports (ANL-05, ADR-455)', () => {
  let f: InventoryFixture;
  let reports: InventoryReportService;

  beforeAll(async () => {
    f = await inventoryFixture(server!);
    reports = new InventoryReportService(f.db, f.variants);
    await f.reset();
  });

  afterAll(async () => {
    await f?.close();
  });

  it('says what sold of what there was, how long ago stock last sold, and what ran out', async () => {
    const warehouse = await f.location(f.a, 'Warehouse');
    const [small, medium] = await f.variantsOf(f.a, 'Lawn Kurta', ['S', 'M']);
    const [chappal] = await f.variantsOf(f.a, 'Peshawari Chappal');
    const shawl = unwrap(
      await f.products.create(f.a, {
        title: 'Khaddar Shawl',
        status: 'active',
        variants: [{ price: '1,000', cost: '400' }],
      }),
    ).variants[0]!.id;
    const set = (variantId: string, quantity: number) =>
      f.inventory.setQuantities(f.a, {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: variantId, locationId: warehouse.id, quantity }],
      });
    const sell = (variantId: string, quantity: number) =>
      f.db.tenant(f.a.shopId, (tx: Tx) =>
        f.stock.commit(tx, f.a, [{ variantId, locationId: warehouse.id, quantity }]),
      );
    /** What just happened to `variantId`, moved `days` days back. */
    const backdate = (variantId: string, days: number) =>
      f.admin.query(
        `UPDATE inventory.movements SET created_at = now() - make_interval(days => $2)
          WHERE variant_id = $1 AND created_at > now() - interval '1 minute'`,
        [variantId, days],
      );
    // Stocked long ago; six sold today of ten.
    unwrap(await set(small!, 10));
    await backdate(small!, 50);
    await sell(small!, 6);
    // Five sold ten days ago, all there were: out since.
    unwrap(await set(medium!, 5));
    await backdate(medium!, 50);
    await sell(medium!, 5);
    await backdate(medium!, 10);
    // One sold 45 days ago of three.
    unwrap(await set(chappal!, 3));
    await backdate(chappal!, 60);
    await sell(chappal!, 1);
    await backdate(chappal!, 45);
    // Never sold, at Rs 400 each.
    unwrap(await set(shawl, 8));
    await backdate(shawl, 100);

    const report = (sort: 'sell_through' | 'slowest' | 'stockouts') =>
      reports.report(f.a, { days: 30, sort, first: 50 });
    const best = await report('sell_through');
    expect(best).toMatchObject({
      days: 30,
      sold: 11,
      onHand: 26,
      // 11 sold of 11 and the 14 available now.
      sellThrough: 44,
      outNow: 1,
      ranOut: 1,
      ageing: [
        { bucket: 'days_0_30', variants: 2, units: 15, value: 0n, unitsWithoutCost: 15 },
        { bucket: 'days_31_60', variants: 1, units: 3, value: 0n, unitsWithoutCost: 3 },
        { bucket: 'days_61_90', variants: 0, units: 0, value: 0n, unitsWithoutCost: 0 },
        { bucket: 'over_90', variants: 0, units: 0, value: 0n, unitsWithoutCost: 0 },
        { bucket: 'never', variants: 1, units: 8, value: 3_200_00n, unitsWithoutCost: 0 },
      ],
    });
    const brief = (rows: typeof best.rows) =>
      rows.map((row) => [row.productTitle, row.variantTitle, row.sold, row.sellThrough]);
    expect(brief(best.rows)).toEqual([
      ['Lawn Kurta', 'M', 5, 100],
      ['Lawn Kurta', 'S', 6, 60],
    ]);
    const slowest = await report('slowest');
    expect(slowest.rows.map((row) => [row.productTitle, row.daysSinceSale, row.onHand])).toEqual([
      ['Khaddar Shawl', null, 8],
      ['Peshawari Chappal', 45, 3],
      ['Lawn Kurta', 10, 5],
      ['Lawn Kurta', 0, 10],
    ]);
    const out = await report('stockouts');
    expect(out.rows.map((row) => [row.variantTitle, row.daysOut, row.stockouts])).toEqual([
      ['M', 10, 1],
    ]);
    // Over a week, the kurta's sale ten days ago is before it: it was out all week.
    const week = await reports.report(f.a, { days: 7, sort: 'stockouts', first: 50 });
    expect(week.sold).toBe(6);
    expect(week.rows.map((row) => [row.variantTitle, row.daysOut, row.stockouts])).toEqual([
      ['M', 7, 0],
    ]);
    // As many as asked for; and nothing of another shop's.
    expect((await reports.report(f.a, { days: 30, sort: 'slowest', first: 1 })).rows).toHaveLength(
      1,
    );
    expect(await reports.report(f.b, { days: 30, sort: 'slowest', first: 50 })).toMatchObject({
      sold: 0,
      onHand: 0,
      sellThrough: null,
      outNow: 0,
      rows: [],
    });
  });

  it('counts what sold at the till, its last sale today (ADR-872)', async () => {
    await f.reset();
    const shop = await f.location(f.a, 'Shop');
    const [dupatta] = await f.variantsOf(f.a, 'Chiffon Dupatta');
    unwrap(
      await f.inventory.setQuantities(f.a, {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: dupatta!, locationId: shop.id, quantity: 4 }],
      }),
    );
    await f.db.tenant(f.a.shopId, (tx: Tx) =>
      f.stock.sell(tx, f.a, [{ variantId: dupatta!, locationId: shop.id, quantity: 3 }]),
    );
    const report = await reports.report(f.a, { days: 30, sort: 'sell_through', first: 50 });
    expect(report).toMatchObject({ sold: 3, onHand: 1 });
    expect(report.rows.map((row) => [row.productTitle, row.sold, row.daysSinceSale])).toEqual([
      ['Chiffon Dupatta', 3, 0],
    ]);
  });
});
