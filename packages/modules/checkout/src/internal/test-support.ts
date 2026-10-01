// Shared set-up for the checkout module's database tests. Not part of the build.
import { StorefrontSite, type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { BlocklistService, CustomerService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import { BankTransferService, FulfillmentService, OrderService } from '@hatti/orders/public';
import { DiscountCodeService } from '@hatti/pricing/public';
import pg from 'pg';
import { CartService } from './cart.service.js';
import { CheckoutService } from './checkout.service.js';
import { CodRulesService } from './cod-rules.service.js';
import { DeliveryService } from './delivery.service.js';

export interface OutboxRow {
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

export interface CheckoutFixture {
  testDb: TestDatabase;
  db: Database;
  admin: pg.Client;
  /** Two shops, so every test can check the other one sees nothing. */
  a: TenantContext;
  b: TenantContext;
  carts: CartService;
  delivery: DeliveryService;
  /** The shop's rules for cash on delivery. */
  codRules: CodRulesService;
  checkouts: CheckoutService;
  orders: OrderService;
  /** Parcels of the orders module's orders, to ship and bring back. */
  fulfillments: FulfillmentService;
  /** The orders module's bank account for transfers. */
  bankTransfer: BankTransferService;
  /** The pricing module's discount codes. */
  codes: DiscountCodeService;
  blocklist: BlocklistService;
  products: ProductService;
  variants: VariantService;
  /** An active product with a variant per size (or one without sizes); its variant IDs. */
  variantsOf(
    tenant: TenantContext,
    title: string,
    options?: { sizes?: string[]; price?: string; tags?: string[] },
  ): Promise<string[]>;
  /** Sets on-hand stock of a variant at the shop's primary location, which tracks it. */
  stock(tenant: TenantContext, variantId: string, quantity: number): Promise<void>;
  /** Events recorded so far, oldest first. */
  outbox(): Promise<OutboxRow[]>;
  /**
   * Empties checkouts, carts, delivery charges and cash on delivery's rules, discount codes, orders
   * and their customers, bank accounts, the catalog, stock, policies, themes and the outbox between
   * tests.
   */
  reset(): Promise<void>;
  close(): Promise<void>;
}

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set(['write_products', 'write_inventory', 'write_locations', 'write_settings']),
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
  const carts = new CartService(db, variants, inventory);
  const delivery = new DeliveryService(db);
  const blocklist = new BlocklistService(db);
  const stock = new StockService();
  const orders = new OrderService(
    db,
    variants,
    locations,
    stock,
    new CustomerService(db),
    blocklist,
  );
  const storefronts = new StorefrontSite('https://hatti.test');
  return {
    testDb,
    db,
    admin,
    a,
    b,
    carts,
    delivery,
    codRules: new CodRulesService(db),
    checkouts: new CheckoutService(db, carts, delivery, orders, storefronts),
    orders,
    fulfillments: new FulfillmentService(db, stock),
    bankTransfer: new BankTransferService(db),
    codes: new DiscountCodeService(db),
    blocklist,
    products,
    variants,
    async variantsOf(owner, title, options = {}) {
      const price = options.price ?? '1,000';
      const created = await products.create(owner, {
        title,
        status: 'active',
        tags: options.tags ?? [],
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
    async outbox() {
      const { rows } = await admin.query<OutboxRow>(
        `SELECT event_type, aggregate_id, payload
           FROM platform.outbox_events ORDER BY occurred_at, id`,
      );
      return rows;
    },
    async reset() {
      await admin.query(`
        DELETE FROM checkout.checkouts;
        DELETE FROM checkout.carts;
        DELETE FROM checkout.delivery_settings;
        DELETE FROM checkout.cod_settings;
        DELETE FROM pricing.discount_redemptions;
        DELETE FROM pricing.discount_codes;
        DELETE FROM orders.orders;
        DELETE FROM orders.counters;
        DELETE FROM orders.bank_transfer_settings;
        DELETE FROM customers.customers;
        DELETE FROM customers.blocklist_entries;
        DELETE FROM catalog.products;
        DELETE FROM inventory.movements;
        DELETE FROM inventory.adjustments;
        DELETE FROM inventory.locations;
        DELETE FROM online_store.policies;
        DELETE FROM online_store.policy_versions;
        DELETE FROM online_store.themes;
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
