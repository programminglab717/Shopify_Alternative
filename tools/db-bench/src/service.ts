import type { TenantContext } from '@hatti/api';
import { ProductService, VariantService } from '@hatti/catalog/public';
import { CartService } from '@hatti/checkout/public';
import { BlocklistService, CustomerService } from '@hatti/customers/public';
import { Database } from '@hatti/db';
import { newId } from '@hatti/ids';
import { InventoryService, LocationService, StockService } from '@hatti/inventory/public';
import { OrderService } from '@hatti/orders/public';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { shopClass, shopUuid, type ShopClass, type ShopSize } from './dataset.js';
import { cartToken } from './sales.js';
import type { Path, Settings } from './settings.js';
import { summarize, type LatencySummary } from './stats.js';

export const OPERATIONS = {
  /** ProductService.list, first page of 50: what the admin products page runs. */
  list: 'ProductService.list (50 products)',
  /** OrderService.list, first page of 50, newest first: the admin's orders page. */
  orders: 'OrderService.list (50 orders)',
  /** The same for the tabs of the orders page and a customer's page, and the page after. */
  'orders-stage': 'OrderService.list (50 orders to confirm)',
  'orders-risk': 'OrderService.list (50 high-risk orders)',
  'customer-orders': "OrderService.list (a customer's orders)",
  'orders-next': 'OrderService.list (the next 50 orders)',
  /** OrderService.get: an order's page, and what every change to an order answers with. */
  order: 'OrderService.get (one order)',
  /** OrderService.getMany: the orders a page's loader asks for by ID. */
  'orders-by-id': 'OrderService.getMany (10 orders)',
  /** OrderService.timeline: an order's page's newest 50 events. */
  'order-timeline': "OrderService.timeline (an order's 50 newest events)",
  /** LocationService.getMany: the location an order's page's loader asks for. */
  'order-location': "LocationService.getMany (an order's location)",
  /** CustomerService.list, first page of 50: the admin's customers page. */
  customers: 'CustomerService.list (50 customers)',
  /** CartService.cart: a shopper's cart priced now, as the storefront asks for it. */
  cart: 'CartService.cart (one cart)',
  /** db.tenant() around `select 1`: begin with set_config, select, commit. */
  'tenant-select-1': 'Tenant transaction around select 1',
  /** A single statement outside any transaction. */
  'select-1': 'select 1',
} as const;

export type Operation = keyof typeof OPERATIONS;

/** The operations that read a shop's data, which the `prepared` command checks. */
export const SHOP_OPERATIONS = [
  'list',
  'orders',
  'orders-stage',
  'orders-risk',
  'customer-orders',
  'orders-next',
  'order',
  'orders-by-id',
  'order-timeline',
  'order-location',
  'customers',
  'cart',
] as const;

export interface ServiceRun {
  operation: Operation;
  path: Path;
  concurrency: number;
  shops: ShopSize;
}

export interface ServiceResult extends ServiceRun {
  ok: boolean;
  error?: string;
  latency?: LatencySummary;
}

function tenantFor(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    scopes: new Set(['read_products', 'read_orders', 'read_customers']),
    actor: { kind: 'app', tokenId: newId() },
  };
}

/** The application's services over `db`, built as the API's modules build them. */
export function servicesOf(db: Database) {
  const variants = new VariantService(db);
  const customers = new CustomerService(db);
  const locations = new LocationService(db);
  return {
    products: new ProductService(db),
    orders: new OrderService(
      db,
      variants,
      locations,
      new StockService(),
      customers,
      new BlocklistService(db),
    ),
    locations,
    customers,
    carts: new CartService(db, variants, new InventoryService(db, variants)),
  };
}

/**
 * What the shops of a class have to read: some of each shop's orders, every tenth, and how many
 * carts it keeps. Found as the superuser, so it costs the measured runs nothing.
 */
export interface ShopSamples {
  shops: ShopClass;
  orders: Map<number, { id: string; customerId: string; locationId: string }[]>;
  carts: Map<number, number>;
}

export async function samplesOf(settings: Settings, shops: ShopClass): Promise<ShopSamples> {
  const admin = new pg.Client({ connectionString: settings.benchAdminUrl });
  await admin.connect();
  try {
    const ids = Array.from({ length: shops.count }, (_, i) => shopUuid(shops.first + i));
    const orders = await admin.query<{
      n: number;
      id: string;
      customer_id: string;
      location_id: string;
    }>(
      `SELECT substring(shop_id::text from 25)::int AS n, id, customer_id, location_id
         FROM orders.orders WHERE shop_id = ANY($1::uuid[]) AND number % 10 = 1`,
      [ids],
    );
    const carts = await admin.query<{ n: number; count: string }>(
      `SELECT substring(shop_id::text from 25)::int AS n, count(*)
         FROM checkout.carts WHERE shop_id = ANY($1::uuid[]) GROUP BY shop_id`,
      [ids],
    );
    const byShop = new Map<number, { id: string; customerId: string; locationId: string }[]>();
    for (const row of orders.rows) {
      byShop.set(row.n, [
        ...(byShop.get(row.n) ?? []),
        { id: row.id, customerId: row.customer_id, locationId: row.location_id },
      ]);
    }
    return {
      shops,
      orders: byShop,
      carts: new Map(carts.rows.map((row) => [row.n, Number(row.count)])),
    };
  } finally {
    await admin.end();
  }
}

export type Services = ReturnType<typeof servicesOf>;

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

/**
 * Runs `operation` once for shop number `shop`, or for one of the class's shops that has what it
 * reads; returns the shop's number.
 */
export async function runOnce(
  db: Database,
  services: Services,
  samples: ShopSamples,
  operation: Operation,
  shop?: number,
): Promise<number> {
  const { shops } = samples;
  const number =
    shop ??
    (operation === 'order' ||
    operation === 'orders-by-id' ||
    operation === 'order-timeline' ||
    operation === 'order-location' ||
    operation === 'customer-orders'
      ? pick([...samples.orders.keys()])
      : operation === 'cart'
        ? pick([...samples.carts.keys()])
        : shops.first + Math.floor(Math.random() * shops.count));
  const shopId = shopUuid(number);
  switch (operation) {
    case 'list':
      await services.products.list(tenantFor(shopId), { first: 50 });
      break;
    case 'orders':
      await services.orders.list(tenantFor(shopId), { first: 50 });
      break;
    case 'orders-stage':
      await services.orders.list(tenantFor(shopId), { first: 50, stage: 'needs_confirmation' });
      break;
    case 'orders-risk':
      await services.orders.list(tenantFor(shopId), { first: 50, riskLevel: 'high' });
      break;
    case 'customer-orders': {
      const { customerId } = pick(samples.orders.get(number)!);
      await services.orders.list(tenantFor(shopId), { first: 50, customerId });
      break;
    }
    case 'orders-next': {
      const first = await services.orders.list(tenantFor(shopId), { first: 50 });
      const after = first.items.at(-1)?.id ?? null;
      await services.orders.list(tenantFor(shopId), { first: 50, after });
      break;
    }
    case 'order':
      await services.orders.get(tenantFor(shopId), pick(samples.orders.get(number)!).id);
      break;
    case 'orders-by-id': {
      const ids = samples.orders.get(number)!.map((order) => order.id);
      await services.orders.getMany(
        tenantFor(shopId),
        Array.from({ length: 10 }, () => pick(ids)),
      );
      break;
    }
    case 'order-timeline':
      await services.orders.timeline(tenantFor(shopId), pick(samples.orders.get(number)!).id, {
        first: 50,
      });
      break;
    case 'order-location':
      await services.locations.getMany(tenantFor(shopId), [
        pick(samples.orders.get(number)!).locationId,
      ]);
      break;
    case 'customers':
      await services.customers.list(tenantFor(shopId), { first: 50 });
      break;
    case 'cart': {
      const count = samples.carts.get(number)!;
      const found = await services.carts.cart(
        shopId,
        cartToken(number, 1 + Math.floor(Math.random() * count)),
      );
      if (!found) throw new Error(`No cart of shop ${number}`);
      break;
    }
    case 'tenant-select-1':
      await db.tenant(shopId, (tx) => tx.execute(sql`select 1`));
      break;
    case 'select-1':
      await db.app.execute(sql`select 1`);
      break;
  }
  return number;
}

/**
 * Runs the application's own code (Drizzle, node-postgres, row mapping) as hatti_app, so row-level
 * security applies. `concurrency` callers loop for the duration; each waits for its previous call.
 */
export async function runService(settings: Settings, run: ServiceRun): Promise<ServiceResult> {
  const samples = await samplesOf(settings, shopClass(settings.scale, run.shops));
  const db = new Database({
    appUrl: settings.url('rls', run.path),
    applicationName: 'db-bench',
    maxConnections: run.concurrency,
  });
  const services = servicesOf(db);

  const loop = async (seconds: number): Promise<number[]> => {
    const latencies: number[] = [];
    const end = performance.now() + seconds * 1_000;
    await Promise.all(
      Array.from({ length: run.concurrency }, async () => {
        while (performance.now() < end) {
          const start = performance.now();
          await runOnce(db, services, samples, run.operation);
          latencies.push(performance.now() - start);
        }
      }),
    );
    return latencies;
  };

  try {
    if (settings.warmupS > 0) await loop(settings.warmupS);
    const latencies = await loop(settings.durationS);
    return { ...run, ok: true, latency: summarize(latencies, settings.durationS) };
  } catch (error) {
    return { ...run, ok: false, error: rootMessage(error) };
  } finally {
    await db.close();
  }
}

/** Drizzle wraps driver errors; the driver's message is the useful one. */
export function rootMessage(error: unknown): string {
  let current = error as { message?: string; cause?: unknown };
  while (current.cause) current = current.cause as { message?: string; cause?: unknown };
  return current.message ?? String(error);
}
