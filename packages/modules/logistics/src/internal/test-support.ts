// Shared set-up for the logistics module's database tests. Not part of the build.
import type { MutationResult, TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { SecretBox } from '@hatti/crypto';
import { BlocklistService, CustomerService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { createTestDatabase, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import { FulfillmentService, OrderService, orderShipmentFactsIn } from '@hatti/orders/public';
import pg from 'pg';
import { CourierBookingService } from './bookings.service.js';
import { CourierAccountService } from './courier-accounts.service.js';
import { CourierDocumentService } from './courier-documents.service.js';
import { Couriers, PostExCourier, TestCourier } from './couriers.js';
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
  /** The keys couriers' credentials are sealed with. */
  box: SecretBox;
  /** PostEx, nowhere it can be reached, and the test courier. */
  couriers: Couriers;
  testCourier: TestCourier;
  accounts: CourierAccountService;
  bookings: CourierBookingService;
  documents: CourierDocumentService;
  /**
   * As {@link confirmed}, and booked with the shop's default account as the worker books it: the
   * courier's number kept, then the order shipped as a parcel with it.
   */
  booked(
    tenant: TenantContext,
    variantId: string,
    options?: { quantity?: number; phone?: string; city?: string },
  ): Promise<{
    orderId: string;
    number: number;
    bookingId: string;
    fulfillmentId: string;
    trackingNumber: string;
  }>;
  /** A confirmed cash-on-delivery order of `quantity` of `variantId`, to ship. */
  confirmed(
    tenant: TenantContext,
    variantId: string,
    options?: { quantity?: number; phone?: string; city?: string },
  ): Promise<{ orderId: string; number: number }>;
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
  const db = new Database({
    appUrl: testDb.appUrl,
    systemUrl: testDb.systemUrl,
    applicationName: 'logistics-test',
  });
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
  const box = new SecretBox([{ id: 'test', key: Buffer.alloc(32, 7) }]);
  const testCourier = new TestCourier();
  const couriers = new Couriers([
    new PostExCourier({ baseUrl: 'http://127.0.0.1:9/postex', timeoutMs: 1_000 }),
    testCourier,
  ]);
  const accounts = new CourierAccountService(db, box, couriers);
  const bookings = new CourierBookingService(db, couriers);
  const confirmed: LogisticsFixture['confirmed'] = async (owner, variantId, options = {}) => {
    const placed = unwrap(
      await orders.create(owner, {
        lineItems: [{ variantId, quantity: options.quantity ?? 1 }],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: options.phone ?? '0300 1234567',
          address1: 'House 12, Street 4',
          address2: 'Gulberg III',
          landmark: 'near Liberty Market',
          city: options.city ?? 'Lahore',
        },
      }),
    );
    unwrap(await orders.confirm(owner, placed.id));
    return { orderId: placed.id, number: placed.number };
  };
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
    box,
    couriers,
    testCourier,
    accounts,
    bookings,
    documents: new CourierDocumentService(db, couriers, locations),
    confirmed,
    async booked(owner, variantId, options = {}) {
      const order = await confirmed(owner, variantId, options);
      const [booking] = unwrap(
        await bookings.request(owner, { orderIds: [order.orderId] }),
      ).bookings;
      const facts = await db.tenant(owner.shopId, (tx) =>
        orderShipmentFactsIn(tx, owner.shopId, order.orderId),
      );
      const trackingNumber = `HT${String(order.number).padStart(10, '0')}`;
      await bookings.recordTrackingNumber(
        owner.shopId,
        booking!.id,
        trackingNumber,
        facts!.codAmount,
      );
      const { fulfillmentId } = unwrap(
        await fulfillments.fulfill({ shopId: owner.shopId, actor: 'system' }, order.orderId, {
          tracking: { company: 'Test courier', number: trackingNumber },
        }),
      );
      await bookings.markBooked(owner.shopId, booking!.id, { fulfillmentId, at: new Date() });
      return { ...order, bookingId: booking!.id, fulfillmentId, trackingNumber };
    },
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
        DELETE FROM logistics.bookings;
        DELETE FROM logistics.courier_accounts;
        DELETE FROM logistics.courier_cities;
        DELETE FROM platform.audit_log;
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
