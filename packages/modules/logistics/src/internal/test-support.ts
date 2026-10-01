// Shared set-up for the logistics module's database tests. Not part of the build.
import type { MutationResult, TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { BlocklistService, CustomerService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import { FulfillmentService, OrderService } from '@hatti/orders/public';
import pg from 'pg';
import { CodRemittanceService } from './remittance.service.js';

export interface OutboxRow {
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

/** A cash-on-delivery order shipped in one parcel. */
export interface ShippedOrder {
  orderId: string;
  number: number;
  fulfillmentId: string;
}

export interface LogisticsFixture {
  testDb: TestDatabase;
  db: Database;
  admin: pg.Client;
  /** Two shops, so every test can check the other one sees nothing. */
  a: TenantContext;
  b: TenantContext;
  remittances: CodRemittanceService;
  orders: OrderService;
  fulfillments: FulfillmentService;
  /** An active product with one variant at `price`; its variant's ID, stocked. */
  variantOf(tenant: TenantContext, title: string, price: string): Promise<string>;
  /** A confirmed cash-on-delivery order of one `variantId`, shipped with `tracking`. */
  shipped(
    tenant: TenantContext,
    variantId: string,
    tracking: { company: string | null; number: string },
  ): Promise<ShippedOrder>;
  /** As {@link shipped}, and delivered. */
  delivered(
    tenant: TenantContext,
    variantId: string,
    tracking: { company: string | null; number: string },
  ): Promise<ShippedOrder>;
  /** Events recorded so far, oldest first. */
  outbox(): Promise<OutboxRow[]>;
  /** Empties statements, orders and their customers, the catalog, stock and the outbox. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products', 'write_inventory', 'write_locations', 'write_orders']),
  };
}

export async function logisticsFixture(server: string): Promise<LogisticsFixture> {
  const testDb = await createTestDatabase(server);
  const db = new Database({ appUrl: testDb.appUrl, applicationName: 'logistics-test' });
  const admin = new pg.Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  const a = tenant(newId());
  const b = tenant(newId());
  await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
    a.shopId,
    b.shopId,
  ]);
  const products = new ProductService(db);
  const variants = new VariantService(db);
  const locations = new LocationService(db);
  const inventory = new InventoryService(db, variants);
  const stock = new StockService();
  const orders = new OrderService(
    db,
    variants,
    locations,
    stock,
    new CustomerService(db),
    new BlocklistService(db),
  );
  const fulfillments = new FulfillmentService(db, stock);
  const shipped: LogisticsFixture['shipped'] = async (owner, variantId, tracking) => {
    const placed = unwrap(
      await orders.create(owner, {
        lineItems: [{ variantId, quantity: 1 }],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: '0300 1234567',
          address1: 'House 12, Street 4',
          city: 'Lahore',
        },
      }),
    );
    unwrap(await orders.confirm(owner, placed.id));
    const { fulfillmentId } = unwrap(await fulfillments.fulfill(owner, placed.id, { tracking }));
    return { orderId: placed.id, number: placed.number, fulfillmentId };
  };
  return {
    testDb,
    db,
    admin,
    a,
    b,
    remittances: new CodRemittanceService(db),
    orders,
    fulfillments,
    async variantOf(owner, title, price) {
      const created = unwrap(
        await products.create(owner, { title, status: 'active', variants: [{ price }] }),
      );
      const variantId = created.variants[0]!.id;
      const location = await locations.primary(owner);
      unwrap(
        await inventory.setQuantities(owner, {
          name: 'on_hand',
          reason: 'received',
          quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity: 100 }],
        }),
      );
      return variantId;
    },
    shipped,
    async delivered(owner, variantId, tracking) {
      const order = await shipped(owner, variantId, tracking);
      unwrap(await fulfillments.markDelivered(owner, order.fulfillmentId));
      return order;
    },
    async outbox() {
      const { rows } = await admin.query<OutboxRow>(
        `SELECT event_type, aggregate_id, payload
           FROM platform.outbox_events ORDER BY occurred_at, id`,
      );
      return rows;
    },
    async reset() {
      await admin.query(`
        DELETE FROM logistics.cod_remittances;
        DELETE FROM orders.orders;
        DELETE FROM orders.counters;
        DELETE FROM customers.customers;
        DELETE FROM catalog.products;
        DELETE FROM inventory.movements;
        DELETE FROM inventory.adjustments;
        DELETE FROM inventory.locations;
        DELETE FROM platform.outbox_events;`);
    },
    async close() {
      await db.close();
      await admin.end();
      await testDb.drop();
    },
  };
}

/** The value of a successful result; fails the test with the errors otherwise. */
export function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

/** A failed result's errors, as [field, code]. */
export function errorsOf(result: MutationResult<unknown>): [string, string][] {
  if (result.ok) throw new Error('Expected user errors, got success');
  return result.errors.map((error) => [error.field.join('.'), error.code]);
}
