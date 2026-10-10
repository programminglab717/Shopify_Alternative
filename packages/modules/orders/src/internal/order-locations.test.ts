import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADDRESS, errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Where an order ships from (INV-10)', () => {
  let f: OrdersFixture;
  let kurta: string;
  let dupatta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta')) as [string];
    [dupatta] = (await f.variantsOf(f.a, 'Dupatta')) as [string];
  });

  const place = async (name: string, quantities: [string, number][], online = true) => {
    const location = unwrap(await f.locations.add(f.a, { name, fulfillsOnlineOrders: online }));
    if (quantities.length === 0) return location;
    unwrap(
      await f.inventory.setQuantities(f.a, {
        name: 'on_hand',
        reason: 'received',
        quantities: quantities.map(([inventoryItemId, quantity]) => ({
          inventoryItemId,
          locationId: location.id,
          quantity,
        })),
      }),
    );
    return location;
  };
  const levelAt = async (variantId: string, locationId: string) =>
    (await f.inventory.item(f.a, variantId))!.levels.find(
      (level) => level.location.id === locationId,
    );

  it('ships from the first location fulfilling online orders that has all of it, the primary first', async () => {
    const primary = await f.primary(f.a);
    await f.stock(f.a, kurta, 5);
    // Gulberg has both; Anarkali, first by name, has the kurta alone; the godown keeps its stock.
    const gulberg = await place('Gulberg', [
      [kurta, 3],
      [dupatta, 3],
    ]);
    await place('Anarkali', [[kurta, 9]]);
    await place('Godown', [[dupatta, 50]], false);

    expect((await f.order(f.a, [kurta])).locationId).toBe(primary.id);
    const both = await f.order(f.a, [kurta, dupatta]);
    expect(both.locationId).toBe(gulberg.id);
    expect(await levelAt(dupatta, gulberg.id)).toMatchObject({ committed: 1, available: 2 });

    // None has it all: the primary, which is short, as before.
    const short = await f.orders.create(f.a, {
      lineItems: [{ variantId: dupatta, quantity: 4 }],
      shippingAddress: ADDRESS,
    });
    expect(!short.ok && short.errors[0]).toMatchObject({
      code: 'OUT_OF_STOCK',
      message: `"Dupatta" is out of stock at ${primary.name}`,
    });
    // Named, it ships from there whatever it has.
    const named = await f.order(f.a, [kurta], { locationId: gulberg.id });
    expect(named.locationId).toBe(gulberg.id);
  });

  it('moves an order before it is packed, its stock committed where it goes and let go where it was', async () => {
    const primary = await f.primary(f.a);
    await f.stock(f.a, kurta, 5);
    await f.stock(f.a, dupatta, 5);
    const gulberg = await place('Gulberg', [[kurta, 2]]);
    const order = await f.order(f.a, [kurta, dupatta]);
    expect(order.locationId).toBe(primary.id);

    // Gulberg has no dupatta: refused, nothing moved.
    const short = await f.orders.changeLocation(f.a, order.id, gulberg.id);
    expect(!short.ok && short.errors).toEqual([
      {
        field: ['locationId'],
        code: 'OUT_OF_STOCK',
        message: '"Dupatta" is out of stock at Gulberg',
      },
    ]);
    expect(await levelAt(kurta, primary.id)).toMatchObject({ committed: 1 });

    unwrap(
      await f.inventory.setQuantities(f.a, {
        name: 'on_hand',
        reason: 'received',
        quantities: [{ inventoryItemId: dupatta, locationId: gulberg.id, quantity: 4 }],
      }),
    );
    await f.admin.query('DELETE FROM platform.outbox_events');
    const moved = unwrap(await f.orders.changeLocation(f.a, order.id, gulberg.id));
    expect(moved.locationId).toBe(gulberg.id);
    expect(await levelAt(kurta, primary.id)).toMatchObject({ committed: 0, available: 5 });
    expect(await levelAt(kurta, gulberg.id)).toMatchObject({ committed: 1, available: 1 });
    expect(await levelAt(dupatta, gulberg.id)).toMatchObject({ committed: 1, available: 3 });
    const timeline = await f.orders.timeline(f.a, order.id, { first: 1 });
    expect(timeline.items.map((entry) => [entry.kind, entry.message])).toEqual([
      ['location_changed', 'Ships from Gulberg'],
    ]);
    expect(
      (await f.outbox()).filter((row) => row.event_type === 'order.updated')[0]?.payload,
    ).toMatchObject({ changed: ['location'] });

    // The same place changes nothing; then packed, or another shop's, or a closed location.
    expect(unwrap(await f.orders.changeLocation(f.a, order.id, gulberg.id)).version).toBe(
      moved.version,
    );
    expect(errorsOf(await f.orders.changeLocation(f.b, order.id, primary.id))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.orders.changeLocation(f.a, order.id, newId()))).toEqual([
      ['locationId', 'NOT_FOUND'],
    ]);
    const closed = await place('Closed', []);
    unwrap(await f.locations.deactivate(f.a, closed.id));
    expect(errorsOf(await f.orders.changeLocation(f.a, order.id, closed.id))).toEqual([
      ['locationId', 'INVALID'],
    ]);
    unwrap(await f.orders.confirm(f.a, order.id));
    unwrap(await f.orders.markPacked(f.a, order.id));
    const packed = await f.orders.changeLocation(f.a, order.id, primary.id);
    expect(!packed.ok && packed.errors[0]!.message).toBe(
      'A packed order ships from where it was packed: mark it not packed first',
    );
    unwrap(await f.orders.markUnpacked(f.a, order.id));
    unwrap(await f.orders.changeLocation(f.a, order.id, primary.id));
    unwrap(await f.orders.cancel(f.a, order.id, { reason: 'customer' }));
    expect(await levelAt(kurta, primary.id)).toMatchObject({ committed: 0, available: 5 });
    expect(errorsOf(await f.orders.changeLocation(f.a, order.id, gulberg.id))).toEqual([
      ['id', 'INVALID'],
    ]);
  });
});
