import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tx } from '@hatti/db';
import { addDays, pkSeasonsOf, previousPkSeason } from '@hatti/pk';
import {
  LowStockService,
  daysLeft,
  forecastUnits,
  runsOutOn,
  weeklyForecast,
  liftOf,
  seasonAhead,
  type SeasonOutlook,
} from './low-stock.service.js';
import { errorsOf, inventoryFixture, unwrap, type InventoryFixture } from './test-support.js';

describe('The season a forecast counts on (ADR-891)', () => {
  const at = (day: string) => seasonAhead(new Date(`${day}T07:00:00Z`));

  it("is the one on, the moon's where two meet, else the next within 90 days", () => {
    // Ramadan 1447 fell in the 2026 lawn launch: Ramadan is what shoppers bought for.
    expect(at('2026-03-01')).toMatchObject({ key: 'ramadan', moon: true });
    // Before Ramadan, the lawn launch on.
    expect(at('2026-02-16')).toMatchObject({ key: 'summer_lawn' });
    // Winter weddings, from last November.
    expect(at('2027-01-10')).toMatchObject({ key: 'wedding_season', start: '2026-11-01' });
    // In July, the run-up to Independence Day is next.
    expect(at('2026-07-10')).toMatchObject({ key: 'independence_day', start: '2026-08-01' });
  });
});

const server = testDatabaseServer();

describe.skipIf(!server)('Low stock', () => {
  let f: InventoryFixture;
  let lowStock: LowStockService;

  beforeAll(async () => {
    f = await inventoryFixture(server!);
    lowStock = new LowStockService(f.db, f.variants);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM inventory.settings; DELETE FROM inventory.low_stock_spells');
  });

  /** An active product's variants, one a size. */
  const sold = async (title: string, sizes: string[], status = 'active') =>
    unwrap(
      await f.products.create(f.a, {
        title,
        status: status as 'active',
        options: [{ name: 'Size', values: sizes }],
      }),
    ).variants.map((variant) => variant.id);

  it('keeps what the shop calls low: five until it says otherwise (ADR-125)', async () => {
    expect(await lowStock.settings(f.a)).toEqual({
      lowStockThreshold: 5,
      splitOrders: false,
      updatedAt: null,
    });
    const changed = unwrap(await lowStock.updateSettings(f.a, { lowStockThreshold: 3 }));
    expect(changed.lowStockThreshold).toBe(3);
    // The same again, or nothing given, changes nothing.
    expect(unwrap(await lowStock.updateSettings(f.a, { lowStockThreshold: 3 }))).toEqual(changed);
    expect(unwrap(await lowStock.updateSettings(f.a, {}))).toEqual(changed);
    // Orders split among locations once turned on (ADR-898); the threshold stays.
    expect(unwrap(await lowStock.updateSettings(f.a, { splitOrders: true }))).toMatchObject({
      lowStockThreshold: 3,
      splitOrders: true,
    });
    expect((await lowStock.settings(f.b)).splitOrders).toBe(false);
    for (const [threshold, code] of [
      [-1, 'INVALID'],
      [10_001, 'INVALID'],
      [2.5, 'INVALID'],
      [null, 'BLANK'],
    ] as const) {
      expect(
        errorsOf(await lowStock.updateSettings(f.a, { lowStockThreshold: threshold })),
      ).toEqual([['input.lowStockThreshold', code]]);
    }
    expect((await lowStock.settings(f.b)).lowStockThreshold).toBe(5);
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'inventory_settings.updated')
        .map((event) => event.payload),
    ).toEqual([
      { changed: ['lowStockThreshold'], lowStockThreshold: 3, version: 1 },
      { changed: ['splitOrders'], lowStockThreshold: 3, splitOrders: true, version: 2 },
    ]);
  });

  it('counts and lists the variants running low or out, the fewest first', async () => {
    const warehouse = await f.location(f.a, 'Warehouse');
    const store = await f.location(f.a, 'Store', { fulfillsOnlineOrders: false });
    const [small, medium, large] = await sold('Lawn Kurta', ['S', 'M', 'L']);
    const [eight, nine] = await sold('Peshawari Chappal', ['8', '9']);
    const [draftOnly] = await sold('Khaddar Shawl', ['One size'], 'draft');
    const set = (variantId: string, quantity: number, location = warehouse) =>
      f.inventory.setQuantities(f.a, {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity }],
      });
    unwrap(await set(small!, 0));
    unwrap(await set(medium!, 4));
    unwrap(await set(large!, 30));
    unwrap(await set(eight!, 5));
    // Plenty at a store that sells in person, none for sale online.
    unwrap(await set(nine!, 40, store));
    // A draft's stock is no one's to reorder yet.
    unwrap(await set(draftOnly!, 0));

    // Five or fewer for sale online: small, nine and eight; the medium has some left.
    expect(await lowStock.counts(f.a)).toEqual({ threshold: 5, low: 2, out: 2 });
    const list = await lowStock.list(f.a, { first: 10 });
    // The fewest first; a tie goes by variant, the first made first.
    expect(list.items.map((item) => [item.variantTitle, item.available])).toEqual([
      ['S', 0],
      ['9', 0],
      ['M', 4],
      ['8', 5],
    ]);
    expect(list.items[0]).toMatchObject({ productTitle: expect.any(String), sku: null });

    // A page at a time, the fewest first, then by variant.
    const first = await lowStock.list(f.a, { first: 2 });
    expect(first.hasNextPage).toBe(true);
    const last = first.items.at(-1)!;
    const next = await lowStock.list(f.a, {
      first: 10,
      after: { available: last.available, variantId: last.variantId },
    });
    expect([...first.items, ...next.items]).toEqual(list.items);
    expect(next.hasNextPage).toBe(false);

    // A lower threshold: the medium is no longer low.
    unwrap(await lowStock.updateSettings(f.a, { lowStockThreshold: 3 }));
    expect(await lowStock.counts(f.a)).toEqual({ threshold: 3, low: 0, out: 2 });
    expect(await lowStock.counts(f.b)).toEqual({ threshold: 5, low: 0, out: 0 });
  });

  it('lists what runs low at one location, among what it stocked before (ADR-359)', async () => {
    const warehouse = await f.location(f.a, 'Warehouse');
    const store = await f.location(f.a, 'Store', { fulfillsOnlineOrders: false });
    const [small, medium] = await sold('Lawn Kurta', ['S', 'M']);
    const [eight] = await sold('Peshawari Chappal', ['8']);
    const set = (variantId: string, quantity: number, location = warehouse) =>
      f.inventory.setQuantities(f.a, {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity }],
      });
    unwrap(await set(small!, 40));
    unwrap(await set(small!, 2, store));
    unwrap(await set(medium!, 1));
    unwrap(await set(medium!, 30, store));
    // The chappal was never at the store: not the store's to reorder.
    unwrap(await set(eight!, 0));

    const at = async (locationId: string) =>
      (await lowStock.list(f.a, { first: 10, locationId })).items.map((item) => [
        item.variantTitle,
        item.available,
        item.locationId,
      ]);
    expect(await at(store.id)).toEqual([['S', 2, store.id]]);
    expect(await at(warehouse.id)).toEqual([
      ['8', 0, warehouse.id],
      ['M', 1, warehouse.id],
    ]);
    // Online, the store's units are not for sale: the medium runs low there alone.
    expect(
      (await lowStock.list(f.a, { first: 10 })).items.map((item) => [
        item.variantTitle,
        item.locationId,
      ]),
    ).toEqual([
      ['8', null],
      ['M', null],
    ]);
    unwrap(await f.locations.deactivate(f.a, (await f.location(f.a, 'Closed')).id));
    expect((await lowStock.list(f.b, { first: 10, locationId: store.id })).items).toEqual([]);
  });

  it('says what each sold in the last 30 days, and how long its stock lasts (ADR-368)', async () => {
    const warehouse = await f.location(f.a, 'Warehouse');
    const store = await f.location(f.a, 'Store');
    const [small, medium] = await sold('Lawn Kurta', ['S', 'M']);
    const set = (variantId: string, quantity: number, location = warehouse) =>
      f.inventory.setQuantities(f.a, {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity }],
      });
    unwrap(await set(small!, 30));
    unwrap(await set(small!, 10, store));
    unwrap(await set(medium!, 5));
    const line = (variantId: string, quantity: number, location = warehouse) => ({
      variantId,
      locationId: location.id,
      quantity,
    });
    const run = <T>(fn: (tx: Tx) => Promise<T>) => f.db.tenant(f.a.shopId, fn);
    // Sold before the last 30 days: not counted.
    await run((tx) => f.stock.commit(tx, f.a, [line(small!, 4)]));
    await f.admin.query(`UPDATE inventory.movements SET created_at = now() - interval '40 days'`);
    await run((tx) => f.stock.commit(tx, f.a, [line(small!, 6), line(medium!, 3)]));
    await run((tx) => f.stock.commit(tx, f.a, [line(small!, 2, store)]));
    // Shipping moves units out of committed: not sold again. A cancelled order's are not sold.
    await run((tx) => f.stock.fulfill(tx, f.a, [line(small!, 6)]));
    await run((tx) => f.stock.releaseCommitment(tx, f.a, [line(medium!, 1)]));

    const ids = [small!, medium!];
    expect(await lowStock.soldOf(f.a, ids, null)).toEqual(
      new Map([
        [small!, 8],
        [medium!, 2],
      ]),
    );
    expect(await lowStock.soldOf(f.a, ids, store.id)).toEqual(new Map([[small!, 2]]));
    expect(await lowStock.soldOf(f.a, [], null)).toEqual(new Map());
    expect(await lowStock.soldOf(f.b, ids, null)).toEqual(new Map());
    // Ten for sale at eight a month last 37 days; none lasts none; no pace with none sold.
    expect([daysLeft(10, 8), daysLeft(0, 5), daysLeft(-2, 5), daysLeft(5, 0)]).toEqual([
      37,
      0,
      0,
      null,
    ]);
  });

  it("tells how much faster each variant sold in last year's Ramadan, or the shop's stock did (ADR-863)", async () => {
    const warehouse = await f.location(f.a, 'Warehouse');
    const [small, medium, large] = await sold('Eid Kurta', ['S', 'M', 'L']);
    for (const variant of [small!, medium!, large!]) {
      unwrap(
        await f.inventory.setQuantities(f.a, {
          name: 'available',
          reason: 'cycle_count_available',
          quantities: [{ inventoryItemId: variant, locationId: warehouse.id, quantity: 500 }],
        }),
      );
    }
    const ramadan = pkSeasonsOf(2027).find((each) => each.key === 'ramadan')!;
    const last = previousPkSeason(ramadan)!;
    const commitOn = async (variantId: string, quantity: number, day: string) => {
      await f.db.tenant(f.a.shopId, (tx) =>
        f.stock.commit(tx, f.a, [{ variantId, locationId: warehouse.id, quantity }]),
      );
      await f.admin.query(
        `UPDATE inventory.movements SET created_at = ($1::date + time '12:00') AT TIME ZONE 'Asia/Karachi'
          WHERE created_at > now() - interval '1 minute'`,
        [day],
      );
    };
    // The small sold 6 in the 30 days before last Ramadan, and 33 through it: some 5 times faster.
    await commitOn(small!, 6, addDays(last.start, -10));
    await commitOn(small!, 33, addDays(last.start, 5));
    // The medium sold through it alone; the large not at all.
    await commitOn(medium!, 4, addDays(last.start, 2));
    const days = Math.round((Date.parse(last.end) - Date.parse(last.start)) / 86_400_000) + 1;

    const lifts = await lowStock.seasonLifts(f.a, [small!, medium!, large!], null, ramadan);
    expect(lifts.variants).toEqual(new Map([[small!, liftOf(33, days, 6)]]));
    expect(lifts.variants.get(small!)! > 4).toBe(true);
    expect(lifts.shop).toBe(liftOf(37, days, 6));
    expect(await lowStock.seasonLifts(f.b, [small!], null, ramadan)).toEqual({
      shop: null,
      variants: new Map(),
    });
  });

  it('forecasts the coming days at the pace sold, and faster on the days of a season ahead', () => {
    expect([liftOf(30, 30, 10), liftOf(0, 30, 10), liftOf(10, 30, 0), liftOf(1000, 30, 1)]).toEqual(
      [3, null, null, 8],
    );
    expect(liftOf(1, 30, 30)).toBe(0.25);
    const season = { key: 'ramadan' as const, start: '2027-02-08', end: '2027-03-12', moon: true };
    const outlook: SeasonOutlook = { season, lift: 3, fromShop: false };
    // 30 sold in 30 days: 30 more without a season; in 30 days of which 21 are in it, 9 + 63.
    expect(forecastUnits(30, 30, '2027-01-01', null)).toBe(30);
    expect(forecastUnits(30, 30, '2027-01-30', outlook)).toBe(72);
    expect(forecastUnits(30, 30, '2027-01-30', { ...outlook, lift: null })).toBe(30);
    expect(forecastUnits(0, 30, '2027-01-30', outlook)).toBe(0);
  });

  it('forecasts week by week, adding up to the whole, and the day what is for sale runs out (ADR-893)', () => {
    const season = { key: 'ramadan' as const, start: '2027-02-08', end: '2027-03-12', moon: true };
    const outlook: SeasonOutlook = { season, lift: 3, fromShop: false };
    // 30 a month is one a day; from 1 February Ramadan begins on the eighth day, at three a day.
    expect(weeklyForecast(30, 40, '2027-02-01', outlook, 3)).toEqual([
      { startsOn: '2027-02-01', units: 7, left: 33 },
      { startsOn: '2027-02-08', units: 21, left: 12 },
      { startsOn: '2027-02-15', units: 21, left: 0 },
    ]);
    const weeks = weeklyForecast(10, 100, '2027-01-01', null, 13);
    expect(weeks.reduce((sum, week) => sum + week.units, 0)).toBe(
      forecastUnits(10, 91, '2027-01-01', null),
    );
    expect(weeks.map((week) => week.units).slice(0, 4)).toEqual([3, 2, 2, 3]);
    expect(weeklyForecast(0, 5, '2027-01-01', null, 2).map((week) => week.left)).toEqual([5, 5]);
    // Seven of 40 sell in the first week, then three a day: the last on 18 February.
    expect(runsOutOn(30, 40, '2027-02-01', outlook)).toBe('2027-02-18');
    expect(runsOutOn(30, 40, '2027-02-01', null)).toBe('2027-03-12');
    expect(runsOutOn(30, 0, '2027-02-01', null)).toBe('2027-02-01');
    expect(runsOutOn(0, 4, '2027-02-01', null)).toBeNull();
    expect(runsOutOn(1, 40, '2027-02-01', null)).toBeNull();
  });

  it('alerts once a spell when a variant falls to the threshold, and once more when it runs out (ADR-157)', async () => {
    const warehouse = await f.location(f.a, 'Warehouse');
    const [small] = await sold('Lawn Kurta', ['S']);
    const [shawl] = await sold('Khaddar Shawl', ['One size'], 'draft');
    const set = (variantId: string, quantity: number) =>
      f.inventory.setQuantities(f.a, {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: variantId, locationId: warehouse.id, quantity }],
      });
    const alertOf = (variantId = small!) =>
      f.db.tenant(f.a.shopId, (tx) => lowStock.alertIn(tx, f.a.shopId, variantId));
    const spells = async () =>
      (
        await f.admin.query<{ state: string; available: number }>(
          'SELECT state, available FROM inventory.low_stock_spells WHERE variant_id = $1',
          [small],
        )
      ).rows;

    unwrap(await set(small!, 20));
    expect(await alertOf()).toBeNull();
    unwrap(await set(small!, 4));
    const low = await alertOf();
    expect(low).toMatchObject({
      variantId: small,
      productTitle: 'Lawn Kurta',
      variantTitle: 'S',
      available: 4,
      state: 'low',
      threshold: 5,
    });
    // Heard again, or lower still: told once.
    expect(await alertOf()).toBeNull();
    unwrap(await set(small!, 2));
    expect(await alertOf()).toBeNull();
    expect(await spells()).toEqual([{ state: 'low', available: 2 }]);
    // Out: told once more, in the same spell.
    unwrap(await set(small!, 0));
    expect(await alertOf()).toMatchObject({ state: 'out', available: 0, since: low!.since });
    expect(await alertOf()).toBeNull();
    // A little back, still low: nothing; stocked above the threshold, the spell ends.
    unwrap(await set(small!, 3));
    expect(await alertOf()).toBeNull();
    unwrap(await set(small!, 12));
    expect(await alertOf()).toBeNull();
    expect(await spells()).toEqual([]);
    // Falling again is a spell of its own, told again.
    unwrap(await set(small!, 5));
    const again = await alertOf();
    expect(again?.state).toBe('low');
    expect(again!.since.getTime()).toBeGreaterThan(low!.since.getTime());
    // A product not for sale tells nothing.
    unwrap(await set(shawl!, 0));
    expect(await alertOf(shawl)).toBeNull();
    // Each alert recorded for the shop's workflows on stock (ADR-905): low, out, and low again.
    const alerted = (await f.outbox()).filter((row) => row.event_type === 'stock.alerted');
    expect(alerted.map((row) => (row.payload as { state: string }).state)).toEqual([
      'low',
      'out',
      'low',
    ]);
    expect(alerted[0]!.payload).toEqual({
      productId: low!.productId,
      state: 'low',
      available: 4,
      threshold: 5,
      productTitle: 'Lawn Kurta',
      variantTitle: 'S',
      sku: low!.sku,
    });
  });

  it("counts units checkouts hold as the shop's still: a hold begins no spell (ADR-715)", async () => {
    const warehouse = await f.location(f.a, 'Warehouse');
    const [small] = await sold('Lawn Kurta', ['S']);
    unwrap(
      await f.inventory.setQuantities(f.a, {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: small!, locationId: warehouse.id, quantity: 8 }],
      }),
    );
    const held = [{ variantId: small!, locationId: warehouse.id, quantity: 6 }];
    const alertOf = () => f.db.tenant(f.a.shopId, (tx) => lowStock.alertIn(tx, f.a.shopId, small!));
    // Two for sale to others while six are held, but none of the eight sold: no alert.
    await f.db.tenant(f.a.shopId, (tx) => f.stock.reserve(tx, f.a, held));
    expect(await alertOf()).toBeNull();
    // Sold, they are gone: then it runs low.
    await f.db.tenant(f.a.shopId, (tx) => f.stock.commit(tx, f.a, held, { fromReservation: true }));
    expect(await alertOf()).toMatchObject({ state: 'low', available: 2 });
  });
});
