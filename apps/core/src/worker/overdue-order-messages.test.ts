import 'reflect-metadata';
import { type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import { MessagesService } from '@hatti/messaging/public';
import type { OrderService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OverdueOrderMessages } from './overdue-order-messages.js';
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

/** 2 p.m. in Karachi, within the shop's calling hours. */
const AFTERNOON = new Date('2026-10-20T09:00:00Z');
const HOUR = 60 * 60_000;
const ALERTS = '+923001112233';

describe.skipIf(!server)(
  "Orders overdue for their first call told at the shop's alerts number (COD-05, ADR-680)",
  () => {
    let testDb: TestDatabase;
    let database: Database;
    let admin: pg.Client;
    let orders: OrderService;
    // With a target and a number; without a number; without a target.
    const [shop, quiet, other] = [tenant(newId()), tenant(newId()), tenant(newId())];
    const variants = new Map<string, string>();
    let phones = 0;

    /** An order of `owner`'s waiting for its first call, placed `hoursAgo` before the afternoon. */
    async function waiting(owner: TenantContext, hoursAgo: number): Promise<string> {
      const order = unwrap(
        await orders.create(owner, {
          lineItems: [{ variantId: variants.get(owner.shopId)!, quantity: 1 }],
          shippingAddress: {
            name: 'Ayesha Khan',
            phone: `0300 55577${String(phones++).padStart(2, '0')}`,
            address1: 'House 12, Street 4',
            city: 'Lahore',
          },
        }),
      );
      await admin.query(`UPDATE orders.orders SET created_at = $2 WHERE id = $1`, [
        order.id,
        new Date(AFTERNOON.getTime() - hoursAgo * HOUR),
      ]);
      return order.id;
    }

    /** The alerts queued, oldest first: their shop, number, key and words. */
    const told = async () =>
      (
        await admin.query<{
          shop_id: string;
          recipient: string;
          channel: string;
          dedupe_key: string;
          variables: Record<string, string>;
        }>(
          `SELECT shop_id, recipient, channel, dedupe_key, variables FROM messaging.messages
            WHERE kind = 'orders_overdue' ORDER BY created_at, id`,
        )
      ).rows;

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      database = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'overdue-order-messages-test',
      });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle)
         VALUES ($1, 'Zari', 'zari'), ($2, 'Quiet', 'quiet'), ($3, 'B', 'b')`,
        [shop.shopId, quiet.shopId, other.shopId],
      );
      await admin.query(
        `INSERT INTO messaging.settings (shop_id, alerts_phone) VALUES ($1, $3), ($2, $3)`,
        [shop.shopId, other.shopId, ALERTS],
      );
      // Calls from 10 a.m. to 7 p.m., each order called within half an hour of calling time.
      await admin.query(
        `INSERT INTO orders.order_settings (shop_id, calling_opens, calling_closes, first_call_minutes)
         VALUES ($1, 600, 1140, 30), ($2, 600, 1140, 30)`,
        [shop.shopId, quiet.shopId],
      );
      orders = workerOrders(database);
      const products = new ProductService(database);
      const locations = new LocationService(database);
      const inventory = new InventoryService(database, new VariantService(database));
      for (const owner of [shop, quiet, other]) {
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

    it('tells the alerts number at most every three hours in calling hours, while orders wait too long', async () => {
      const alerts = new OverdueOrderMessages(database, new MessagesService(database));
      // Within the target, nothing; a shop without a target, or without a number, never.
      await waiting(shop, 0.25);
      await waiting(other, 5);
      await waiting(quiet, 5);
      expect(await alerts.sweep(AFTERNOON)).toBe(0);
      expect(await told()).toEqual([]);

      await waiting(shop, 3);
      expect(await alerts.sweep(AFTERNOON)).toBe(1);
      const block = Math.floor(AFTERNOON.getTime() / (3 * HOUR));
      expect(await told()).toEqual([
        {
          shop_id: shop.shopId,
          recipient: ALERTS,
          channel: 'whatsapp',
          dedupe_key: `orders_overdue:${block}`,
          variables: { shop: 'Zari', orders: '1' },
        },
      ]);
      // Not again within its three hours, however often it sweeps.
      expect(await alerts.sweep(new Date(AFTERNOON.getTime() + HOUR))).toBe(0);
      expect(await told()).toHaveLength(1);

      // The next three hours, both overdue now, told again.
      expect(await alerts.sweep(new Date((block + 1) * 3 * HOUR))).toBe(1);
      expect((await told()).at(-1)!.variables).toEqual({ shop: 'Zari', orders: '2' });

      // At 4 a.m., outside its calling hours, no one is told.
      expect(await alerts.sweep(new Date('2026-10-20T23:00:00Z'))).toBe(0);

      // Turned off on the Messages page, nothing more.
      await admin.query(
        `UPDATE messaging.settings SET disabled = '{orders_overdue}' WHERE shop_id = $1`,
        [shop.shopId],
      );
      expect(await alerts.sweep(new Date((block + 2) * 3 * HOUR))).toBe(0);
      expect(await told()).toHaveLength(2);
    });
  },
);
