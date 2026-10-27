import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { PublicSite, type MutationResult, type TenantContext } from '@hatti/api';
import { DigitalProductService, ProductService, VariantService } from '@hatti/catalog/public';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import { MessagesService } from '@hatti/messaging/public';
import { FulfillmentService, OrderEvents, type OrderService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DigitalSales } from './digital-sales.js';
import { workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

const SHOP: TenantContext = {
  shopId: newId(),
  currency: 'PKR',
  actor: { kind: 'app', tokenId: newId() },
  scopes: new Set(['write_products', 'write_inventory', 'write_orders']),
};

describe.skipIf(!server)('Digital products delivered once paid (CAT-13, ADR-814)', () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let orders: OrderService;
  let sales: DigitalSales;
  const box = new SecretBox([{ id: 'k1', key: randomBytes(32) }]);
  const variants: Record<'ebook' | 'software' | 'kurta', string> = {
    ebook: '',
    software: '',
    kurta: '',
  };
  let phones = 0;
  let digital: DigitalProductService;
  const productIds: Record<'ebook' | 'software', string> = { ebook: '', software: '' };

  /** An order of these, paid by cash on delivery. */
  async function ordered(lines: Partial<Record<keyof typeof variants, number>>): Promise<string> {
    const order = unwrap(
      await orders.create(SHOP, {
        lineItems: Object.entries(lines).map(([name, quantity]) => ({
          variantId: variants[name as keyof typeof variants],
          quantity,
        })),
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: `0300 77766${String(phones++).padStart(2, '0')}`,
          address1: 'House 12, Street 4',
          city: 'Lahore',
        },
        paymentMethod: 'cash_on_delivery',
      }),
    );
    // Confirmed, as an order is before the shop hands any of it over.
    unwrap(await orders.confirm(SHOP, order.id));
    return order.id;
  }

  const paid = (orderId: string) =>
    sales.handle({
      id: newId(),
      type: OrderEvents.OrderPaid,
      shopId: SHOP.shopId,
      aggregateType: 'order',
      aggregateId: orderId,
      payload: {},
      occurredAt: new Date().toISOString(),
    });

  const messagesOf = async (orderId: string) =>
    (
      await admin.query<{ kind: string; dedupe_key: string; variables: Record<string, string> }>(
        `SELECT kind, dedupe_key, variables FROM messaging.messages
          WHERE order_id = $1 AND kind IN ('digital_download', 'licence_key')
          ORDER BY created_at, id`,
        [orderId],
      )
    ).rows;

  const fulfilledOf = async (orderId: string) => {
    const { rows } = await admin.query<{ fulfilled: number; parcels: string[] }>(
      `SELECT (SELECT coalesce(sum(fulfilled_quantity), 0)::int FROM orders.lines
                WHERE order_id = $1) AS fulfilled,
              coalesce((SELECT array_agg(status) FROM orders.fulfillments WHERE order_id = $1),
                       '{}') AS parcels`,
      [orderId],
    );
    return rows[0]!;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'digital-sales-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [SHOP.shopId]);
    orders = workerOrders(database);
    sales = new DigitalSales(
      database,
      new MessagesService(database),
      new PublicSite('https://api.hatti.pk'),
      box,
      new FulfillmentService(database, new StockService()),
    );
    const products = new ProductService(database);
    digital = new DigitalProductService(database, null, box);
    const location = await new LocationService(database).primary(SHOP);
    const inventory = new InventoryService(database, new VariantService(database));
    for (const [name, title] of [
      ['ebook', 'Embroidery patterns'],
      ['software', 'Shop app licence'],
      ['kurta', 'Kurta'],
    ] as const) {
      const product = unwrap(
        await products.create(SHOP, { title, status: 'active', variants: [{ price: '1,000' }] }),
      );
      variants[name] = product.variants[0]!.id;
      if (name !== 'kurta') productIds[name] = product.id;
      unwrap(
        await inventory.setQuantities(SHOP, {
          name: 'on_hand',
          reason: 'received',
          quantities: [{ inventoryItemId: variants[name], locationId: location.id, quantity: 20 }],
        }),
      );
      if (name === 'kurta') continue;
      unwrap(
        await digital.set(SHOP, product.id, { licenceKeys: name === 'software', linkDays: 7 }),
      );
      if (name === 'ebook') {
        // A file ready, as an upload made into one.
        const file = newId();
        await admin.query(
          `INSERT INTO catalog.digital_files
                  (shop_id, id, product_id, key, filename, content_type, size, status)
           VALUES ($1, $2, $3, $4, 'patterns.pdf', 'application/pdf', 1024, 'ready')`,
          [SHOP.shopId, file, product.id, `shops/${SHOP.shopId}/digital/${file}/patterns.pdf`],
        );
      } else {
        unwrap(await digital.keysAdd(SHOP, product.id, ['KEY-0001', 'KEY-0002', 'KEY-0003']));
      }
    }
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('sends each line of files its own link and each unit a key, once paid, once', async () => {
    const orderId = await ordered({ ebook: 1, software: 2, kurta: 1 });
    // Not paid yet: nothing.
    await paid(orderId);
    expect(await messagesOf(orderId)).toEqual([]);
    unwrap(await orders.markAsPaid(SHOP, orderId));
    await paid(orderId);
    // Heard again: nothing more.
    await paid(orderId);
    const sent = await messagesOf(orderId);
    expect(sent.map((each) => [each.kind, each.variables.product])).toEqual([
      ['digital_download', 'Embroidery patterns'],
      ['licence_key', 'Shop app licence'],
      ['licence_key', 'Shop app licence'],
    ]);
    expect(sent[0]!.variables.url).toMatch(/^https:\/\/api\.hatti\.pk\/dl\/[A-Za-z0-9_-]{43}$/);
    expect(sent.slice(1).map((each) => each.variables.code)).toEqual(['KEY-0001', 'KEY-0002']);
    const { rows } = await admin.query(
      `SELECT units, download_limit, expires_at > now() + interval '6 days' AS week
         FROM catalog.digital_deliveries WHERE order_id = $1`,
      [orderId],
    );
    // One link for the line, five downloads of each file for its one unit, for seven days.
    expect(rows).toEqual([{ units: 1, download_limit: 5, week: true }]);
    // Both lines given all they sell, fulfilled and delivered at once (ADR-815); the kurta waits
    // for its courier.
    expect(await fulfilledOf(orderId)).toEqual({ fulfilled: 3, parcels: ['delivered'] });
  });

  it('gives what keys are left, and none past them', async () => {
    const orderId = await ordered({ software: 3 });
    unwrap(await orders.markAsPaid(SHOP, orderId));
    await paid(orderId);
    // One left of three after the first order's two.
    expect((await messagesOf(orderId)).map((each) => each.variables.code)).toEqual(['KEY-0003']);
    // Not all its keys given: not fulfilled, until the shop adds more.
    expect(await fulfilledOf(orderId)).toEqual({ fulfilled: 0, parcels: [] });

    // Two more added (ADR-816): the waiting units are given them, and the line fulfilled.
    unwrap(await digital.keysAdd(SHOP, productIds.software, ['KEY-0004', 'KEY-0005']));
    const { rows: added } = await admin.query<{ aggregate_id: string; payload: object }>(
      `SELECT aggregate_id, payload FROM platform.outbox_events
        WHERE shop_id = $1 AND event_type = 'licence_keys.added' ORDER BY id DESC LIMIT 1`,
      [SHOP.shopId],
    );
    expect(added).toEqual([{ aggregate_id: productIds.software, payload: { added: 2 } }]);
    await sales.handle({
      id: newId(),
      type: 'licence_keys.added',
      shopId: SHOP.shopId,
      aggregateType: 'product',
      aggregateId: productIds.software,
      payload: { added: 2 },
      occurredAt: new Date().toISOString(),
    });
    expect((await messagesOf(orderId)).map((each) => each.variables.code)).toEqual([
      'KEY-0003',
      'KEY-0004',
      'KEY-0005',
    ]);
    expect(await fulfilledOf(orderId)).toEqual({ fulfilled: 3, parcels: ['delivered'] });
  });
});
