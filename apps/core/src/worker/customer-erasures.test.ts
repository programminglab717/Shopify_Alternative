import 'reflect-metadata';
import { type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { CustomerDataRegistry, CustomerService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi } from '../testing/api.js';
import {
  CustomerErasures,
  workerCustomerData,
  workerCustomerDataHandlers,
} from './customer-erasures.js';
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
    scopes: new Set(['write_products', 'write_inventory', 'write_orders', 'write_customers']),
  };
}

describe.skipIf(!server)('Erasures asked for ahead of time', () => {
  let testDb: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  const [a, b] = [tenant(newId()), tenant(newId())];

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'customer-erasures-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      a.shopId,
      b.shopId,
    ]);
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
    await testDb?.drop();
  });

  it("erases each shop's customers once their erasures are due, their orders' details with them", async () => {
    const customers = new CustomerService(database);
    const data = workerCustomerData(database);
    const sweeps = new CustomerErasures(database, data);
    // Ayesha's cancelled order keeps what the shop's accounts need, without her details.
    const product = unwrap(
      await new ProductService(database).create(a, {
        title: 'Kurta',
        status: 'active',
        variants: [{ price: '2,000' }],
      }),
    );
    const variantId = product.variants[0]!.id;
    const location = await new LocationService(database).primary(a);
    unwrap(
      await new InventoryService(database, new VariantService(database)).setQuantities(a, {
        name: 'on_hand',
        reason: 'received',
        quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity: 5 }],
      }),
    );
    const orders = workerOrders(database);
    const order = unwrap(
      await orders.create(a, {
        lineItems: [{ variantId, quantity: 1 }],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: '0300 1112223',
          address1: 'House 12, Street 4',
          city: 'Lahore',
        },
      }),
    );
    unwrap(await orders.cancel(a, order.id, { reason: 'customer' }));
    const ayesha = order.customerId!;
    const bilal = unwrap(await customers.create(b, { phone: '0300 1112224', name: 'Bilal' })).id;
    const sana = unwrap(await customers.create(a, { phone: '0300 1112225', name: 'Sana' })).id;
    unwrap(await data.requestErasure(a, ayesha));
    unwrap(await data.requestErasure(b, bilal));
    unwrap(await data.requestErasure(a, sana));
    unwrap(await data.cancelErasure(a, sana));

    // Nothing is due yet; ten days on, both shops' are.
    expect(await sweeps.sweep()).toBe(0);
    const due = new Date(Date.now() + 11 * 86_400_000);
    expect(await sweeps.sweep(due)).toBe(2);
    expect(await customers.get(a, ayesha)).toBeNull();
    expect(await customers.get(b, bilal)).toBeNull();
    expect(await customers.get(a, sana)).not.toBeNull();
    expect(await orders.get(a, order.id)).toMatchObject({
      phone: null,
      customerErasedAt: expect.any(Date),
    });
    const timeline = await orders.timeline(a, order.id, { first: 1 });
    expect(timeline.items[0]).toMatchObject({ kind: 'erased', actorKind: 'system' });
    expect(await sweeps.sweep(due)).toBe(0);
  });

  it("names every module that keeps customers' data, as the API's modules do", async () => {
    const api = await startTestApi(testDb);
    try {
      const registry = api.app.get(CustomerDataRegistry, { strict: false });
      expect(workerCustomerDataHandlers().map((handler) => handler.key)).toEqual(
        expect.arrayContaining(registry.handlers.map((handler) => handler.key)),
      );
      expect(workerCustomerDataHandlers()).toHaveLength(registry.handlers.length);
    } finally {
      await api.close();
    }
  });
});
