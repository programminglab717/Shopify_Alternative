import 'reflect-metadata';
import { type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import { OrderSettingsService, type OrderService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnreachableOrders, workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products', 'write_inventory', 'write_orders', 'write_settings']),
  };
}

describe.skipIf(!server)("Giving up on customers who can't be reached", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let orders: OrderService;
  let sweeps: UnreachableOrders;
  const [a, b] = [tenant(newId()), tenant(newId())];
  const variants = new Map<string, string>();
  let phones = 0;

  /** A cash-on-delivery order of `owner`'s, its customer unreachable, placed `daysAgo` days ago. */
  async function unreachable(owner: TenantContext, daysAgo: number): Promise<string> {
    const order = unwrap(
      await orders.create(owner, {
        lineItems: [{ variantId: variants.get(owner.shopId)!, quantity: 1 }],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: `0300 44455${String(phones++).padStart(2, '0')}`,
          address1: 'House 12, Street 4',
          city: 'Lahore',
        },
      }),
    );
    await admin.query(
      `UPDATE orders.orders SET confirmation_status = 'no_response',
              created_at = now() - make_interval(days => $2)
        WHERE id = $1`,
      [order.id, daysAgo],
    );
    return order.id;
  }

  const statusOf = async (owner: TenantContext, id: string) =>
    (await orders.get(owner, id))!.status;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'unreachable-orders-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    orders = workerOrders(database);
    sweeps = new UnreachableOrders(database, orders);
    const products = new ProductService(database);
    const locations = new LocationService(database);
    const inventory = new InventoryService(database, new VariantService(database));
    for (const owner of [a, b]) {
      const product = unwrap(
        await products.create(owner, {
          title: 'Kurta',
          status: 'active',
          variants: [{ price: '2,000' }],
        }),
      );
      const variantId = product.variants[0]!.id;
      variants.set(owner.shopId, variantId);
      const location = await locations.primary(owner);
      unwrap(
        await inventory.setQuantities(owner, {
          name: 'on_hand',
          reason: 'received',
          quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity: 20 }],
        }),
      );
    }
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
    await testDb?.drop();
  });

  it('cancels each shop’s unreachable orders after the days it says, and no other shop’s', async () => {
    const settings = new OrderSettingsService(database);
    unwrap(await settings.update(a, { cancelUnreachableAfterDays: 3 }));
    const [old, recent] = [await unreachable(a, 5), await unreachable(a, 1)];
    // Shop B never gives up.
    const elsewhere = await unreachable(b, 10);

    expect(await sweeps.sweep()).toBe(1);
    expect(await statusOf(a, old)).toBe('cancelled');
    expect(await statusOf(a, recent)).toBe('open');
    expect(await statusOf(b, elsewhere)).toBe('open');
    expect(await sweeps.sweep()).toBe(0);

    // Started, it sweeps at once; stopped, it waits for the sweep under way.
    const another = await unreachable(a, 4);
    await sweeps.start(60_000).stop();
    expect(await statusOf(a, another)).toBe('cancelled');
  });
});
