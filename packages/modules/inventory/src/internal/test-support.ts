// Shared set-up for the inventory module's database tests. Not part of the build.
import type { MutationResult, TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { InventoryService } from './inventory.service.js';
import { LocationService } from './location.service.js';
import type { LocationRecord } from './records.js';
import { StockService } from './stock.service.js';

export interface OutboxRow {
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

export interface InventoryFixture {
  testDb: TestDatabase;
  db: Database;
  admin: pg.Client;
  /** Two shops, so every test can check the other one sees nothing. */
  a: TenantContext;
  b: TenantContext;
  products: ProductService;
  variants: VariantService;
  locations: LocationService;
  inventory: InventoryService;
  stock: StockService;
  /** A product with one variant per size, or one variant without sizes; returns variant ids. */
  variantsOf(tenant: TenantContext, title: string, sizes?: string[]): Promise<string[]>;
  /** Adds a location, failing the test on user errors. */
  location(
    tenant: TenantContext,
    name: string,
    extra?: Record<string, unknown>,
  ): Promise<LocationRecord>;
  /** Events recorded so far, oldest first. */
  outbox(): Promise<OutboxRow[]>;
  /** Empties the catalog, inventory and outbox between tests. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products', 'write_inventory', 'write_locations']),
  };
}

export async function inventoryFixture(server: string): Promise<InventoryFixture> {
  const testDb = await createTestDatabase(server);
  const db = new Database({ appUrl: testDb.appUrl, applicationName: 'inventory-test' });
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
  return {
    testDb,
    db,
    admin,
    a,
    b,
    products,
    variants,
    locations,
    inventory: new InventoryService(db, variants),
    stock: new StockService(),
    async variantsOf(owner, title, sizes) {
      const result = await products.create(owner, {
        title,
        ...(sizes ? { options: [{ name: 'Size', values: sizes }] } : {}),
      });
      return unwrap(result).variants.map((variant) => variant.id);
    },
    async location(owner, name, extra = {}) {
      return unwrap(await locations.add(owner, { name, ...extra }));
    },
    async outbox() {
      const { rows } = await admin.query<OutboxRow>(
        `SELECT event_type, aggregate_type, aggregate_id, payload
           FROM platform.outbox_events ORDER BY occurred_at, id`,
      );
      return rows;
    },
    async reset() {
      await admin.query(`
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

/** The [field path, code] pairs of a failed result. */
export function errorsOf(result: MutationResult<unknown>): [string, string][] {
  if (result.ok) throw new Error('Expected user errors, got success');
  return result.errors.map((error) => [error.field.join('.'), error.code]);
}
