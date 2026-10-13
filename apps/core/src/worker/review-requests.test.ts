import 'reflect-metadata';
import { PublicSite, type MutationResult, type TenantContext } from '@hatti/api';
import { ProductReviewService, ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import { MessagesService } from '@hatti/messaging/public';
import { FulfillmentService, type OrderService } from '@hatti/orders/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReviewRequests } from './review-requests.js';
import { workerOrders } from './unreachable-orders.js';

const server = testDatabaseServer();
const DAY = 86_400_000;

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

describe.skipIf(!server)('Customers asked to rate their delivered orders (MKT-05, ADR-400)', () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let orders: OrderService;
  let fulfillments: FulfillmentService;
  let reviews: ProductReviewService;
  let sweeps: ReviewRequests;
  const [a, b] = [tenant(newId()), tenant(newId())];
  const variants = new Map<string, string>();
  let phones = 0;

  /** An order of `owner`'s, confirmed, shipped and delivered `days` days before `at`. */
  async function delivered(owner: TenantContext, days: number, at: Date): Promise<string> {
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
    unwrap(await orders.confirm(owner, order.id));
    const { fulfillmentId } = unwrap(await fulfillments.fulfill(owner, order.id, {}));
    unwrap(await fulfillments.markDelivered(owner, fulfillmentId));
    await admin.query('UPDATE orders.fulfillments SET delivered_at = $2 WHERE id = $1', [
      fulfillmentId,
      new Date(at.getTime() - days * DAY),
    ]);
    return order.id;
  }

  /** The requests queued, by order, with what they say. */
  const requests = async () =>
    (
      await admin.query<{ order_id: string; variables: Record<string, string> }>(
        `SELECT order_id, variables FROM messaging.messages
          WHERE kind = 'review_request' ORDER BY created_at, id`,
      )
    ).rows;

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'review-requests-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
    orders = workerOrders(database);
    fulfillments = new FulfillmentService(database, new StockService());
    reviews = new ProductReviewService(database);
    sweeps = new ReviewRequests(
      database,
      new MessagesService(database),
      new PublicSite('https://hatti.test'),
    );
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
    await database?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('asks once, as many days after delivery as the shop says, with the order page', async () => {
    const at = new Date();
    const due = await delivered(a, 3.5, at);
    const tooSoon = await delivered(a, 1, at);
    const tooLate = await delivered(a, 9, at);
    const rated = await delivered(a, 4, at);
    unwrap(await reviews.updateSettings(a, { publishFrom: null }));
    // Rated already, on its page: nothing to ask.
    await admin.query(
      `INSERT INTO catalog.product_reviews (shop_id, product_id, order_id, author_name, rating)
       SELECT $1, product_id, order_id, 'Ayesha K.', 5 FROM orders.lines WHERE order_id = $2`,
      [a.shopId, rated],
    );
    // B asks after a day, but its order is too new; A has not said to ask at all.
    unwrap(await reviews.updateSettings(b, { requestAfterDays: 1 }));
    const bs = await delivered(b, 0.5, at);
    expect(await sweeps.sweep(at)).toBe(0);

    unwrap(await reviews.updateSettings(a, { requestAfterDays: 3 }));
    expect(await sweeps.sweep(at)).toBe(1);
    const [asked] = await requests();
    expect(asked).toMatchObject({
      order_id: due,
      variables: { name: 'Ayesha', order: '#1001', shop: 'Zari' },
    });
    expect(asked!.variables.url).toMatch(/^https:\/\/hatti\.test\/o\/[\w-]{22}$/);
    const { rows } = await admin.query(
      'SELECT id, review_requested_at IS NOT NULL AS asked FROM orders.orders WHERE id = ANY($1)',
      [[due, tooSoon, tooLate, rated]],
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, row.asked]))).toEqual({
      [due]: true,
      [tooSoon]: false,
      [tooLate]: false,
      // Settled without a message: no sweep picks it again.
      [rated]: true,
    });

    const timeline = await admin.query<{ message: string }>(
      `SELECT message FROM orders.order_events
        WHERE order_id = ANY($1) AND kind = 'review_requested'`,
      [[due, rated]],
    );
    expect(timeline.rows).toEqual([
      { message: 'Asked the customer on WhatsApp to rate what it brought' },
    ]);

    // Not twice, though the sweep comes again.
    expect(await sweeps.sweep(at)).toBe(0);
    // Those too soon are asked once their days are up, B's too.
    expect(await sweeps.sweep(new Date(at.getTime() + 2.5 * DAY))).toBe(2);
    expect((await requests()).map((request) => request.order_id).sort()).toEqual(
      [due, tooSoon, bs].sort(),
    );
  });
});
