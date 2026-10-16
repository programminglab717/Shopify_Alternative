import 'reflect-metadata';
import { StorefrontSite, type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { InventoryEvents, InventoryService, LocationService } from '@hatti/inventory/public';
import { MessagesService, StockWatchService } from '@hatti/messaging/public';
import { StorefrontApiClient } from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';
import { BackInStockAlerts } from '../worker/back-in-stock.js';

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

describe.skipIf(!server)('Back in stock: told on WhatsApp when a sold-out variant is back', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  let database: Database;
  let client: StorefrontApiClient;
  let alerts: BackInStockAlerts;
  let inventory: InventoryService;
  let locationId = '';
  const shopId = newId();
  const owner: TenantContext = {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products', 'write_inventory']),
  };
  let suit = '';
  let draft = '';

  /** The stock of `variantId` for sale online set to `quantity`, and the worker told of it. */
  async function stock(variantId: string, quantity: number): Promise<number> {
    unwrap(
      await inventory.setQuantities(owner, {
        name: 'available',
        reason: 'correction',
        quantities: [{ inventoryItemId: variantId, locationId, quantity }],
      }),
    );
    return alerts.handle({
      id: newId(),
      type: InventoryEvents.InventoryLevelUpdated,
      shopId,
      aggregateType: 'inventory_level',
      aggregateId: newId(),
      payload: { inventoryItemId: variantId },
    } as unknown as DomainEvent);
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shopId]);
    api = await startTestApi(testDb);
    app = api.app;
    await app.listen(0, '127.0.0.1');
    client = new StorefrontApiClient({ baseUrl: await app.getUrl(), key: TEST_STOREFRONT_KEY });
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'back-in-stock-test',
    });
    const products = new ProductService(database);
    inventory = new InventoryService(database, new VariantService(database));
    alerts = new BackInStockAlerts(
      database,
      new StockWatchService(database, new MessagesService(database)),
      inventory,
      new VariantService(database),
      products,
      new StorefrontSite('https://hatti.test'),
    );
    locationId = (await new LocationService(database).primary(owner)).id;
    const made = async (title: string, status: 'active' | 'draft') =>
      unwrap(
        await products.create(owner, {
          title,
          status,
          options: [{ name: 'Size', values: ['M'] }],
          variants: [{ price: '4,500', optionValues: ['M'] }],
        }),
      ).variants[0]!.id;
    suit = await made('Lawn suit', 'active');
    draft = await made('Draft suit', 'draft');
    await stock(suit, 0);
  });

  afterAll(async () => {
    await database?.close();
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('keeps wishes for variants the shop sells, while its automation is on', async () => {
    const wish = { variantId: suit, phone: '0300 1234567', language: 'ur' as const };
    expect(await client.watchStock(shopId, wish)).toEqual({
      ok: false,
      errors: [{ field: 'base', message: "This shop doesn't send back in stock messages" }],
    });
    await admin.query(
      `INSERT INTO messaging.automations (shop_id, kind, enabled) VALUES ($1, 'back_in_stock', true)`,
      [shopId],
    );
    expect(await client.watchStock(shopId, wish)).toEqual({ ok: true, created: true });
    expect(await client.watchStock(shopId, wish)).toEqual({ ok: true, created: false });
    for (const variantId of [draft, newId(), 'not-a-variant']) {
      expect(await client.watchStock(shopId, { ...wish, variantId })).toEqual({
        ok: false,
        errors: [{ field: 'variant', message: "The shop doesn't sell this" }],
      });
    }
    // Only for the storefronts, with their key.
    const plain = await app.inject({
      method: 'POST',
      url: `/storefront/shops/${shopId}/stock-watches`,
      payload: wish,
    });
    expect(plain.statusCode).toBe(401);
  });

  it('tells them once the variant sells online again, with its page, once', async () => {
    // Still none for sale: nobody is told.
    expect(await stock(suit, 0)).toBe(0);
    expect(await stock(suit, 3)).toBe(1);
    const { rows } = await admin.query<{
      recipient: string;
      language: string;
      variables: Record<string, string>;
    }>(
      `SELECT recipient, language, variables FROM messaging.messages
        WHERE shop_id = $1 AND kind = 'back_in_stock'`,
      [shopId],
    );
    const { rows: shop } = await admin.query<{ handle: string }>(
      'SELECT handle FROM control.shops WHERE id = $1',
      [shopId],
    );
    expect(rows).toEqual([
      {
        recipient: '+923001234567',
        language: 'ur',
        variables: {
          shop: 'Zari',
          product: 'Lawn suit (M)',
          url: `https://${shop[0]!.handle}.hatti.test/products/lawn-suit?variant=${suit}`,
        },
      },
    ]);
    // Stocked again: told already.
    expect(await stock(suit, 5)).toBe(0);
  });
});
