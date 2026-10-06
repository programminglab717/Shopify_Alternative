// Shared set-up for the checkout module's database tests. Not part of the build.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicSite, StorefrontSite, type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { BlocklistService, CustomerService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, type TestDatabase } from '@hatti/db/testing';
import { BrandService, FileService } from '@hatti/files/public';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import { MessagesService } from '@hatti/messaging/public';
import {
  BankTransferService,
  FulfillmentService,
  OnlinePayments,
  OrderService,
  type OnlineGateway,
} from '@hatti/orders/public';
import type { Tx } from '@hatti/db';
import { DiscountCodeService } from '@hatti/pricing/public';
import { LocalStorage } from '@hatti/storage';
import pg from 'pg';
import { CartService } from './cart.service.js';
import { CheckoutService } from './checkout.service.js';
import { CodRulesService } from './cod-rules.service.js';
import { CheckoutMarketingService } from './marketing.service.js';
import { TrustBadgeService } from './trust-badge.service.js';
import { DeliveryService } from './delivery.service.js';

/**
 * The payments module as checkout sees it (ADR-152), standing in: the gateway a test sets, none
 * unless it does; what starting a payment answers; and what a return says.
 */
export class StubPayments extends OnlinePayments {
  gateway: OnlineGateway | null = null;
  answer: { url: string; form?: Readonly<Record<string, string>> } | { error: string } = {
    url: 'https://pay.test/checkout?session=1',
  };
  outcome: 'paid' | 'test' | { url: string; form: Readonly<Record<string, string>> } | null = null;
  /** The payments started, and the returns heard, the latest last. */
  readonly started: { shopId: string; orderId: string; returnUrl: string; cancelUrl: string }[] =
    [];
  readonly returns: {
    orderId: string;
    form: Readonly<Record<string, string>>;
    returnUrl: string;
  }[] = [];

  async gatewayOf(_tx: Tx, _shopId: string): Promise<OnlineGateway | null> {
    return this.gateway;
  }

  async start(
    shopId: string,
    orderId: string,
    urls: { returnUrl: string; cancelUrl: string },
  ): Promise<{ url: string; form?: Readonly<Record<string, string>> } | { error: string }> {
    this.started.push({ shopId, orderId, ...urls });
    return this.answer;
  }

  async returned(
    _shopId: string,
    orderId: string,
    form: Readonly<Record<string, string>>,
    returnUrl: string,
  ): Promise<'paid' | 'test' | { url: string; form: Readonly<Record<string, string>> } | null> {
    this.returns.push({ orderId, form, returnUrl });
    return this.outcome;
  }

  /** Checkout gives nothing back: refunds are staff's, through the payments module. */
  async refund(): Promise<MutationResult<{ refundId: string | null }>> {
    throw new Error('Checkout refunds nothing');
  }

  reset(): void {
    this.gateway = null;
    this.answer = { url: 'https://pay.test/checkout?session=1' };
    this.outcome = null;
    this.started.length = 0;
    this.returns.length = 0;
  }
}

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
  badges: TrustBadgeService;
  /** The channels the checkout's page offers boxes for the shop's news and offers on. */
  marketing: CheckoutMarketingService;
  checkouts: CheckoutService;
  orders: OrderService;
  /** The shop's gateway, as the payments module would give it: none unless a test sets one. */
  payments: StubPayments;
  /** Parcels of the orders module's orders, to ship and bring back. */
  fulfillments: FulfillmentService;
  /** The orders module's bank account for transfers. */
  bankTransfer: BankTransferService;
  /** The pricing module's discount codes. */
  codes: DiscountCodeService;
  blocklist: BlocklistService;
  products: ProductService;
  variants: VariantService;
  /** Storage in a directory of its own, at https://hatti.test/storage. */
  storage: LocalStorage;
  /** The files module's files and the shop's brand, its logo among them. */
  files: FileService;
  brands: BrandService;
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
   * Empties checkouts, carts, delivery charges, cash on delivery's rules and the boxes for the
   * shop's news and offers, discount codes, orders and their customers with their consent, bank
   * accounts, the catalog, stock, policies, themes, files and the outbox between tests.
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
  const payments = new StubPayments();
  const orders = new OrderService(
    db,
    variants,
    locations,
    stock,
    new CustomerService(db),
    blocklist,
    payments,
  );
  const storefronts = new StorefrontSite('https://hatti.test');
  const directory = await mkdtemp(join(tmpdir(), 'hatti-checkout-'));
  const storage = new LocalStorage({
    directory,
    baseUrl: 'https://hatti.test/storage',
    secret: 's'.repeat(32),
  });
  return {
    testDb,
    db,
    admin,
    a,
    b,
    carts,
    delivery,
    codRules: new CodRulesService(db),
    badges: new TrustBadgeService(db),
    marketing: new CheckoutMarketingService(db),
    checkouts: new CheckoutService(
      db,
      carts,
      delivery,
      orders,
      storefronts,
      storage,
      new MessagesService(db),
      payments,
      new PublicSite('https://hatti.test'),
    ),
    orders,
    payments,
    fulfillments: new FulfillmentService(db, stock),
    bankTransfer: new BankTransferService(db),
    codes: new DiscountCodeService(db),
    blocklist,
    products,
    variants,
    storage,
    files: new FileService(db, storage),
    brands: new BrandService(db),
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
      payments.reset();
      await admin.query(`
        DELETE FROM checkout.checkouts;
        DELETE FROM checkout.number_proofs;
        DELETE FROM checkout.carts;
        DELETE FROM checkout.delivery_settings;
        DELETE FROM checkout.cod_settings;
        DELETE FROM checkout.trust_badges;
        DELETE FROM checkout.marketing_options;
        DELETE FROM online_store.preferences;
        DELETE FROM pricing.discount_redemptions;
        DELETE FROM pricing.discount_codes;
        DELETE FROM orders.orders;
        DELETE FROM orders.counters;
        DELETE FROM orders.bank_transfer_settings;
        DELETE FROM customers.consent_events;
        DELETE FROM customers.customers;
        DELETE FROM customers.blocklist_entries;
        DELETE FROM catalog.products;
        DELETE FROM inventory.movements;
        DELETE FROM inventory.adjustments;
        DELETE FROM inventory.locations;
        DELETE FROM online_store.policies;
        DELETE FROM online_store.policy_versions;
        DELETE FROM online_store.themes;
        DELETE FROM files.brands;
        DELETE FROM files.files;
        DELETE FROM tax.settings;
        DELETE FROM messaging.messages;
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
