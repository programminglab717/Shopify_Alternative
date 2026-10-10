import 'reflect-metadata';
import { pgError } from '@hatti/db';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdjustQuantitiesInput,
  InventoryMoveInput,
  SetQuantitiesInput,
} from './inventory.service.js';
import { availableForSale, sellableQuantity, untrackedItem } from './item-store.js';
import type { LocationRecord } from './records.js';
import { LIMITS } from './rules.js';
import { adjustments, items, levels, locations, movements } from './schema.js';
import { errorsOf, inventoryFixture, unwrap, type InventoryFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('InventoryService', () => {
  let f: InventoryFixture;
  let warehouse: LocationRecord;
  let store: LocationRecord;
  let variants: string[];

  const set = (
    quantities: SetQuantitiesInput['quantities'],
    extra: Partial<SetQuantitiesInput> = {},
  ) =>
    f.inventory.setQuantities(f.a, {
      name: 'available',
      reason: 'cycle_count_available',
      quantities,
      ...extra,
    });
  const adjust = (
    changes: AdjustQuantitiesInput['changes'],
    extra: Partial<AdjustQuantitiesInput> = {},
  ) =>
    f.inventory.adjustQuantities(f.a, { name: 'available', reason: 'received', changes, ...extra });
  const move = (variantId: string, quantity: number, from: LocationRecord, to: LocationRecord) => ({
    inventoryItemId: variantId,
    quantity,
    from: { locationId: from.id, name: 'available' },
    to: { locationId: to.id, name: 'available' },
  });
  const moveAll = (changes: InventoryMoveInput[]) =>
    f.inventory.moveQuantities(f.a, { reason: 'movement_created', changes });
  const item = async (variantId: string) => (await f.inventory.item(f.a, variantId))!;
  const levelAt = async (variantId: string, location: LocationRecord) =>
    (await item(variantId)).levels.find((level) => level.location.id === location.id);

  beforeAll(async () => {
    f = await inventoryFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    warehouse = await f.location(f.a, 'Warehouse');
    store = await f.location(f.a, 'Store', { fulfillsOnlineOrders: false });
    variants = await f.variantsOf(f.a, 'Chappal', ['8', '9', '10']);
    await f.admin.query('DELETE FROM platform.outbox_events');
  });

  it('matches the migrated tables', async () => {
    // Drizzle names every column, so a mismatch with the SQL migrations fails here.
    await f.db.tenant(f.a.shopId, async (tx) => {
      for (const table of [locations, items, levels, adjustments, movements]) {
        await tx.select().from(table).limit(0);
      }
    });
  });

  it('reads a variant whose stock was never recorded as untracked and stocked nowhere', async () => {
    expect(await f.inventory.item(f.a, variants[0]!)).toEqual(untrackedItem(variants[0]!));
    expect(await f.inventory.itemsOf(f.a, variants)).toEqual(new Map());
    expect(await f.inventory.item(f.a, newId())).toBeNull();
    expect(availableForSale(untrackedItem(variants[0]!))).toBe(true);
  });

  it('sets quantities after a stock count, which starts tracking', async () => {
    const group = unwrap(
      await set(
        [
          { inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 10 },
          { inventoryItemId: variants[1]!, locationId: warehouse.id, quantity: 5 },
        ],
        { referenceDocumentUri: 'https://erp.example.com/counts/42' },
      ),
    )!;
    expect(group).toMatchObject({
      reason: 'cycle_count_available',
      referenceDocumentUri: 'https://erp.example.com/counts/42',
    });
    expect(
      group.changes.map((change) => [
        change.variantId,
        change.name,
        change.delta,
        change.quantityAfter,
      ]),
    ).toEqual([
      [variants[0], 'on_hand', 10, 10],
      [variants[1], 'on_hand', 5, 5],
    ]);
    expect(group.changes[0]!.location.name).toBe('Warehouse');

    const first = await item(variants[0]!);
    expect(first).toMatchObject({ tracked: true, inventoryPolicy: 'deny' });
    expect(first.levels).toMatchObject([
      {
        location: { name: 'Warehouse' },
        onHand: 10,
        committed: 0,
        reserved: 0,
        safetyStock: 0,
        available: 10,
      },
    ]);
    expect((await item(variants[2]!)).tracked).toBe(false);

    const events = await f.outbox();
    expect(events.map((event) => event.event_type).sort()).toEqual([
      'inventory_item.updated',
      'inventory_item.updated',
      'inventory_level.updated',
      'inventory_level.updated',
    ]);
    const level = events.find(
      (event) =>
        event.event_type === 'inventory_level.updated' &&
        event.payload.inventoryItemId === variants[0],
    )!;
    expect(level).toMatchObject({
      aggregate_type: 'inventory_level',
      aggregate_id: first.levels[0]!.id,
      payload: {
        locationId: warehouse.id,
        onHand: 10,
        committed: 0,
        reserved: 0,
        safetyStock: 0,
        available: 10,
        reason: 'cycle_count_available',
        adjustmentId: group.id,
        version: 2,
      },
    });
    expect(events.find((event) => event.event_type === 'inventory_item.updated')).toMatchObject({
      aggregate_type: 'inventory_item',
      payload: { changed: ['tracked'], tracked: true, inventoryPolicy: 'deny', version: 1 },
    });

    // Setting the same quantity again changes nothing and records nothing.
    await f.admin.query('DELETE FROM platform.outbox_events');
    expect(
      unwrap(
        await set([{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 10 }]),
      ),
    ).toBeNull();
    expect(await f.outbox()).toEqual([]);
  });

  it('adjusts available and on hand together, and holds back safety stock', async () => {
    unwrap(await adjust([{ inventoryItemId: variants[0]!, locationId: warehouse.id, delta: 12 }]));
    unwrap(
      await adjust([{ inventoryItemId: variants[0]!, locationId: warehouse.id, delta: -2 }], {
        name: 'on_hand',
        reason: 'damaged',
      }),
    );
    unwrap(
      await set([{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 3 }], {
        name: 'safety_stock',
        reason: 'safety_stock',
      }),
    );
    expect(await levelAt(variants[0]!, warehouse)).toMatchObject({
      onHand: 10,
      safetyStock: 3,
      available: 7,
    });
    // Setting available moves on hand so that available comes out right.
    const group = unwrap(
      await set([{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 4 }]),
    )!;
    expect(group.changes).toMatchObject([
      { name: 'on_hand', delta: -3, quantityAfter: 7, availableAfter: 4 },
    ]);
  });

  it('applies all changes or none, and never removes more than is on hand', async () => {
    unwrap(await set([{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 2 }]));
    const result = await adjust([
      { inventoryItemId: variants[1]!, locationId: warehouse.id, delta: 5 },
      { inventoryItemId: variants[0]!, locationId: warehouse.id, delta: -3 },
    ]);
    expect(errorsOf(result)).toEqual([['input.changes.1.delta', 'INVALID']]);
    expect(!result.ok && result.errors[0]!.message).toBe(
      "Only 2 on hand at this location; can't remove 3",
    );
    // The failed request left no trace: variant 1 is still untracked.
    expect(await item(variants[1]!)).toEqual(untrackedItem(variants[1]!));
    expect((await levelAt(variants[0]!, warehouse))?.onHand).toBe(2);
    expect(
      errorsOf(
        await adjust([{ inventoryItemId: variants[0]!, locationId: warehouse.id, delta: -1 }], {
          name: 'safety_stock',
          reason: 'safety_stock',
        }),
      ),
    ).toEqual([['input.changes.0.delta', 'INVALID']]);
  });

  it('sets a quantity only if it is still what the caller read', async () => {
    unwrap(await set([{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 5 }]));
    const stale = await set([
      { inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 8, compareQuantity: 4 },
    ]);
    expect(errorsOf(stale)).toEqual([['input.quantities.0.compareQuantity', 'STALE']]);
    expect(!stale.ok && stale.errors[0]!.message).toBe(
      'The quantity is 5 now, not 4; read it again',
    );
    unwrap(
      await set([
        {
          inventoryItemId: variants[0]!,
          locationId: warehouse.id,
          quantity: 8,
          compareQuantity: 5,
        },
        // A level never stocked reads as zero.
        {
          inventoryItemId: variants[1]!,
          locationId: warehouse.id,
          quantity: 1,
          compareQuantity: 0,
        },
      ]),
    );
    expect((await levelAt(variants[0]!, warehouse))?.available).toBe(8);
  });

  it('moves stock between locations in one adjustment, never more than is available', async () => {
    unwrap(await set([{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 10 }]));
    unwrap(
      await set([{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 2 }], {
        name: 'safety_stock',
        reason: 'safety_stock',
      }),
    );
    const group = unwrap(
      await f.inventory.moveQuantities(f.a, {
        reason: 'movement_created',
        referenceDocumentUri: 'https://erp.example.com/transfers/7',
        changes: [move(variants[0]!, 5, warehouse, store)],
      }),
    )!;
    expect(group).toMatchObject({
      reason: 'movement_created',
      referenceDocumentUri: 'https://erp.example.com/transfers/7',
    });
    expect(
      group.changes.map((change) => [change.location.name, change.name, change.delta]),
    ).toEqual([
      ['Warehouse', 'on_hand', -5],
      ['Store', 'on_hand', 5],
    ]);
    expect(await levelAt(variants[0]!, warehouse)).toMatchObject({ onHand: 5, available: 3 });
    expect(await levelAt(variants[0]!, store)).toMatchObject({ onHand: 5, available: 5 });

    // Safety stock is not sent: only 3 of the 5 on hand are available.
    const tooMany = await moveAll([move(variants[0]!, 4, warehouse, store)]);
    expect(errorsOf(tooMany)).toEqual([['input.changes.0.quantity', 'INVALID']]);
    expect(!tooMany.ok && tooMany.errors[0]!.message).toBe(
      "Only 3 available at the location it's moved from; can't move 4",
    );
    // All moves apply or none: a size never stocked can't be sent, so the other stays too.
    expect(
      errorsOf(
        await moveAll([
          move(variants[0]!, 2, store, warehouse),
          move(variants[1]!, 1, warehouse, store),
        ]),
      ),
    ).toEqual([['input.changes.1.quantity', 'INVALID']]);
    expect((await levelAt(variants[0]!, store))?.onHand).toBe(5);
    expect(await levelAt(variants[1]!, store)).toBeUndefined();

    expect(
      errorsOf(
        await f.inventory.moveQuantities(f.a, {
          reason: 'theft',
          changes: [
            {
              ...move(variants[0]!, 0, warehouse, store),
              from: { locationId: warehouse.id, name: 'on_hand' },
            },
            move(variants[1]!, 1, store, store),
            // Store and warehouse were named in the first already.
            move(variants[0]!, 1, store, warehouse),
          ],
        }),
      ),
    ).toEqual([
      ['input.reason', 'INVALID'],
      ['input.changes.0.quantity', 'INVALID'],
      ['input.changes.0.from.name', 'INVALID'],
      ['input.changes.1.to.locationId', 'INVALID'],
      ['input.changes.2.from', 'INVALID'],
      ['input.changes.2.to', 'INVALID'],
    ]);
    expect(errorsOf(await moveAll([]))).toEqual([['input.changes', 'BLANK']]);
    // An unknown item is reported once, not at both ends.
    expect(errorsOf(await moveAll([move(newId(), 1, warehouse, store)]))).toEqual([
      ['input.changes.0.inventoryItemId', 'NOT_FOUND'],
    ]);
  });

  it('checks input before touching the database', async () => {
    const change = { inventoryItemId: variants[0]!, locationId: warehouse.id, delta: 1 };
    expect(
      errorsOf(
        await f.inventory.adjustQuantities(f.a, {
          name: 'committed',
          reason: 'theft',
          referenceDocumentUri: 'not a uri',
          changes: [change, { ...change, delta: 0 }],
        }),
      ),
    ).toEqual([
      ['input.name', 'INVALID'],
      ['input.reason', 'INVALID'],
      ['input.referenceDocumentUri', 'INVALID'],
      ['input.changes.1', 'INVALID'],
      ['input.changes.1.delta', 'INVALID'],
    ]);
    expect(errorsOf(await adjust([]))).toEqual([['input.changes', 'BLANK']]);
    expect(
      errorsOf(
        await adjust(
          Array.from({ length: LIMITS.changes + 1 }, () => ({ ...change, locationId: newId() })),
        ),
      ),
    ).toEqual([['input.changes', 'TOO_MANY']]);
    expect(
      errorsOf(
        await set([
          { inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: -1 },
          { inventoryItemId: variants[1]!, locationId: warehouse.id, quantity: 1.5 },
        ]),
      ),
    ).toEqual([
      ['input.quantities.0.quantity', 'INVALID'],
      ['input.quantities.1.quantity', 'INVALID'],
    ]);
  });

  it('reports unknown items and locations, and inactive locations', async () => {
    const [otherShopVariant] = await f.variantsOf(f.b, 'Not mine');
    const otherShopLocation = await f.location(f.b, 'Not mine either');
    const closed = await f.location(f.a, 'Closed');
    unwrap(await f.locations.deactivate(f.a, closed.id));
    expect(
      errorsOf(
        await adjust([
          { inventoryItemId: otherShopVariant!, locationId: warehouse.id, delta: 1 },
          { inventoryItemId: newId(), locationId: warehouse.id, delta: 1 },
          { inventoryItemId: variants[0]!, locationId: otherShopLocation.id, delta: 1 },
          { inventoryItemId: variants[1]!, locationId: closed.id, delta: 1 },
        ]),
      ),
    ).toEqual([
      ['input.changes.0.inventoryItemId', 'NOT_FOUND'],
      ['input.changes.1.inventoryItemId', 'NOT_FOUND'],
      ['input.changes.2.locationId', 'NOT_FOUND'],
      ['input.changes.3.locationId', 'INVALID'],
    ]);
  });

  it('counts stock that can be sold online', async () => {
    unwrap(
      await set([
        { inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 4 },
        { inventoryItemId: variants[0]!, locationId: store.id, quantity: 6 },
      ]),
    );
    const stocked = await item(variants[0]!);
    // The store does not fulfil online orders: its stock is not sold online.
    expect(stocked.levels.map((level) => level.location.name)).toEqual(['Warehouse', 'Store']);
    expect(sellableQuantity(stocked)).toBe(4);
    expect(availableForSale(stocked)).toBe(true);

    unwrap(await set([{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 0 }]));
    const soldOut = await item(variants[0]!);
    expect(availableForSale(soldOut)).toBe(false);
    // Read models ask for many variants at once; those never stocked can be sold.
    const available = () =>
      f.db.tenant(f.a.shopId, (tx) => f.inventory.availableOf(tx, f.a.shopId, variants));
    expect([...(await available()).values()]).toEqual([false, true, true]);
    const continuing = unwrap(
      await f.inventory.updateItem(f.a, variants[0]!, { inventoryPolicy: 'continue' }),
    );
    expect(availableForSale(continuing)).toBe(true);
    expect((await available()).get(variants[0]!)).toBe(true);
  });

  it('updates item settings, recording what changed', async () => {
    const updated = unwrap(
      await f.inventory.updateItem(f.a, variants[0]!, {
        tracked: true,
        inventoryPolicy: 'continue',
      }),
    );
    expect(updated).toMatchObject({ tracked: true, inventoryPolicy: 'continue', levels: [] });
    unwrap(await f.inventory.updateItem(f.a, variants[0]!, { tracked: true }));
    unwrap(await f.inventory.updateItem(f.a, variants[0]!, { tracked: false }));
    // Nothing to change on an untracked variant: no row, no event.
    unwrap(await f.inventory.updateItem(f.a, variants[1]!, { tracked: false }));
    expect(errorsOf(await f.inventory.updateItem(f.a, newId(), { tracked: true }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    expect((await f.outbox()).map((event) => [event.aggregate_id, event.payload])).toEqual([
      [
        variants[0],
        expect.objectContaining({
          changed: ['tracked', 'inventoryPolicy'],
          tracked: true,
          inventoryPolicy: 'continue',
          version: 1,
        }),
      ],
      [variants[0], expect.objectContaining({ changed: ['tracked'], tracked: false, version: 2 })],
    ]);
    const { rows } = await f.admin.query('SELECT count(*)::int AS n FROM inventory.items');
    expect(rows[0].n).toBe(1);
  });

  it('keeps a history of every change, newest first', async () => {
    unwrap(await set([{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 5 }]));
    unwrap(await adjust([{ inventoryItemId: variants[0]!, locationId: store.id, delta: 2 }]));
    unwrap(
      await adjust([{ inventoryItemId: variants[0]!, locationId: warehouse.id, delta: -1 }], {
        reason: 'shrinkage',
        referenceDocumentUri: 'hatti://notes/lost-in-transit',
      }),
    );
    const page = await f.inventory.history(f.a, variants[0]!, { first: 2 });
    expect(page.hasNextPage).toBe(true);
    expect(
      page.items.map((change) => [
        change.reason,
        change.location.name,
        change.delta,
        change.quantityAfter,
      ]),
    ).toEqual([
      ['shrinkage', 'Warehouse', -1, 4],
      ['received', 'Store', 2, 2],
    ]);
    expect(page.items[0]).toMatchObject({
      name: 'on_hand',
      availableAfter: 4,
      referenceDocumentUri: 'hatti://notes/lost-in-transit',
    });
    const rest = await f.inventory.history(f.a, variants[0]!, {
      first: 2,
      after: page.items[1]!.id,
    });
    expect(rest.items.map((change) => change.reason)).toEqual(['cycle_count_available']);
    expect(rest.hasNextPage).toBe(false);
    const atStore = await f.inventory.history(f.a, variants[0]!, {
      first: 10,
      locationId: store.id,
    });
    expect(atStore.items.map((change) => change.delta)).toEqual([2]);
    // Who made each change is recorded.
    const { rows } = await f.admin.query(
      'SELECT DISTINCT actor_kind, actor_id FROM inventory.adjustments',
    );
    expect(rows).toEqual([
      { actor_kind: 'app', actor_id: (f.a.actor as { tokenId: string }).tokenId },
    ]);
  });

  it('keeps the ledger append-only for request code', async () => {
    unwrap(await set([{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 5 }]));
    for (const statement of [
      'UPDATE inventory.movements SET delta = 50',
      'DELETE FROM inventory.movements',
      'UPDATE inventory.adjustments SET reason = $$correction$$',
      'DELETE FROM inventory.adjustments',
    ]) {
      const error = await f.db
        .tenant(f.a.shopId, (tx) => tx.execute(sql.raw(statement)))
        .catch((caught: unknown) => caught);
      expect([statement, pgError(error)?.code]).toEqual([statement, '42501']);
    }
  });

  it('deletes stock and its history with the variant', async () => {
    unwrap(await set([{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 5 }]));
    const [productId] = (
      await f.admin.query<{ product_id: string }>('SELECT product_id FROM inventory.items')
    ).rows.map((row) => row.product_id);
    // Request code deletes the product; the ledger goes with it although request code cannot
    // delete ledger rows itself.
    unwrap(await f.products.delete(f.a, productId!));
    for (const table of ['items', 'levels', 'movements']) {
      const { rows } = await f.admin.query(`SELECT count(*)::int AS n FROM inventory.${table}`);
      expect([table, rows[0].n]).toEqual([table, 0]);
    }
  });

  it("keeps each shop's stock to itself", async () => {
    unwrap(await set([{ inventoryItemId: variants[0]!, locationId: warehouse.id, quantity: 5 }]));
    const [mine] = await f.variantsOf(f.b, 'Khussa');
    const bLocation = await f.location(f.b, 'B warehouse');
    expect(await f.inventory.item(f.b, variants[0]!)).toBeNull();
    expect(await f.inventory.itemsOf(f.b, variants)).toEqual(new Map());
    expect((await f.inventory.history(f.b, variants[0]!, { first: 10 })).items).toEqual([]);
    expect(
      errorsOf(
        await f.inventory.adjustQuantities(f.b, {
          name: 'available',
          reason: 'correction',
          changes: [
            { inventoryItemId: variants[0]!, locationId: bLocation.id, delta: -5 },
            { inventoryItemId: mine!, locationId: warehouse.id, delta: 1 },
          ],
        }),
      ),
    ).toEqual([
      ['input.changes.0.inventoryItemId', 'NOT_FOUND'],
      ['input.changes.1.locationId', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.inventory.updateItem(f.b, variants[0]!, { tracked: false }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    expect((await levelAt(variants[0]!, warehouse))?.onHand).toBe(5);
  });
});
