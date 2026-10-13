import 'reflect-metadata';
import type { Tx } from '@hatti/db';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PreorderService, pakistanDay, preordersIn } from './preorders.js';
import type { LocationRecord } from './records.js';
import { errorsOf, inventoryFixture, unwrap, type InventoryFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Pre-orders (CAT-14, ADR-403)', () => {
  let f: InventoryFixture;
  let preorders: PreorderService;
  let warehouse: LocationRecord;
  let store: LocationRecord;
  let variants: string[];
  let productId: string;
  const at = new Date('2026-10-13T20:00:00Z');
  /** Runs in its own transaction, as an order or a cart would. */
  const run = <T>(fn: (tx: Tx) => Promise<T>) => f.db.tenant(f.a.shopId, fn);

  beforeAll(async () => {
    f = await inventoryFixture(server!);
    preorders = new PreorderService(f.db, f.products);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    warehouse = await f.location(f.a, 'Warehouse');
    store = await f.location(f.a, 'Store');
    variants = await f.variantsOf(f.a, 'Eid lawn', ['S', 'M']);
    productId = (await run((tx) => f.variants.productIdsOf(tx, f.a.shopId, variants))).get(
      variants[0]!,
    )!;
    // One size counted out of stock, which sells no more; the other never counted.
    unwrap(
      await f.inventory.setQuantities(f.a, {
        name: 'on_hand',
        reason: 'received',
        quantities: [{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 0 }],
      }),
    );
  });

  it('counts days in Pakistan, five hours ahead of UTC', () => {
    expect(pakistanDay(at)).toBe('2026-10-14');
    expect(pakistanDay(new Date('2026-10-13T18:59:59Z'))).toBe('2026-10-13');
    expect(pakistanDay(at, 365)).toBe('2027-10-14');
  });

  it('sells a product on pre-order whatever its stock, and as its stock allows once off', async () => {
    const sellable = () => run((tx) => f.inventory.sellableOf(tx, f.a.shopId, variants));
    const available = () => run((tx) => f.inventory.availableOf(tx, f.a.shopId, variants));
    expect(await sellable()).toEqual(
      new Map([
        [variants[0], 0],
        [variants[1], null],
      ]),
    );
    expect((await available()).get(variants[0]!)).toBe(false);

    expect(unwrap(await preorders.set(f.a, productId, '2026-11-30', at))).toEqual({
      productId,
      shipsOn: '2026-11-30',
    });
    expect(await sellable()).toEqual(
      new Map([
        [variants[0], null],
        [variants[1], null],
      ]),
    );
    expect((await available()).get(variants[0]!)).toBe(true);
    // Its own policy is untouched: the item reads as it was, but on pre-order.
    expect(await f.inventory.item(f.a, variants[0]!)).toMatchObject({
      inventoryPolicy: 'deny',
      preorder: true,
    });
    // Orders commit it past its stock, wherever: a location without it is no shortage.
    const sold = await run((tx) =>
      f.stock.commit(tx, f.a, [
        { variantId: variants[0]!, locationId: warehouse.id, quantity: 3 },
        { variantId: variants[0]!, locationId: store.id, quantity: 1 },
      ]),
    );
    expect(sold.ok).toBe(true);
    const level = (await f.inventory.item(f.a, variants[0]!))!.levels.find(
      (each) => each.location.id === warehouse.id,
    );
    expect(level).toMatchObject({ committed: 3, available: -3 });
    // It rules no location out: an order of it and a dupatta, held at the store alone, ships
    // from the store; off pre-order, from the primary, where neither can be filled.
    const [dupatta] = await f.variantsOf(f.a, 'Dupatta');
    unwrap(
      await f.inventory.setQuantities(f.a, {
        name: 'on_hand',
        reason: 'received',
        quantities: [{ inventoryItemId: dupatta!, locationId: store.id, quantity: 4 }],
      }),
    );
    const from = async () =>
      (
        await run((tx) =>
          f.locations.forOrderIn(tx, f.a.shopId, [
            { variantId: variants[0]!, quantity: 9 },
            { variantId: dupatta!, quantity: 1 },
          ]),
        )
      ).id;
    expect(await from()).toBe(store.id);

    // Off pre-order: it sells as its stock allows again.
    expect(unwrap(await preorders.set(f.a, productId, null, at))).toBeNull();
    expect(await sellable()).toEqual(
      new Map([
        [variants[0], 0],
        [variants[1], null],
      ]),
    );
    expect(await from()).toBe(warehouse.id);
    const refused = await run((tx) =>
      f.stock.commit(tx, f.a, [{ variantId: variants[0]!, locationId: store.id, quantity: 1 }]),
    );
    expect(refused.ok).toBe(false);
  });

  it('keeps the day it ships by, tells of each change once, and goes with its product', async () => {
    unwrap(await preorders.set(f.a, productId, '2026-11-30', at));
    unwrap(await preorders.set(f.a, productId, '2026-11-30', at));
    unwrap(await preorders.set(f.a, productId, ' 2026-12-15 ', at));
    expect(await run((tx) => preordersIn(tx, f.a.shopId, [productId, newId()]))).toEqual(
      new Map([[productId, '2026-12-15']]),
    );
    expect(await preorders.of(f.b, [productId])).toEqual(new Map());
    unwrap(await preorders.set(f.a, productId, null, at));
    unwrap(await preorders.set(f.a, productId, null, at));
    const events = (await f.outbox()).filter(
      (event) => event.event_type === 'product_preorder.updated',
    );
    expect(events.map((event) => event.payload)).toEqual([
      { productId, shipsOn: '2026-11-30', before: null },
      { productId, shipsOn: '2026-12-15', before: '2026-11-30' },
      { productId, shipsOn: null, before: '2026-12-15' },
    ]);
    expect(events.every((event) => event.aggregate_id === productId)).toBe(true);

    unwrap(await preorders.set(f.a, productId, '2026-11-30', at));
    unwrap(await f.products.delete(f.a, productId));
    const { rows } = await f.admin.query('SELECT count(*)::int AS n FROM inventory.preorders');
    expect(rows[0].n).toBe(0);
  });

  it('refuses a day that is not one, gone by in Pakistan, or more than a year ahead', async () => {
    expect(errorsOf(await preorders.set(f.a, productId, '30/11/2026', at))).toEqual([
      ['shipsOn', 'INVALID'],
    ]);
    expect(errorsOf(await preorders.set(f.a, productId, '2026-02-30', at))).toEqual([
      ['shipsOn', 'INVALID'],
    ]);
    // Past 7 pm in UTC it is tomorrow in Pakistan: the 13th has gone by, the 14th is today.
    expect(errorsOf(await preorders.set(f.a, productId, '2026-10-13', at))).toEqual([
      ['shipsOn', 'INVALID'],
    ]);
    expect((await preorders.set(f.a, productId, '2026-10-14', at)).ok).toBe(true);
    expect(errorsOf(await preorders.set(f.a, productId, '2027-10-15', at))).toEqual([
      ['shipsOn', 'INVALID'],
    ]);
    // Another shop's product is not found.
    expect(errorsOf(await preorders.set(f.b, productId, '2026-11-30', at))).toEqual([
      ['productId', 'NOT_FOUND'],
    ]);
  });
});
