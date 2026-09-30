// Shared set-up for the checkout module's database tests. Not part of the build.
import type { MutationResult, TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { createTestDatabase, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import pg from 'pg';
import { CartService } from './cart.service.js';

export interface CheckoutFixture {
  testDb: TestDatabase;
  db: Database;
  admin: pg.Client;
  /** Two shops, so every test can check the other one sees nothing. */
  a: TenantContext;
  b: TenantContext;
  carts: CartService;
  products: ProductService;
  variants: VariantService;
  /** An active product with a variant per size (or one without sizes); its variant IDs. */
  variantsOf(
    tenant: TenantContext,
    title: string,
    options?: { sizes?: string[]; price?: string },
  ): Promise<string[]>;
  /** Sets on-hand stock of a variant at the shop's primary location, which tracks it. */
  stock(tenant: TenantContext, variantId: string, quantity: number): Promise<void>;
  /** Empties carts, the catalog and stock between tests. */
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

export async function checkoutFixture(server: string): Promise<CheckoutFixture> {
  const testDb = await createTestDatabase(server);
  const db = new Database({ appUrl: testDb.appUrl, applicationName: 'checkout-test' });
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
  return {
    testDb,
    db,
    admin,
    a,
    b,
    carts: new CartService(db, variants, inventory),
    products,
    variants,
    async variantsOf(owner, title, options = {}) {
      const price = options.price ?? '1,000';
      const created = await products.create(owner, {
        title,
        status: 'active',
        ...(options.sizes
          ? {
              options: [{ name: 'Size', values: options.sizes }],
              variants: options.sizes.map((size) => ({ optionValues: [size], price })),
            }
          : { variants: [{ price }] }),
      });
      return unwrap(created).variants.map((variant) => variant.id);
    },
    async stock(owner, variantId, quantity) {
      const location = await locations.primary(owner);
      unwrap(
        await inventory.setQuantities(owner, {
          name: 'on_hand',
          reason: 'received',
          quantities: [{ inventoryItemId: variantId, locationId: location.id, quantity }],
        }),
      );
    },
    async reset() {
      await admin.query(`
        DELETE FROM checkout.carts;
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
