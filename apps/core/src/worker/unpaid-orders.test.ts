import 'reflect-metadata';
import { type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import { BankTransferService, OrderSettingsService, type OrderService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnpaidOrders } from './unpaid-orders.js';
import { workerOrders } from './unreachable-orders.js';

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

describe.skipIf(!server)('Orders never paid (ADR-168)', () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let orders: OrderService;
  let sweeps: UnpaidOrders;
  const [a, b] = [tenant(newId()), tenant(newId())];
  const variants = new Map<string, string>();
  let phones = 0;

  /** An order of `owner`'s to be paid by bank transfer, placed `daysAgo` days ago. */
  async function unpaid(owner: TenantContext, daysAgo: number): Promise<string> {
    const order = unwrap(
      await orders.create(owner, {
        lineItems: [{ variantId: variants.get(owner.shopId)!, quantity: 1 }],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: `0300 55566${String(phones++).padStart(2, '0')}`,
          address1: 'House 12, Street 4',
          city: 'Lahore',
        },
        paymentMethod: 'bank_transfer',
      }),
    );
    await admin.query(
      `UPDATE orders.orders SET created_at = now() - make_interval(days => $2) WHERE id = $1`,
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
      applicationName: 'unpaid-orders-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    orders = workerOrders(database);
    sweeps = new UnpaidOrders(database, orders);
    const products = new ProductService(database);
    const locations = new LocationService(database);
    const inventory = new InventoryService(database, new VariantService(database));
    const transfers = new BankTransferService(database);
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
      unwrap(
        await transfers.update(owner, {
          enabled: true,
          account: {
            title: 'Zari Textiles',
            bankName: 'Standard Chartered',
            iban: 'PK36SCBL0000001123456702',
          },
        }),
      );
    }
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
    await testDb?.drop();
  });

  it("cancels each shop's orders never paid after the days it says, and no other shop's", async () => {
    unwrap(await new OrderSettingsService(database).update(a, { cancelUnpaidAfterDays: 2 }));
    const [old, recent] = [await unpaid(a, 3), await unpaid(a, 1)];
    // A payment started online in the last day may still be made: the order waits for it.
    const paying = await unpaid(a, 4);
    const accountId = newId();
    await admin.query(
      `INSERT INTO payments.gateway_accounts (shop_id, id, gateway, environment, credentials,
                                              credentials_hint)
       VALUES ($1, $2, 'safepay', 'production', 'sealed', 'abcd')`,
      [a.shopId, accountId],
    );
    await admin.query(
      `INSERT INTO payments.sessions (shop_id, account_id, order_id, environment, amount,
                                      currency, created_at)
       VALUES ($1, $2, $3, 'production', 200000, 'PKR', now() - interval '2 hours')`,
      [a.shopId, accountId, paying],
    );
    // Shop B never cancels them.
    const elsewhere = await unpaid(b, 10);

    // A day before its days run out, an order's customer is reminded once (ADR-174).
    expect(await sweeps.sweep()).toEqual({ reminded: 1, cancelled: 1 });
    expect(await statusOf(a, old)).toBe('cancelled');
    expect(await statusOf(a, recent)).toBe('open');
    expect(await statusOf(a, paying)).toBe('open');
    expect(await statusOf(b, elsewhere)).toBe('open');
    const { rows: reminders } = await admin.query<{
      aggregate_id: string;
      payload: { cancelAt: string; stage: string };
    }>(
      `SELECT aggregate_id, payload FROM platform.outbox_events
        WHERE event_type = 'order.payment_reminded'`,
    );
    const { rows: placed } = await admin.query<{ created_at: Date; payment_reminded_at: Date }>(
      'SELECT created_at, payment_reminded_at FROM orders.orders WHERE id = $1',
      [recent],
    );
    expect(reminders).toEqual([
      {
        aggregate_id: recent,
        payload: expect.objectContaining({
          stage: 'awaiting_payment',
          cancelAt: new Date(placed[0]!.created_at.getTime() + 2 * 86_400_000).toISOString(),
        }),
      },
    ]);
    expect(placed[0]!.payment_reminded_at).toBeInstanceOf(Date);
    expect(await sweeps.sweep()).toEqual({ reminded: 0, cancelled: 0 });
    // A day after the payment started, it is no longer waited for.
    expect(await sweeps.sweep(new Date(Date.now() + 86_400_000))).toEqual({
      reminded: 0,
      cancelled: 2,
    });
    expect(await statusOf(a, paying)).toBe('cancelled');

    // Started, it sweeps at once; stopped, it waits for the sweep under way.
    const another = await unpaid(a, 3);
    await sweeps.start(60_000).stop();
    expect(await statusOf(a, another)).toBe('cancelled');
  });
});
