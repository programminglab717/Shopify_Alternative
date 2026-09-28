import 'reflect-metadata';
import type { Tx } from '@hatti/db';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LocationRecord } from './records.js';
import type { StockLine, StockResult } from './stock.service.js';
import { errorsOf, inventoryFixture, unwrap, type InventoryFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('StockService', () => {
  let f: InventoryFixture;
  let warehouse: LocationRecord;
  let store: LocationRecord;
  let variants: string[];

  const stockAt = async (location: LocationRecord, variantId: string, quantity: number) =>
    unwrap(
      await f.inventory.setQuantities(f.a, {
        name: 'on_hand',
        reason: 'received',
        quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity }],
      }),
    );
  const line = (variantId: string, quantity: number, location = warehouse): StockLine => ({
    variantId,
    locationId: location.id,
    quantity,
  });
  /** Runs one stock operation in its own transaction, as an order would. */
  const run = (fn: (tx: Tx) => Promise<StockResult>) => f.db.tenant(f.a.shopId, fn);
  const level = async (variantId: string, location = warehouse) =>
    (await f.inventory.item(f.a, variantId))!.levels.find(
      (candidate) => candidate.location.id === location.id,
    );

  beforeAll(async () => {
    f = await inventoryFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    warehouse = await f.location(f.a, 'Warehouse');
    store = await f.location(f.a, 'Store');
    variants = await f.variantsOf(f.a, 'Lawn suit', ['S', 'M', 'L']);
  });

  it('never sells the same unit twice', async () => {
    await stockAt(warehouse, variants[0]!, 5);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        run((tx) => f.stock.commit(tx, f.a, [line(variants[0]!, 1)])),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(5);
    expect(results.filter((result) => !result.ok)).toHaveLength(15);
    expect(results.find((result) => !result.ok)).toEqual({
      ok: false,
      shortages: [{ variantId: variants[0], locationId: warehouse.id, requested: 1, available: 0 }],
    });
    expect(await level(variants[0]!)).toMatchObject({ onHand: 5, committed: 5, available: 0 });
  });

  it('applies all lines of an order, or none', async () => {
    await stockAt(warehouse, variants[0]!, 5);
    await stockAt(warehouse, variants[1]!, 1);
    const result = await run((tx) =>
      f.stock.commit(tx, f.a, [line(variants[0]!, 2), line(variants[1]!, 3)]),
    );
    expect(result).toEqual({
      ok: false,
      shortages: [{ variantId: variants[1], locationId: warehouse.id, requested: 3, available: 1 }],
    });
    expect((await level(variants[0]!))?.committed).toBe(0);
    // Lines for the same stock add up.
    const merged = await run((tx) =>
      f.stock.commit(tx, f.a, [line(variants[0]!, 2), line(variants[0]!, 3)]),
    );
    expect(merged.ok && merged.adjustment?.changes).toMatchObject([
      { name: 'committed', delta: 5, quantityAfter: 5, availableAfter: 0 },
    ]);
  });

  it("turns a checkout's hold into the order's, then ships it", async () => {
    await stockAt(warehouse, variants[0]!, 5);
    const reference = { referenceDocumentUri: 'hatti://orders/ord_1001' };
    const held = await run((tx) => f.stock.reserve(tx, f.a, [line(variants[0]!, 2)], reference));
    expect(held.ok).toBe(true);
    expect(await level(variants[0]!)).toMatchObject({ reserved: 2, available: 3 });

    // Another buyer can take only what is not held.
    const greedy = await run((tx) => f.stock.reserve(tx, f.a, [line(variants[0]!, 4)]));
    expect(greedy.ok).toBe(false);

    const committed = await run((tx) =>
      f.stock.commit(tx, f.a, [line(variants[0]!, 2)], { ...reference, fromReservation: true }),
    );
    expect(committed.ok && committed.adjustment?.changes).toMatchObject([
      { name: 'committed', delta: 2, quantityAfter: 2 },
      { name: 'reserved', delta: -2, quantityAfter: 0 },
    ]);
    expect(await level(variants[0]!)).toMatchObject({ committed: 2, reserved: 0, available: 3 });

    const shipped = await run((tx) => f.stock.fulfill(tx, f.a, [line(variants[0]!, 2)], reference));
    expect(shipped.ok && shipped.adjustment?.changes).toMatchObject([
      { name: 'on_hand', delta: -2, quantityAfter: 3 },
      { name: 'committed', delta: -2, quantityAfter: 0 },
    ]);
    expect(await level(variants[0]!)).toMatchObject({ onHand: 3, committed: 0, available: 3 });

    const history = await f.inventory.history(f.a, variants[0]!, { first: 10 });
    // Newest first, down to the ledger entry.
    expect(history.items.map((change) => [change.reason, change.name, change.delta])).toEqual([
      ['fulfilled', 'committed', -2],
      ['fulfilled', 'on_hand', -2],
      ['committed', 'reserved', -2],
      ['committed', 'committed', 2],
      ['reserved', 'reserved', 2],
      ['received', 'on_hand', 5],
    ]);
    expect(history.items[0]!.referenceDocumentUri).toBe('hatti://orders/ord_1001');
    const events = (await f.outbox()).filter(
      (event) => event.event_type === 'inventory_level.updated',
    );
    expect(events.map((event) => [event.payload.reason, event.payload.available])).toEqual([
      ['received', 5],
      ['reserved', 3],
      ['committed', 3],
      ['fulfilled', 3],
    ]);
  });

  it('releases holds and commitments, never below zero', async () => {
    await stockAt(warehouse, variants[0]!, 5);
    unwrap(await run((tx) => f.stock.reserve(tx, f.a, [line(variants[0]!, 2)])).then(ok));
    const released = await run((tx) =>
      f.stock.releaseReservation(tx, f.a, [line(variants[0]!, 5)]),
    );
    expect(released.ok && released.adjustment?.changes).toMatchObject([
      { name: 'reserved', delta: -2, quantityAfter: 0 },
    ]);
    unwrap(await run((tx) => f.stock.commit(tx, f.a, [line(variants[0]!, 1)])).then(ok));
    const cancelled = await run((tx) =>
      f.stock.releaseCommitment(tx, f.a, [line(variants[0]!, 1)], { actor: 'system' }),
    );
    expect(cancelled.ok && cancelled.adjustment?.reason).toBe('commitment_released');
    // Nothing left to release: nothing to record.
    expect(await run((tx) => f.stock.releaseCommitment(tx, f.a, [line(variants[0]!, 1)]))).toEqual({
      ok: true,
      adjustment: null,
    });
    expect(await level(variants[0]!)).toMatchObject({ committed: 0, reserved: 0, available: 5 });
    const { rows } = await f.admin.query(
      `SELECT actor_kind, actor_id FROM inventory.adjustments WHERE reason = 'commitment_released'`,
    );
    expect(rows).toEqual([{ actor_kind: 'system', actor_id: null }]);
  });

  it('sells on at zero when the item continues selling', async () => {
    await stockAt(warehouse, variants[0]!, 2);
    unwrap(await f.inventory.updateItem(f.a, variants[0]!, { inventoryPolicy: 'continue' }));
    expect((await run((tx) => f.stock.commit(tx, f.a, [line(variants[0]!, 5)]))).ok).toBe(true);
    expect(await level(variants[0]!)).toMatchObject({ onHand: 2, committed: 5, available: -3 });
    // Shipping more than was there leaves on hand below zero until stock is counted.
    expect((await run((tx) => f.stock.fulfill(tx, f.a, [line(variants[0]!, 5)]))).ok).toBe(true);
    expect(await level(variants[0]!)).toMatchObject({ onHand: -3, committed: 0, available: -3 });
  });

  it('leaves untracked stock alone, and cannot sell tracked stock where none is recorded', async () => {
    // Never stocked: not tracked, so anything goes and nothing is recorded.
    expect(await run((tx) => f.stock.commit(tx, f.a, [line(variants[2]!, 3)]))).toEqual({
      ok: true,
      adjustment: null,
    });
    await stockAt(warehouse, variants[0]!, 5);
    const elsewhere = await run((tx) => f.stock.commit(tx, f.a, [line(variants[0]!, 1, store)]));
    expect(elsewhere).toEqual({
      ok: false,
      shortages: [{ variantId: variants[0], locationId: store.id, requested: 1, available: 0 }],
    });
    unwrap(await f.inventory.updateItem(f.a, variants[0]!, { inventoryPolicy: 'continue' }));
    expect(await run((tx) => f.stock.commit(tx, f.a, [line(variants[0]!, 1, store)]))).toEqual({
      ok: true,
      adjustment: null,
    });
    // Tracking turned off: counts stop.
    unwrap(await f.inventory.updateItem(f.a, variants[0]!, { tracked: false }));
    expect(await run((tx) => f.stock.commit(tx, f.a, [line(variants[0]!, 50)]))).toEqual({
      ok: true,
      adjustment: null,
    });
    expect((await level(variants[0]!))?.committed).toBe(0);
  });

  it('cannot sell from an inactive location', async () => {
    await stockAt(store, variants[0]!, 0);
    unwrap(await f.inventory.updateItem(f.a, variants[0]!, { inventoryPolicy: 'continue' }));
    unwrap(await f.locations.deactivate(f.a, store.id));
    const result = await run((tx) => f.stock.reserve(tx, f.a, [line(variants[0]!, 1, store)]));
    expect(result.ok).toBe(false);
  });

  it("commits or rolls back with the caller's transaction", async () => {
    await stockAt(warehouse, variants[0]!, 5);
    await f.admin.query('DELETE FROM platform.outbox_events');
    await expect(
      f.db.tenant(f.a.shopId, async (tx) => {
        const result = await f.stock.commit(tx, f.a, [line(variants[0]!, 2)]);
        expect(result.ok).toBe(true);
        throw new Error('Payment failed');
      }),
    ).rejects.toThrow('Payment failed');
    expect(await level(variants[0]!)).toMatchObject({ committed: 0, available: 5 });
    expect(await f.outbox()).toEqual([]);
  });

  it('does not deadlock when orders list the same stock in opposite orders', async () => {
    await stockAt(warehouse, variants[0]!, 100);
    await stockAt(warehouse, variants[1]!, 100);
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) => {
        const lines = [line(variants[0]!, 1), line(variants[1]!, 1)];
        return run((tx) => f.stock.commit(tx, f.a, index % 2 ? lines.reverse() : lines));
      }),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect((await level(variants[0]!))?.committed).toBe(30);
    expect((await level(variants[1]!))?.committed).toBe(30);
  });

  it('makes a deactivation wait for a sale in progress at the location', async () => {
    await stockAt(store, variants[0]!, 0);
    unwrap(await f.inventory.updateItem(f.a, variants[0]!, { inventoryPolicy: 'continue' }));
    let finishSale!: () => void;
    const saleMayFinish = new Promise<void>((resolve) => (finishSale = resolve));
    let saleHoldsLocks!: () => void;
    const locked = new Promise<void>((resolve) => (saleHoldsLocks = resolve));
    const sale = run(async (tx) => {
      const result = await f.stock.commit(tx, f.a, [line(variants[0]!, 1, store)]);
      saleHoldsLocks();
      await saleMayFinish;
      return result;
    });
    await locked;

    let settled = false;
    const deactivation = f.locations.deactivate(f.a, store.id).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    finishSale();
    expect((await sale).ok).toBe(true);
    // The sale committed stock there, so the location is no longer empty.
    expect(errorsOf(await deactivation)).toEqual([['locationId', 'IN_USE']]);
  });

  it('rejects quantities that are not whole numbers from 1', async () => {
    await expect(run((tx) => f.stock.commit(tx, f.a, [line(variants[0]!, 0)]))).rejects.toThrow(
      RangeError,
    );
  });
});

/** Lets a StockResult go through unwrap(): fails the test on shortages. */
function ok(result: StockResult) {
  return result.ok
    ? { ok: true as const, value: result.adjustment }
    : {
        ok: false as const,
        errors: [
          { field: [], code: 'INVALID' as const, message: JSON.stringify(result.shortages) },
        ],
      };
}
