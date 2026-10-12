import 'reflect-metadata';
import { type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import { MessagesService, MessagingSettingsService } from '@hatti/messaging/public';
import type { OrderService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DailySummaries } from './daily-summaries.js';
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

describe.skipIf(!server)("The owner's summary of the day before (ADR-386)", () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let orders: OrderService;
  let settings: MessagingSettingsService;
  let summaries: DailySummaries;
  const [a, b, c] = [tenant(newId()), tenant(newId()), tenant(newId())];
  const variants = new Map<string, string>();
  let phones = 0;

  /** A confirmed cash-on-delivery order of `owner`'s for Rs 2,000, placed at `at`. */
  async function placed(owner: TenantContext, at: Date): Promise<string> {
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
    await admin.query('UPDATE orders.orders SET created_at = $2 WHERE id = $1', [order.id, at]);
    return order.id;
  }

  /** The summaries queued, oldest first: their shop, number, day and words. */
  const told = async () =>
    (
      await admin.query<{
        shop_id: string;
        recipient: string;
        dedupe_key: string;
        variables: Record<string, string>;
      }>(
        `SELECT shop_id, recipient, dedupe_key, variables FROM messaging.messages
          WHERE kind = 'daily_summary' ORDER BY created_at, id`,
      )
    ).rows;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'daily-summaries-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Zari Fashions'), ($2, 'B'), ($3, 'C')`,
      [a.shopId, b.shopId, c.shopId],
    );
    orders = workerOrders(database);
    settings = new MessagingSettingsService(database);
    summaries = new DailySummaries(database, new MessagesService(database));
    const products = new ProductService(database);
    const locations = new LocationService(database);
    const inventory = new InventoryService(database, new VariantService(database));
    for (const owner of [a, b, c]) {
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

  it('tells each shop from nine in the morning, once a day, at its alerts number', async () => {
    // Midnight of 12 October in Karachi, and that morning at eight, at nine and at noon.
    const midnight = new Date('2026-10-11T19:00:00Z');
    const at = (hours: number) => new Date(midnight.getTime() + hours * HOUR);
    const [eight, nine, noon] = [at(8), at(9), at(12)];
    // Shop A's 11 October: two orders, and one confirmed.
    unwrap(await orders.confirm(a, await placed(a, new Date(midnight.getTime() - 3 * HOUR))));
    await placed(a, new Date(midnight.getTime() - 2 * HOUR));
    // Shop B gives no alerts number; shop C turned the summary off.
    await placed(b, new Date(midnight.getTime() - 2 * HOUR));
    await placed(c, new Date(midnight.getTime() - 2 * HOUR));
    unwrap(await settings.update(a, { alertsPhone: '0300 1112223' }));
    unwrap(await settings.update(c, { alertsPhone: '0300 4445556', disabled: ['daily_summary'] }));

    expect(await summaries.sweep(eight)).toBe(0);
    expect(await summaries.sweep(nine)).toBe(1);
    expect(await told()).toEqual([
      {
        shop_id: a.shopId,
        recipient: '+923001112223',
        dedupe_key: 'daily_summary:2026-10-11',
        variables: {
          shop: 'Zari Fashions',
          date: 'Sun 11 Oct',
          orders: '2',
          sales: 'Rs 4,000',
          delivered: '0',
          returned: '0',
          // Neither has shipped: no cash is on its way.
          cash: 'Rs 0',
        },
      },
    ]);
    // Once a day.
    expect(await summaries.sweep(noon)).toBe(0);

    // A day with no orders and no parcels is not told.
    expect(await summaries.sweep(new Date(noon.getTime() + 24 * HOUR))).toBe(0);
    expect(await told()).toHaveLength(1);
  });
});
