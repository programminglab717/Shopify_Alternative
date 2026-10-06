// Shared set-up for the payments module's database tests. Not part of the build.
import { PublicSite, StorefrontSite, type MutationResult, type TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { SecretBox } from '@hatti/crypto';
import { BlocklistService, CustomerService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import {
  BankTransferService,
  OrderLinkService,
  OrderService,
  RefundService,
  type OrderRecord,
} from '@hatti/orders/public';
import pg from 'pg';
import { GatewayAccountService } from './gateway-accounts.service.js';
import {
  AlfalahGateway,
  BaadmayGateway,
  EasypaisaGateway,
  HblGateway,
  PayFastGateway,
  JazzCashGateway,
  PaymentGateways,
  SafepayGateway,
  TestGateway,
} from './gateways.js';
import { OnlinePaymentSettingsService } from './online-payment-settings.service.js';
import { OnlinePaymentService } from './online-payment.service.js';

export interface OutboxRow {
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

export interface PaymentsFixture {
  testDb: TestDatabase;
  db: Database;
  admin: pg.Client;
  /** Two shops, so every test can check the other one sees nothing. */
  a: TenantContext;
  b: TenantContext;
  orders: OrderService;
  links: OrderLinkService;
  /** Refunds, ONLINE ones given back through the gateway (ADR-153). */
  refunds: RefundService;
  /** Safepay, nowhere it can be reached unless a test says, and the test gateway. */
  gateways: PaymentGateways;
  testGateway: TestGateway;
  accounts: GatewayAccountService;
  payments: OnlinePaymentService;
  /** What paying online takes off (ADR-222). */
  settings: OnlinePaymentSettingsService;
  /** An active product with one variant at `price`, stocked: its variant's ID. */
  variantOf(tenant: TenantContext, title: string, price: string): Promise<string>;
  /**
   * An order of one `variantId` waiting for its money: by bank transfer, into the shop's account,
   * unless it asks for an advance on cash on delivery, confirmed.
   */
  awaiting(
    tenant: TenantContext,
    variantId: string,
    options?: { advanceDue?: string },
  ): Promise<OrderRecord>;
  /** A new link for the order's customer: its secret. */
  linkOf(tenant: TenantContext, orderId: string): Promise<string>;
  /** The test gateway's account for the shop, connected: its ID. */
  connectTest(tenant: TenantContext, environment?: 'sandbox' | 'production'): Promise<string>;
  /** The order's timeline, the latest first. */
  timeline(tenant: TenantContext, orderId: string): Promise<string[]>;
  /** Events recorded so far, oldest first. */
  outbox(): Promise<OutboxRow[]>;
  /** Empties payments, orders and their customers, the catalog, stock and the outbox. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

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
      'write_settings',
    ]),
  };
}

export async function paymentsFixture(
  server: string,
  options: {
    safepayUrl?: string;
    easypaisaUrl?: string;
    baadmayUrl?: string;
    payfastUrl?: string;
    alfalahUrl?: string;
    hblUrl?: string;
  } = {},
): Promise<PaymentsFixture> {
  const testDb = await createTestDatabase(server);
  const db = new Database({
    appUrl: testDb.appUrl,
    systemUrl: testDb.systemUrl,
    applicationName: 'payments-test',
  });
  const admin = new pg.Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  const a = tenant(newId());
  const b = tenant(newId());
  await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'B')`, [
    a.shopId,
    b.shopId,
  ]);
  const products = new ProductService(db);
  const variants = new VariantService(db);
  const locations = new LocationService(db);
  const inventory = new InventoryService(db, variants);
  const stock = new StockService();
  const site = new PublicSite('https://hatti.test');
  const box = new SecretBox([{ id: 'test', key: Buffer.alloc(32, 5) }]);
  const testGateway = new TestGateway();
  const safepay = options.safepayUrl ?? 'http://127.0.0.1:9/safepay';
  const easypaisa = options.easypaisaUrl ?? 'http://127.0.0.1:9/easypaisa';
  const baadmay = options.baadmayUrl ?? 'http://127.0.0.1:9/baadmay';
  const payfast = options.payfastUrl ?? 'http://127.0.0.1:9/payfast';
  const alfalah = options.alfalahUrl ?? 'http://127.0.0.1:9/alfalah';
  const hbl = {
    api: `${options.hblUrl ?? 'http://127.0.0.1:9'}/api`,
    page: `${options.hblUrl ?? 'http://127.0.0.1:9'}/page#/checkout?data=`,
  };
  const gateways = new PaymentGateways([
    new HblGateway({ urls: { sandbox: hbl, production: hbl }, timeoutMs: 2_000 }),
    new AlfalahGateway({ urls: { sandbox: alfalah, production: alfalah }, timeoutMs: 2_000 }),
    new PayFastGateway({ urls: { sandbox: payfast, production: payfast }, timeoutMs: 2_000 }),
    new BaadmayGateway({
      urls: {
        sandbox: { checkout: baadmay, api: baadmay },
        production: { checkout: baadmay, api: baadmay },
      },
      timeoutMs: 2_000,
    }),
    new SafepayGateway({
      urls: {
        sandbox: { api: safepay, checkout: `${safepay}/checkout` },
        production: { api: safepay, checkout: `${safepay}/checkout` },
      },
      timeoutMs: 2_000,
    }),
    new JazzCashGateway(),
    new EasypaisaGateway({
      urls: { sandbox: easypaisa, production: easypaisa },
      timeoutMs: 2_000,
    }),
    testGateway,
  ]);
  const accounts = new GatewayAccountService(db, box, site, gateways);
  const payments = new OnlinePaymentService(db, accounts, gateways);
  // Orders paid online need the shop's gateway (ADR-152).
  const orders = new OrderService(
    db,
    variants,
    locations,
    stock,
    new CustomerService(db),
    new BlocklistService(db),
    payments,
  );
  const links = new OrderLinkService(
    db,
    orders,
    site,
    new StorefrontSite('https://hatti.test'),
    undefined,
    undefined,
    payments,
  );
  const bankTransfer = new BankTransferService(db);
  const refunds = new RefundService(db, payments);
  return {
    testDb,
    db,
    admin,
    a,
    b,
    orders,
    links,
    refunds,
    gateways,
    testGateway,
    accounts,
    payments,
    settings: new OnlinePaymentSettingsService(db),
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
    async awaiting(owner, variantId, options = {}) {
      unwrap(
        await bankTransfer.update(owner, {
          enabled: true,
          account: {
            title: 'Zari Textiles',
            bankName: 'Standard Chartered',
            iban: 'PK36 SCBL 0000 0011 2345 6702',
          },
        }),
      );
      const placed = unwrap(
        await orders.create(owner, {
          lineItems: [{ variantId, quantity: 1 }],
          shippingAddress: {
            name: 'Ayesha Khan',
            phone: '0300 1234567',
            address1: 'House 12, Street 4',
            city: 'Lahore',
          },
          ...(options.advanceDue
            ? { advanceDue: options.advanceDue }
            : { paymentMethod: 'bank_transfer' as const }),
        }),
      );
      if (options.advanceDue) unwrap(await orders.confirm(owner, placed.id));
      return (await orders.get(owner, placed.id))!;
    },
    async linkOf(owner, orderId) {
      return unwrap(await links.createLink(owner, orderId)).url.split('/o/')[1]!;
    },
    async connectTest(owner, environment = 'production') {
      return unwrap(
        await accounts.connect(owner, {
          gateway: 'test',
          environment,
          credentials: [{ key: 'secret', value: `secret-${owner.shopId.slice(0, 8)}` }],
        }),
      ).id;
    },
    async timeline(owner, orderId) {
      return (await orders.timeline(owner, orderId, { first: 20 })).items.map(
        (entry) => entry.message,
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
      testGateway.checkouts.length = 0;
      testGateway.refusing = null;
      testGateway.refunds.length = 0;
      testGateway.refundAnswer = null;
      testGateway.whileRefunding = null;
      testGateway.info.refunds = 'partial';
      await admin.query(`
        DELETE FROM payments.refunds;
        DELETE FROM payments.sessions;
        DELETE FROM payments.gateway_accounts;
        DELETE FROM payments.online_payment_settings;
        DELETE FROM platform.audit_log;
        DELETE FROM orders.orders;
        DELETE FROM orders.counters;
        DELETE FROM orders.bank_transfer_settings;
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
