// Shared set-up for the orders module's database tests. Not part of the build.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicSite, StorefrontSite, type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import {
  BlocklistService,
  CustomerDataRegistry,
  CustomerDataService,
  CustomerService,
  CustomerTransferService,
  SegmentFieldRegistry,
  SegmentService,
} from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import {
  InventoryService,
  LocationService,
  StockService,
  type LocationRecord,
} from '@hatti/inventory/public';
import { LocalStorage } from '@hatti/storage';
import pg from 'pg';
import type { AddressInput } from './address.js';
import { BankTransferService } from './bank-transfer.service.js';
import { ORDER_SEGMENT_FACTS } from './customer-facts.js';
import { OrderDocumentService } from './document.service.js';
import { DraftOrderService } from './draft-order.service.js';
import { OrderExportService } from './order-export.service.js';
import { OrderLinkService } from './order-link.service.js';
import { FulfillmentService } from './fulfillment.service.js';
import { ORDER_CUSTOMER_DATA } from './order-customer-data.js';
import { OrderService, type OrderCreateInput } from './order.service.js';
import type { OrderRecord } from './records.js';
import { RefundService } from './refund.service.js';
import { OrderSettingsService } from './order-settings.service.js';
import { RiskSettingsService } from './risk-settings.service.js';
import { TransferReceiptService } from './transfer-receipt.service.js';

export interface OutboxRow {
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

export interface OrdersFixture {
  testDb: TestDatabase;
  db: Database;
  admin: pg.Client;
  /** Two shops, so every test can check the other one sees nothing. */
  a: TenantContext;
  b: TenantContext;
  products: ProductService;
  locations: LocationService;
  inventory: InventoryService;
  customers: CustomerService;
  blocklist: BlocklistService;
  /** With the order fields registered, as the application does at start-up. */
  segments: SegmentService;
  transfer: CustomerTransferService;
  /** Merging and erasing customers, with orders taking part as at start-up. */
  customerData: CustomerDataService;
  orders: OrderService;
  /** With links at https://hatti.test/d/…. */
  drafts: DraftOrderService;
  /** Orders' links, at https://hatti.test/o/…, taking receipts of transfers. */
  links: OrderLinkService;
  /** Storage in a directory of its own, at https://hatti.test/storage. */
  storage: LocalStorage;
  receipts: TransferReceiptService;
  fulfillments: FulfillmentService;
  riskSettings: RiskSettingsService;
  orderSettings: OrderSettingsService;
  bankTransfer: BankTransferService;
  documents: OrderDocumentService;
  exports: OrderExportService;
  refunds: RefundService;
  /** A product with a variant per size (or one without sizes), at a price; its variant ids. */
  variantsOf(
    tenant: TenantContext,
    title: string,
    options?: { sizes?: string[]; price?: string },
  ): Promise<string[]>;
  /** Sets on-hand stock of a variant at the shop's primary location. */
  stock(tenant: TenantContext, variantId: string, quantity: number): Promise<void>;
  primary(tenant: TenantContext): Promise<LocationRecord>;
  /** Places an order for one unit of each variant, failing the test on user errors. */
  order(
    tenant: TenantContext,
    variantIds: string[],
    extra?: Partial<OrderCreateInput>,
  ): Promise<OrderRecord>;
  /** Stock of a variant at the primary location. */
  level(
    tenant: TenantContext,
    variantId: string,
  ): Promise<{ onHand: number; committed: number; available: number } | undefined>;
  outbox(): Promise<OutboxRow[]>;
  /**
   * Empties drafts, orders, risk settings, customers, the catalog, stock, themes, files, sales tax
   * and the outbox between tests.
   */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A valid Karachi address. */
export const ADDRESS: AddressInput = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  address1: 'House 12, Street 4, Block 5',
  address2: 'Gulshan-e-Iqbal',
  landmark: 'Near Jamia Masjid',
  city: 'khi',
  zip: '75300',
};

function tenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: new Set([
      'write_products',
      'write_inventory',
      'write_locations',
      'write_orders',
      'write_customers',
    ]),
  };
}

export async function ordersFixture(server: string): Promise<OrdersFixture> {
  const testDb = await createTestDatabase(server);
  const db = new Database({ appUrl: testDb.appUrl, applicationName: 'orders-test' });
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
  const customers = new CustomerService(db);
  const blocklist = new BlocklistService(db);
  const registry = new SegmentFieldRegistry();
  registry.register(ORDER_SEGMENT_FACTS);
  const segments = new SegmentService(db, registry);
  const dataRegistry = new CustomerDataRegistry();
  dataRegistry.register(ORDER_CUSTOMER_DATA);
  const orders = new OrderService(db, variants, locations, stock, customers, blocklist);
  const site = new PublicSite('https://hatti.test');
  const directory = await mkdtemp(join(tmpdir(), 'hatti-orders-'));
  const storage = new LocalStorage({
    directory,
    baseUrl: 'https://hatti.test/storage',
    secret: 's'.repeat(32),
  });
  const receipts = new TransferReceiptService(db, storage);
  return {
    testDb,
    db,
    admin,
    a,
    b,
    products,
    locations,
    inventory,
    customers,
    blocklist,
    segments,
    transfer: new CustomerTransferService(db, registry, segments),
    customerData: new CustomerDataService(db, dataRegistry),
    orders,
    drafts: new DraftOrderService(
      db,
      variants,
      locations,
      orders,
      site,
      new StorefrontSite('https://hatti.test'),
      receipts,
      storage,
    ),
    links: new OrderLinkService(db, orders, site, receipts, storage),
    storage,
    receipts,
    fulfillments: new FulfillmentService(db, stock),
    riskSettings: new RiskSettingsService(db),
    orderSettings: new OrderSettingsService(db),
    bankTransfer: new BankTransferService(db),
    documents: new OrderDocumentService(db, locations),
    exports: new OrderExportService(db),
    refunds: new RefundService(db),
    async variantsOf(owner, title, options = {}) {
      const price = options.price ?? '1,000';
      const created = await products.create(owner, {
        title,
        status: 'active',
        ...(options.sizes
          ? {
              options: [{ name: 'Size', values: options.sizes }],
              variants: options.sizes.map((size) => ({
                optionValues: [size],
                price,
                sku: `${title.slice(0, 3).toUpperCase()}-${size}`,
              })),
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
    primary: (owner) => locations.primary(owner),
    async order(owner, variantIds, extra = {}) {
      return unwrap(
        await orders.create(owner, {
          lineItems: variantIds.map((variantId) => ({ variantId, quantity: 1 })),
          shippingAddress: ADDRESS,
          ...extra,
        }),
      );
    },
    async level(owner, variantId) {
      const item = await inventory.item(owner, variantId);
      const primary = await locations.primary(owner);
      return item?.levels.find((level) => level.location.id === primary.id);
    },
    async outbox() {
      const { rows } = await admin.query<OutboxRow>(
        `SELECT event_type, aggregate_id, payload FROM platform.outbox_events
          ORDER BY occurred_at, id`,
      );
      return rows;
    },
    async reset() {
      await admin.query(`
        DELETE FROM orders.draft_orders;
        DELETE FROM orders.orders;
        DELETE FROM orders.counters;
        DELETE FROM orders.bank_transfer_settings;
        DELETE FROM orders.risk_settings;
        DELETE FROM orders.order_settings;
        DELETE FROM catalog.products;
        DELETE FROM inventory.movements;
        DELETE FROM inventory.adjustments;
        DELETE FROM inventory.locations;
        DELETE FROM customers.consent_events;
        DELETE FROM customers.customers;
        DELETE FROM customers.blocklist_entries;
        DELETE FROM online_store.themes;
        DELETE FROM online_store.policies;
        DELETE FROM online_store.policy_versions;
        DELETE FROM files.brands;
        DELETE FROM files.files;
        DELETE FROM tax.settings;
        DELETE FROM platform.outbox_events;`);
    },
    async close() {
      await db.close();
      await admin.end();
      await testDb.drop();
      await rm(directory, { recursive: true, force: true });
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
