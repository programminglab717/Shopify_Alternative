import 'reflect-metadata';
import { PublicSite, type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import { MessagesService } from '@hatti/messaging/public';
import { OrderEvents, type OnlineGateway, type OrderService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodPrepaidOffers } from './cod-prepaid-offers.js';
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

describe.skipIf(!server)(
  'COD to prepaid: store credit offered for paying online (MKT-04, ADR-432)',
  () => {
    let testDb: TestDatabase;
    let database: Database;
    let admin: pg.Client;
    let orders: OrderService;
    let offers: CodPrepaidOffers;
    const owner = tenant(newId());
    let variantId = '';
    let phones = 0;
    /** The shop's gateways, as the payments module would give them. */
    let gateways: OnlineGateway[] = [{ gateway: 'test', name: 'Test gateway', origin: null }];

    /** An order placed to pay as `paymentMethod`, and the event of its confirming. */
    async function confirmed(
      paymentMethod: 'cash_on_delivery' | 'bank_transfer' = 'cash_on_delivery',
    ): Promise<{ id: string; number: number; event: DomainEvent }> {
      if (paymentMethod === 'bank_transfer') {
        await admin.query(
          `INSERT INTO orders.bank_transfer_settings (shop_id, enabled, account_title, bank_name, iban)
         VALUES ($1, true, 'Zari', 'HBL', 'PK36SCBL0000001123456702')
         ON CONFLICT (shop_id) DO NOTHING`,
          [owner.shopId],
        );
      }
      const order = unwrap(
        await orders.create(owner, {
          lineItems: [{ variantId, quantity: 1 }],
          shippingAddress: {
            name: 'Ayesha Khan',
            phone: `0300 55544${String(phones++).padStart(2, '0')}`,
            address1: 'House 12, Street 4',
            city: 'Lahore',
          },
          paymentMethod,
        }),
      );
      if (paymentMethod === 'cash_on_delivery') unwrap(await orders.confirm(owner, order.id));
      return {
        id: order.id,
        number: order.number,
        event: {
          id: newId(),
          type: OrderEvents.OrderConfirmed,
          shopId: owner.shopId,
          aggregateType: 'order',
          aggregateId: order.id,
          payload: {},
        } as unknown as DomainEvent,
      };
    }

    const turn = (enabled: boolean, credit = 150_00) =>
      admin.query(
        `INSERT INTO messaging.automations (shop_id, kind, enabled, credit_amount)
       VALUES ($1, 'cod_prepaid', $2, $3)
       ON CONFLICT (shop_id, kind) DO UPDATE
         SET enabled = EXCLUDED.enabled, credit_amount = EXCLUDED.credit_amount`,
        [owner.shopId, enabled, credit],
      );

    const offered = async (orderId: string) =>
      (
        await admin.query<{ recipient: string; variables: Record<string, string> }>(
          `SELECT recipient, variables FROM messaging.messages
          WHERE kind = 'cod_prepaid' AND order_id = $1`,
          [orderId],
        )
      ).rows;

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      database = new Database({
        appUrl: testDb.appUrl,
        systemUrl: testDb.systemUrl,
        applicationName: 'cod-prepaid-offers-test',
      });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [owner.shopId]);
      orders = workerOrders(database);
      offers = new CodPrepaidOffers(
        database,
        new MessagesService(database),
        { gatewaysOf: async () => gateways },
        new PublicSite('https://hatti.test'),
      );
      const product = unwrap(
        await new ProductService(database).create(owner, {
          title: 'Kurta',
          status: 'active',
          variants: [{ price: '2,000' }],
        }),
      );
      variantId = product.variants[0]!.id;
      const location = await new LocationService(database).primary(owner);
      unwrap(
        await new InventoryService(database, new VariantService(database)).setQuantities(owner, {
          name: 'on_hand',
          reason: 'received',
          quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity: 20 }],
        }),
      );
    });

    afterAll(async () => {
      await database?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it("offers a confirmed cash-on-delivery order's customer the shop's credit, once, with its page", async () => {
      // Off: nothing is offered.
      const before = await confirmed();
      expect(await offers.handle(before.event)).toBe(false);
      await turn(true);
      const order = await confirmed();
      expect(await offers.handle(order.event)).toBe(true);
      const [message, ...more] = await offered(order.id);
      expect(more).toEqual([]);
      expect(message).toEqual({
        recipient: '+923005554401',
        variables: {
          name: 'Ayesha',
          order: `#${order.number}`,
          shop: 'Zari',
          amount: 'Rs 2,000',
          credit: 'Rs 150',
          url: expect.stringMatching(/^https:\/\/hatti\.test\/o\/[\w-]+$/),
        },
      });
      expect((await orders.get(owner, order.id))!.prepayCredit).toBe(150_00n);
      // Confirmed again, as after an edit: offered already.
      expect(await offers.handle(order.event)).toBe(false);
      expect(await offered(order.id)).toHaveLength(1);
    });

    it('offers nothing where the shop takes no payments online, or the order is paid otherwise', async () => {
      await turn(true);
      gateways = [];
      const noGateway = await confirmed();
      expect(await offers.handle(noGateway.event)).toBe(false);
      gateways = [{ gateway: 'test', name: 'Test gateway', origin: null }];
      // A transfer order's money is not collected at the door.
      const transfer = await confirmed('bank_transfer');
      expect(await offers.handle(transfer.event)).toBe(false);
      // As much credit as the order costs is no offer.
      await turn(true, 2_000_00);
      const dear = await confirmed();
      expect(await offers.handle(dear.event)).toBe(false);
      for (const each of [noGateway, transfer, dear]) {
        expect(await offered(each.id)).toEqual([]);
        expect((await orders.get(owner, each.id))!.prepayCredit).toBeNull();
      }
    });
  },
);
