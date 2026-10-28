import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
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

  it("routes an order to a location that ships to its customer's city, else province, that has all of it (SHP-09, ADR-839)", async () => {
    const primary = await f.primary(f.a);
    await f.stock(f.a, kurta, 5);
    const karachi = await place('Karachi store', [[kurta, 5]]);
    const sindh = await place('Hyderabad store', [[kurta, 5]]);
    const lahore = await place('Lahore store', [[kurta, 5]]);
    unwrap(await f.locations.edit(f.a, karachi.id, { serves: { cities: ['khi', 'Karachi'] } }));
    unwrap(await f.locations.edit(f.a, sindh.id, { serves: { provinces: ['Sindh'] } }));
    unwrap(
      await f.locations.edit(f.a, lahore.id, {
        serves: { cities: ['lhr', 'Faisalabad'], provinces: ['KPK'] },
      }),
    );
    expect((await f.locations.get(f.a, lahore.id))!.serves).toEqual({
      cities: ['Lahore', 'Faisalabad'],
      provinces: ['KP'],
    });

    const to = async (city: string) =>
      (await f.order(f.a, [kurta], { shippingAddress: { ...ADDRESS, city } })).locationId;
    // The city first, its province next, then the primary for anywhere else.
    expect(await to('Karachi')).toBe(karachi.id);
    expect(await to('lahore')).toBe(lahore.id);
    expect(await to('Peshawar')).toBe(lahore.id);
    expect(await to('Sukkur')).toBe(sindh.id);
    expect(await to('Quetta')).toBe(primary.id);
    // A location that serves the city but hasn't all of it is passed over.
    await f.inventory.setQuantities(f.a, {
      name: 'on_hand',
      reason: 'correction',
      quantities: [{ inventoryItemId: kurta, locationId: karachi.id, quantity: 0 }],
    });
    expect(await to('Karachi')).toBe(sindh.id);
    // Named, it ships from there whatever the rules say.
    expect((await f.order(f.a, [kurta], { locationId: lahore.id })).locationId).toBe(lahore.id);
    // What it names is checked.
    expect(
      errorsOf(await f.locations.edit(f.a, sindh.id, { serves: { provinces: ['Atlantis'] } })),
    ).toEqual([['input.serves.provinces.0', 'INVALID']]);
  });

  it('splits an order no one location has all of among those that do, once the shop allows (ADR-898)', async () => {
    const karachi = await place('Karachi store', [[kurta, 3]]);
    const lahore = await place('Lahore store', [[dupatta, 3]]);
    const placing = () =>
      f.orders.create(f.a, {
        lineItems: [
          { variantId: kurta, quantity: 2 },
          { variantId: dupatta, quantity: 1 },
        ],
        shippingAddress: ADDRESS,
        shippingPrice: '250',
      });
    // Not unless the shop allows it: refused at the primary, as before.
    expect(!(await placing()).ok).toBe(true);
    await f.admin.query(
      `INSERT INTO inventory.settings (shop_id, low_stock_threshold, split_orders)
       VALUES ($1, 5, true)`,
      [f.a.shopId],
    );
    const order = unwrap(await placing());
    // The kurtas, more of it, ship from Karachi with the delivery charge; the dupatta apart.
    expect(order).toMatchObject({
      locationId: karachi.id,
      splitFrom: null,
      splitParts: [{ orderId: expect.any(String), number: order.number + 1 }],
    });
    expect(order.lines.map((line) => [line.title, line.quantity])).toEqual([['Kurta', 2]]);
    const { rows } = await f.admin.query<{
      id: string;
      location_id: string;
      split_from_id: string;
      shipping: string;
      cod_fee: string;
    }>(
      `SELECT id, location_id, split_from_id, shipping::text, cod_fee::text FROM orders.orders
        WHERE shop_id = $1 AND split_from_id IS NOT NULL`,
      [f.a.shopId],
    );
    expect(rows).toEqual([
      {
        id: expect.any(String),
        location_id: lahore.id,
        split_from_id: order.id,
        shipping: '0',
        cod_fee: '0',
      },
    ]);
    const part = (await f.orders.get(f.a, rows[0]!.id))!;
    expect(part.lines.map((line) => [line.title, line.quantity])).toEqual([['Dupatta', 1]]);
    // Each part's stock committed where it ships from.
    expect(await levelAt(kurta, karachi.id)).toMatchObject({ committed: 2, available: 1 });
    expect(await levelAt(dupatta, lahore.id)).toMatchObject({ committed: 1, available: 2 });
    // Paid ahead, it isn't split: refused at the primary, as before.
    const prepaid = await f.orders.create(f.a, {
      lineItems: [
        { variantId: kurta, quantity: 1 },
        { variantId: dupatta, quantity: 1 },
      ],
      shippingAddress: ADDRESS,
      paymentMethod: 'prepaid',
    });
    expect(!prepaid.ok && prepaid.errors[0]!.code).toBe('OUT_OF_STOCK');
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

  it('lists and counts the orders each location ships', async () => {
    const primary = await f.primary(f.a);
    await f.stock(f.a, kurta, 5);
    const gulberg = await place('Gulberg', [[dupatta, 5]]);
    const fromPrimary = await f.order(f.a, [kurta]);
    const fromGulberg = await f.order(f.a, [dupatta]);
    unwrap(await f.orders.confirm(f.a, fromGulberg.id));
    const at = (locationId: string) => `location_id:${toPublicId('location', locationId)}`;

    const listed = async (query: string) =>
      (await f.orders.list(f.a, { first: 5, query })).items.map((order) => order.id);
    expect(await listed(at(gulberg.id))).toEqual([fromGulberg.id]);
    expect(await listed(at(primary.id))).toEqual([fromPrimary.id]);
    expect(await listed(`-${at(gulberg.id)}`)).toEqual([fromPrimary.id]);

    const counts = await f.orders.stageCounts(f.a, { locationId: gulberg.id });
    expect(counts.get('to_pack')).toBe(1);
    expect(counts.get('needs_confirmation')).toBe(0);
    expect((await f.orders.stageCounts(f.a)).get('needs_confirmation')).toBe(1);
    expect((await f.orders.stageCounts(f.b, { locationId: gulberg.id })).get('to_pack')).toBe(0);
  });

  it("counts the home's orders for one location", async () => {
    await f.stock(f.a, kurta, 5);
    const gulberg = await place('Gulberg', [[dupatta, 5]]);
    await f.order(f.a, [kurta]);
    const fromGulberg = await f.order(f.a, [dupatta]);
    unwrap(await f.orders.confirm(f.a, fromGulberg.id));

    const all = await f.orders.home(f.a);
    expect([all.toConfirm.count, all.toPack.count]).toEqual([1, 1]);
    const there = await f.orders.home(f.a, { locationId: gulberg.id });
    expect([there.toConfirm.count, there.toPack.count]).toEqual([0, 1]);
    expect(there.toPack.total).toBe(fromGulberg.total);
    const primary = await f.orders.home(f.a, { locationId: (await f.primary(f.a)).id });
    expect([primary.toConfirm.count, primary.toPack.count]).toEqual([1, 0]);
    expect((await f.orders.home(f.b, { locationId: gulberg.id })).toPack.count).toBe(0);
  });
});
