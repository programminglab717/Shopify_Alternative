import 'reflect-metadata';
import { type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import {
  PushService,
  generateVapidKeys,
  type PushOutcome,
  type WebPushSender,
} from '@hatti/messaging/public';
import type { OrderService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OverdueOrderPushes } from './push-notices.js';
import { workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();

/** A push service, each push kept. */
class FakeSender {
  readonly publicKey = generateVapidKeys().publicKey;
  readonly sent: { endpoint: string; message: Record<string, string> }[] = [];

  send(subscription: { endpoint: string }, message: object): Promise<PushOutcome> {
    this.sent.push({ endpoint: subscription.endpoint, message: message as Record<string, string> });
    return Promise.resolve('sent');
  }
}

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

const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`;

/** 2 p.m. in Karachi, within the shop's calling hours. */
const AFTERNOON = new Date('2026-10-20T09:00:00Z');
const HOUR = 60 * 60_000;

describe.skipIf(!server)(
  'Orders overdue for their first call pushed to staff (COD-05, ADR-627)',
  () => {
    let testDb: TestDatabase;
    let database: Database;
    let admin: pg.Client;
    let orders: OrderService;
    let sender: FakeSender;
    let push: PushService;
    const shop = tenant(newId());
    const other = tenant(newId());
    const [owner, agent, accountant] = [newId(), newId(), newId()];
    const variants = new Map<string, string>();
    let phones = 0;

    /** An order of `owner`'s waiting for its first call, placed `hoursAgo` before the afternoon. */
    async function waiting(owner: TenantContext, hoursAgo: number): Promise<string> {
      const order = unwrap(
        await orders.create(owner, {
          lineItems: [{ variantId: variants.get(owner.shopId)!, quantity: 1 }],
          shippingAddress: {
            name: 'Ayesha Khan',
            phone: `0300 55566${String(phones++).padStart(2, '0')}`,
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
    const told = () =>
      sender.sent
        .map((each) => ({
          endpoint: each.endpoint,
          title: each.message.title,
          url: each.message.url,
        }))
        .sort((a, b) => a.endpoint.localeCompare(b.endpoint));

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      database = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'overdue-order-pushes-test',
      });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari'), ($2, 'B', 'b')`,
        [shop.shopId, other.shopId],
      );
      await admin.query(
        `INSERT INTO identity.users (id, name, email, language)
       VALUES ($1, 'Ayesha', 'ayesha@zari.pk', 'en'), ($2, 'Bilal', 'bilal@zari.pk', 'ur'),
              ($3, 'Sana', 'sana@zari.pk', 'en')`,
        [owner, agent, accountant],
      );
      await admin.query(
        `INSERT INTO identity.memberships (user_id, shop_id, role)
       VALUES ($1, $4, 'owner'), ($2, $4, 'confirmation_agent'), ($3, $4, 'accountant')`,
        [owner, agent, accountant, shop.shopId],
      );
      await admin.query(
        `INSERT INTO messaging.push_subscriptions (shop_id, user_id, endpoint, p256dh, auth, kinds)
       VALUES ($1, $2, $5, $8, $9, '{orders_overdue}'), ($1, $3, $6, $8, $9, '{orders_overdue}'),
              ($1, $4, $7, $8, $9, '{orders_overdue}')`,
        [
          shop.shopId,
          owner,
          agent,
          accountant,
          endpoint('owner'),
          endpoint('agent'),
          endpoint('accountant'),
          'B'.repeat(87),
          'a'.repeat(22),
        ],
      );
      // Calls from 10 a.m. to 7 p.m., each order called within half an hour of calling time.
      await admin.query(
        `INSERT INTO orders.order_settings (shop_id, calling_opens, calling_closes, first_call_minutes)
       VALUES ($1, 600, 1140, 30)`,
        [shop.shopId],
      );
      orders = workerOrders(database);
      const products = new ProductService(database);
      const locations = new LocationService(database);
      const inventory = new InventoryService(database, new VariantService(database));
      for (const owner of [shop, other]) {
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

    beforeEach(() => {
      sender = new FakeSender();
      push = new PushService(database, sender as unknown as WebPushSender);
    });

    afterAll(async () => {
      await admin?.end();
      await database?.close();
      await testDb?.drop();
    });

    it('pushes who confirms orders, once an hour in calling hours, while orders wait too long', async () => {
      const pushes = new OverdueOrderPushes(database, push);
      // Within the target, nothing; another shop's, without a target, never.
      const recent = await waiting(shop, 0.25);
      await waiting(other, 5);
      expect(await pushes.sweep(AFTERNOON)).toBe(0);
      expect(sender.sent).toEqual([]);

      // Waiting three hours of calling time: the owner and the agent, not the accountant.
      const late = await waiting(shop, 3);
      expect(await pushes.sweep(AFTERNOON)).toBe(1);
      const desk = `/${toPublicId('shop', shop.shopId)}/desk`;
      expect(told()).toEqual([
        { endpoint: endpoint('agent'), title: 'Zari: 1 آرڈر کو وقت پر کال نہیں ہوئی', url: desk },
        { endpoint: endpoint('owner'), title: 'Zari: 1 order not called in time', url: desk },
      ]);
      // Once in the hour, however often it sweeps.
      await pushes.sweep(new Date(AFTERNOON.getTime() + 20 * 60_000));
      expect(sender.sent).toHaveLength(2);

      // The next hour, both overdue now, told again.
      await pushes.sweep(new Date(AFTERNOON.getTime() + HOUR));
      expect(sender.sent.map((each) => each.message.title).slice(2)).toEqual(
        expect.arrayContaining(['Zari: 2 orders not called in time']),
      );

      // At 4 a.m., outside its calling hours, no one is pushed.
      sender.sent.length = 0;
      expect(await pushes.sweep(new Date('2026-10-20T23:00:00Z'))).toBe(0);
      expect(sender.sent).toEqual([]);

      // Called, an order is overdue no longer.
      for (const id of [recent, late]) {
        await admin.query(`UPDATE orders.orders SET confirmation_due_at = $2 WHERE id = $1`, [
          id,
          new Date(AFTERNOON.getTime() + 4 * HOUR),
        ]);
      }
      expect(await pushes.sweep(new Date(AFTERNOON.getTime() + 2 * HOUR))).toBe(0);
    });

    it('does nothing where Hatti has no VAPID keys', async () => {
      const pushes = new OverdueOrderPushes(database, new PushService(database, null));
      expect(await pushes.sweep(AFTERNOON)).toBe(0);
    });
  },
);
