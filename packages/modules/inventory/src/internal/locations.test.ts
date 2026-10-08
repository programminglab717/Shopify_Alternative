import 'reflect-metadata';
import { PlanAllowance, type PlanLimit } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LocationService } from './location.service.js';
import { FIRST_LOCATION_NAME, LIMITS } from './rules.js';
import { errorsOf, inventoryFixture, unwrap, type InventoryFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('LocationService', () => {
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

  it('creates the first location when something first needs one, once', async () => {
    const primaries = await Promise.all(Array.from({ length: 5 }, () => f.locations.primary(f.a)));
    expect(new Set(primaries.map((location) => location.id)).size).toBe(1);
    expect(primaries[0]).toMatchObject({
      name: FIRST_LOCATION_NAME,
      isPrimary: true,
      isActive: true,
      fulfillsOnlineOrders: true,
      version: 1,
    });
    const { items } = await f.locations.list(f.a, { first: 10 });
    expect(items.map((location) => location.id)).toEqual([primaries[0]!.id]);
    expect((await f.outbox()).map((event) => event.event_type)).toEqual(['location.created']);
  });

  it('adds locations; the first is primary; addresses are cleaned up', async () => {
    const lahore = await f.location(f.a, ' Lahore warehouse ', {
      address: {
        address1: 'Plot 12, Sundar Industrial Estate',
        city: 'lhr',
        zip: '۵۴۰۰۰',
        phone: '0300-1234567',
      },
    });
    expect(lahore).toMatchObject({
      name: 'Lahore warehouse',
      isPrimary: true,
      address: {
        address1: 'Plot 12, Sundar Industrial Estate',
        address2: null,
        city: 'Lahore',
        provinceCode: 'PB',
        zip: '54000',
        phone: '+923001234567',
      },
    });
    const karachi = await f.location(f.a, 'Karachi store', {
      address: { city: 'Hyderabad', province: 'Sindh' },
      fulfillsOnlineOrders: false,
    });
    expect(karachi).toMatchObject({
      isPrimary: false,
      fulfillsOnlineOrders: false,
      address: { city: 'Hyderabad', provinceCode: 'SD' },
    });
    // With locations already added, the primary is the first of them.
    expect((await f.locations.primary(f.a)).id).toBe(lahore.id);
    const { items } = await f.locations.list(f.a, { first: 1 });
    expect(items.map((location) => location.name)).toEqual(['Lahore warehouse']);
    const next = await f.locations.list(f.a, { first: 1, after: items[0]!.id });
    expect(next).toMatchObject({ items: [{ name: 'Karachi store' }], hasNextPage: false });
    expect(await f.outbox()).toMatchObject([
      { event_type: 'location.created', payload: { name: 'Lahore warehouse', isPrimary: true } },
      { event_type: 'location.created', payload: { name: 'Karachi store', isPrimary: false } },
    ]);
  });

  it("keeps a shop's locations within its plan's limit, its first one among them (ADR-154)", async () => {
    class OneLocation extends PlanAllowance {
      async limitOf(): Promise<PlanLimit> {
        return { limit: 1, plan: 'Free' };
      }

      async limitIn(): Promise<PlanLimit> {
        return { limit: 1, plan: 'Free' };
      }

      async excludes(): Promise<string | null> {
        return null;
      }
    }
    const planned = new LocationService(f.db, new OneLocation());
    unwrap(await planned.add(f.a, { name: 'Shop' }));
    const refused = await planned.add(f.a, { name: 'Warehouse' });
    expect(refused.ok ? null : refused.errors).toEqual([
      {
        field: ['input'],
        code: 'TOO_MANY',
        message: 'The Free plan has room for 1 location: choose a bigger plan for more',
      },
    ]);
    // Without a plan's limit, the platform's alone.
    unwrap(await f.locations.add(f.a, { name: 'Warehouse' }));
  });

  it('rejects bad names and addresses', async () => {
    await f.location(f.a, 'Warehouse');
    expect(
      errorsOf(
        await f.locations.add(f.a, {
          name: 'WAREHOUSE',
          address: {
            zip: '5400',
            phone: '042-35761234',
            province: 'Texas',
            address1: 'x'.repeat(256),
          },
        }),
      ),
    ).toEqual([
      ['input.address.address1', 'TOO_LONG'],
      ['input.address.province', 'INVALID'],
      ['input.address.zip', 'INVALID'],
      ['input.address.phone', 'INVALID'],
    ]);
    expect(errorsOf(await f.locations.add(f.a, { name: '  ' }))).toEqual([['input.name', 'BLANK']]);
    expect(errorsOf(await f.locations.add(f.a, { name: 'WAREHOUSE' }))).toEqual([
      ['input.name', 'TAKEN'],
    ]);
  });

  it('edits only what is given; null clears an address field', async () => {
    const location = await f.location(f.a, 'Warehouse', {
      address: { address1: 'Shop 4', city: 'Karachi', phone: '03001234567' },
    });
    const edited = unwrap(
      await f.locations.edit(f.a, location.id, {
        name: 'Main warehouse',
        address: { phone: null, zip: '74200' },
      }),
    );
    expect(edited).toMatchObject({
      name: 'Main warehouse',
      version: 2,
      address: {
        address1: 'Shop 4',
        city: 'Karachi',
        provinceCode: 'SD',
        zip: '74200',
        phone: null,
      },
    });
    // Nothing new: no change, no event.
    const same = unwrap(await f.locations.edit(f.a, location.id, { name: 'Main warehouse' }));
    expect(same.version).toBe(2);
    // A known city brings its province.
    const moved = unwrap(await f.locations.edit(f.a, location.id, { address: { city: 'pindi' } }));
    expect(moved.address).toMatchObject({ city: 'Rawalpindi', provinceCode: 'PB' });

    const other = await f.location(f.a, 'Second');
    expect(errorsOf(await f.locations.edit(f.a, other.id, { name: 'main WAREHOUSE' }))).toEqual([
      ['input.name', 'TAKEN'],
    ]);
    expect(errorsOf(await f.locations.edit(f.a, newId(), { name: 'X' }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'location.updated')
        .map((event) => event.payload),
    ).toEqual([
      { changed: ['zip', 'phone', 'name'], version: 2 },
      { changed: ['city', 'provinceCode'], version: 3 },
    ]);
  });

  it('deactivates only an empty location that is not primary, and activates it again', async () => {
    const primary = await f.location(f.a, 'Warehouse');
    const store = await f.location(f.a, 'Store');
    const [variantId] = await f.variantsOf(f.a, 'Chappal');
    const stock = (quantity: number) =>
      f.inventory.setQuantities(f.a, {
        name: 'on_hand',
        reason: 'cycle_count_available',
        quantities: [{ inventoryItemId: variantId!, locationId: store.id, quantity }],
      });

    expect(errorsOf(await f.locations.deactivate(f.a, primary.id))).toEqual([
      ['locationId', 'INVALID'],
    ]);
    unwrap(await stock(3));
    expect(errorsOf(await f.locations.deactivate(f.a, store.id))).toEqual([
      ['locationId', 'IN_USE'],
    ]);
    unwrap(await stock(0));
    const inactive = unwrap(await f.locations.deactivate(f.a, store.id));
    expect(inactive).toMatchObject({ isActive: false, version: 2 });
    expect(inactive.deactivatedAt).toBeInstanceOf(Date);
    expect(unwrap(await f.locations.deactivate(f.a, store.id)).version).toBe(2);

    const names = async (includeInactive: boolean) =>
      (await f.locations.list(f.a, { first: 10, includeInactive })).items.map((l) => l.name);
    expect(await names(false)).toEqual(['Warehouse']);
    expect(await names(true)).toEqual(['Warehouse', 'Store']);
    // No stock goes to an inactive location.
    expect(errorsOf(await stock(1))).toEqual([['input.quantities.0.locationId', 'INVALID']]);

    expect(unwrap(await f.locations.activate(f.a, store.id))).toMatchObject({
      isActive: true,
      deactivatedAt: null,
      version: 3,
    });
    unwrap(await stock(1));
  });

  it('deletes only a location that never held stock', async () => {
    const primary = await f.location(f.a, 'Warehouse');
    const unused = await f.location(f.a, 'Unused');
    const used = await f.location(f.a, 'Used');
    const [variantId] = await f.variantsOf(f.a, 'Khussa');
    const set = (quantity: number) =>
      f.inventory.setQuantities(f.a, {
        name: 'available',
        reason: 'correction',
        quantities: [{ inventoryItemId: variantId!, locationId: used.id, quantity }],
      });
    unwrap(await set(2));
    unwrap(await set(0));

    expect(unwrap(await f.locations.delete(f.a, unused.id))).toEqual({ id: unused.id });
    expect(await f.locations.get(f.a, unused.id)).toBeNull();
    expect(errorsOf(await f.locations.delete(f.a, used.id))).toEqual([['locationId', 'IN_USE']]);
    expect(errorsOf(await f.locations.delete(f.a, primary.id))).toEqual([
      ['locationId', 'INVALID'],
    ]);
    expect(errorsOf(await f.locations.delete(f.a, unused.id))).toEqual([
      ['locationId', 'NOT_FOUND'],
    ]);
    expect((await f.outbox()).filter((event) => event.event_type === 'location.deleted')).toEqual([
      expect.objectContaining({ aggregate_id: unused.id, payload: { name: 'Unused' } }),
    ]);
  });

  it(`allows at most ${LIMITS.locations} locations`, async () => {
    await f.admin.query(
      `INSERT INTO inventory.locations (shop_id, name, is_primary)
       SELECT $1, 'Location ' || n, n = 1 FROM generate_series(1, $2::int) AS n`,
      [f.a.shopId, LIMITS.locations],
    );
    expect(errorsOf(await f.locations.add(f.a, { name: 'One more' }))).toEqual([
      ['input', 'TOO_MANY'],
    ]);
  });

  it("keeps each shop's locations to itself", async () => {
    const location = await f.location(f.a, 'Warehouse');
    expect(await f.locations.get(f.b, location.id)).toBeNull();
    expect(errorsOf(await f.locations.edit(f.b, location.id, { name: 'Mine' }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.locations.deactivate(f.b, location.id))).toEqual([
      ['locationId', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.locations.delete(f.b, location.id))).toEqual([
      ['locationId', 'NOT_FOUND'],
    ]);
    // B gets its own first location, and still cannot see A's.
    const { items } = await f.locations.list(f.b, { first: 10, includeInactive: true });
    expect(items.map((item) => item.name)).toEqual([FIRST_LOCATION_NAME]);
    expect((await f.locations.get(f.a, location.id))?.name).toBe('Warehouse');
  });
});
