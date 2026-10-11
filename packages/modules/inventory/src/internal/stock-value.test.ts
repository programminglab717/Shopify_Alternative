import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StockValueService } from './stock-value.service.js';
import { inventoryFixture, unwrap, type InventoryFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('What the stock is worth (ADR-369)', () => {
  let f: InventoryFixture;
  let values: StockValueService;

  beforeAll(async () => {
    f = await inventoryFixture(server!);
    values = new StockValueService(f.db, f.variants);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  it('values units on hand at what each costs, by location, the most first', async () => {
    const warehouse = await f.location(f.a, 'Warehouse');
    const store = await f.location(f.a, 'Store');
    const [small, medium, large] = await f.variantsOf(f.a, 'Lawn suit', ['S', 'M', 'L']);
    const [chappal] = await f.variantsOf(f.a, 'Peshawari Chappal', ['9']);
    const set = (variantId: string, location: { id: string }, quantity: number) =>
      f.inventory.setQuantities(f.a, {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity }],
      });
    unwrap(await set(small!, warehouse, 10));
    unwrap(await set(medium!, warehouse, 4));
    unwrap(await set(small!, store, 3));
    // None on hand is worth nothing.
    unwrap(await set(large!, store, 0));
    // No cost given: counted, not valued.
    unwrap(await set(chappal!, store, 5));
    await f.db.tenant(f.a.shopId, (tx) =>
      f.variants.setCostsIn(
        tx,
        f.a.shopId,
        new Map([
          [small!, 150_000n],
          [medium!, 162_550n],
          [large!, 150_000n],
        ]),
      ),
    );

    const worth = await values.value(f.a);
    expect({
      ...worth,
      locations: worth.locations.map(({ location, ...rest }) => ({ name: location.name, ...rest })),
    }).toEqual({
      units: 22,
      unitsWithoutCost: 5,
      value: 10n * 150_000n + 4n * 162_550n + 3n * 150_000n,
      locations: [
        { name: 'Warehouse', units: 14, unitsWithoutCost: 0, value: 2_150_200n },
        { name: 'Store', units: 8, unitsWithoutCost: 5, value: 450_000n },
      ],
    });

    // Untracked stock is not counted; another shop has none of it.
    unwrap(await f.inventory.updateItem(f.a, medium!, { tracked: false }));
    expect((await values.value(f.a)).locations[0]).toMatchObject({ units: 10, value: 1_500_000n });
    expect(await values.value(f.b)).toEqual({
      units: 0,
      unitsWithoutCost: 0,
      value: 0n,
      locations: [],
    });
  });
});
