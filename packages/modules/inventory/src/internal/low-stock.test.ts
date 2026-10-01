import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LowStockService } from './low-stock.service.js';
import { errorsOf, inventoryFixture, unwrap, type InventoryFixture } from './test-support.js';

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
    await f.admin.query('DELETE FROM inventory.settings');
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
    expect(await lowStock.settings(f.a)).toEqual({ lowStockThreshold: 5, updatedAt: null });
    const changed = unwrap(await lowStock.updateSettings(f.a, { lowStockThreshold: 3 }));
    expect(changed.lowStockThreshold).toBe(3);
    // The same again, or nothing given, changes nothing.
    expect(unwrap(await lowStock.updateSettings(f.a, { lowStockThreshold: 3 }))).toEqual(changed);
    expect(unwrap(await lowStock.updateSettings(f.a, {}))).toEqual(changed);
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
    ).toEqual([{ changed: ['lowStockThreshold'], lowStockThreshold: 3, version: 1 }]);
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
});
