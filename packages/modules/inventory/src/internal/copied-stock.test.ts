import 'reflect-metadata';
import { ProductService } from '@hatti/catalog/public';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InventoryCopiedVariantStock } from './copied-stock.js';
import { availableForSale } from './item-store.js';
import { inventoryFixture, unwrap, type InventoryFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("A duplicated product's stock settings (ADR-343)", () => {
  let f: InventoryFixture;

  beforeAll(async () => {
    f = await inventoryFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  it('copies each variant tracked or not and selling on or not, with none of its stock', async () => {
    const warehouse = await f.location(f.a, 'Warehouse');
    const product = unwrap(
      await f.products.create(f.a, {
        title: 'Chappal',
        options: [{ name: 'Size', values: ['8', '9', '10'] }],
      }),
    );
    const [eight, nine] = product.variants.map((variant) => variant.id);
    // 8 has five in stock; 9 is tracked and sells on at none; 10 was never stocked.
    unwrap(
      await f.inventory.setQuantities(f.a, {
        name: 'available',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: eight!, locationId: warehouse.id, quantity: 5 }],
      }),
    );
    unwrap(
      await f.inventory.updateItem(f.a, nine!, { tracked: true, inventoryPolicy: 'continue' }),
    );

    const products = new ProductService(f.db, new InventoryCopiedVariantStock());
    const copy = unwrap(
      await products.duplicate(f.a, { productId: product.id, newTitle: 'Chappal - Black' }),
    );
    const [copied8, copied9, copied10] = await Promise.all(
      copy.variants.map(async (variant) => (await f.inventory.item(f.a, variant.id))!),
    );
    expect(copied8).toMatchObject({ tracked: true, inventoryPolicy: 'deny', levels: [] });
    // Sold out until its stock is set.
    expect(availableForSale(copied8!)).toBe(false);
    expect(copied9).toMatchObject({ tracked: true, inventoryPolicy: 'continue', levels: [] });
    expect(availableForSale(copied9!)).toBe(true);
    expect(copied10).toMatchObject({ tracked: false, levels: [] });

    // The product's own stock is as it was, and the other shop has none of it.
    expect((await f.inventory.item(f.a, eight!))!.levels).toHaveLength(1);
    expect(await f.inventory.item(f.b, copy.variants[0]!.id)).toBeNull();
  });
});
