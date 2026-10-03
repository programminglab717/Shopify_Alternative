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
import { ConfirmationReminders } from './confirmation-reminders.js';
import { workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();
const HOUR = 3_600_000;

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

describe.skipIf(!server)('Asking again to confirm (ADR-175)', () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let orders: OrderService;
  let sweeps: ConfirmationReminders;
  const [a, b] = [tenant(newId()), tenant(newId())];
  const variants = new Map<string, string>();
  let phones = 0;

  /** A cash-on-delivery order of `owner`'s, placed `hours` hours before `at`. */
  async function placed(owner: TenantContext, hours: number, at: Date): Promise<string> {
    const order = unwrap(
      await orders.create(owner, {
        lineItems: [{ variantId: variants.get(owner.shopId)!, quantity: 1 }],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: `0300 77766${String(phones++).padStart(2, '0')}`,
          address1: 'House 12, Street 4',
          city: 'Lahore',
        },
        paymentMethod: 'cash_on_delivery',
      }),
    );
    await admin.query('UPDATE orders.orders SET created_at = $2 WHERE id = $1', [
      order.id,
      new Date(at.getTime() - hours * HOUR),
    ]);
    return order.id;
  }

  /** The orders asked again, by the events that say so. */
  const asked = async () =>
    (
      await admin.query<{ aggregate_id: string }>(
        `SELECT aggregate_id FROM platform.outbox_events
          WHERE event_type = 'order.confirmation_reminded' ORDER BY occurred_at, id`,
      )
    ).rows.map((row) => row.aggregate_id);

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'confirmation-reminders-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    orders = workerOrders(database);
    sweeps = new ConfirmationReminders(database, orders);
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

  it('asks a customer who has not answered once more, three hours on, in calling hours alone', async () => {
    // Noon and 11 pm in Karachi.
    const noon = new Date('2026-10-05T07:00:00Z');
    const night = new Date('2026-10-05T18:00:00Z');
    const waiting = await placed(a, 4, noon);
    // Placed two hours before, three days and more before, or confirmed: not asked.
    await placed(a, 2, noon);
    await placed(a, 80, noon);
    const confirmed = await placed(a, 8, noon);
    unwrap(await orders.confirm(a, confirmed));
    // Shop B calls from 10 to 11 in the morning.
    unwrap(
      await new OrderSettingsService(database).update(b, {
        callingHours: { opens: '10:00', closes: '11:00' },
      }),
    );
    const elsewhere = await placed(b, 10, noon);

    // At night, a shop without calling hours asks no one; nor one outside its own.
    expect(await sweeps.sweep(night)).toBe(0);
    expect(await sweeps.sweep(noon)).toBe(1);
    expect(await asked()).toEqual([waiting]);
    // Once.
    expect(await sweeps.sweep(new Date(noon.getTime() + HOUR))).toBe(0);
    // In shop B's hours: half past ten.
    expect(await sweeps.sweep(new Date('2026-10-05T05:30:00Z'))).toBe(1);
    expect(await asked()).toEqual([waiting, elsewhere]);
  });
});
