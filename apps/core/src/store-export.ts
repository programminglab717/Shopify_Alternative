import { PublicSite, type TenantContext } from '@hatti/api';
import { ProductExportService, StockFileService, VariantService } from '@hatti/catalog/public';
import {
  CustomerTransferService,
  SegmentFieldRegistry,
  SegmentService,
} from '@hatti/customers/public';
import type { Database } from '@hatti/db';
import { toPublicId } from '@hatti/ids';
import { InventoryService } from '@hatti/inventory/public';
import { UrlRedirectService } from '@hatti/online-store/public';
import { ORDER_SEGMENT_FACTS, OrderExportService } from '@hatti/orders/public';
import { stockLevelsOf } from './api/inventory-file.resolver.js';
import { exportStockOf } from './api/products-export.resolver.js';

/**
 * How much the whole store's export takes, past each export's own limits for one download: as
 * much as a worker holds in memory at once, a store far larger than Hatti's shops are.
 */
export const STORE_EXPORT_SIZES = {
  rows: 2_000_000,
  characters: 400_000_000,
  orders: 1_000_000,
  lines: 4_000_000,
} as const;

/** A part of the store that could not be exported, in words for its owner. */
export class StoreExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreExportError';
  }
}

/** A file of the ZIP, by its path in it. */
export interface StoreExportFile {
  path: string;
  data: Buffer;
}

/** What the whole store's export reads, each part through its own module's export. */
export interface StoreExportSources {
  products: ProductExportService;
  stock: StockFileService;
  inventory: InventoryService;
  customers: CustomerTransferService;
  orders: OrderExportService;
  redirects: UrlRedirectService;
}

/**
 * The whole store as files (ADM-10, ADR-415), each in the format its own export writes, so that
 * each goes back in where an import takes it: Shopify's product and inventory CSVs, the
 * customers' CSV, the orders a row each and their line items a row each, and Shopify's redirects
 * CSV; and a README saying what each is. Made as `tenant`, an owner: each export's audit and
 * watermarks name them.
 */
export class StoreExportBuilder {
  constructor(private readonly sources: StoreExportSources) {}

  async files(tenant: TenantContext, at: Date): Promise<StoreExportFile[]> {
    const { products, stock, inventory, customers, orders, redirects } = this.sources;
    const sizes = { rows: STORE_EXPORT_SIZES.rows, csv: STORE_EXPORT_SIZES.characters };
    const productFile = must(
      'products',
      await products.export(
        tenant,
        '',
        (variantIds) => exportStockOf(inventory, tenant, variantIds),
        sizes,
      ),
    );
    const stockFile = must(
      'stock',
      await stock.export(
        tenant,
        '',
        (variantIds) => stockLevelsOf(inventory, tenant, variantIds),
        sizes,
      ),
    );
    const customerFile = must(
      'customers',
      await customers.export(tenant, {}, { rows: STORE_EXPORT_SIZES.rows }),
    );
    const orderLimits = { orders: STORE_EXPORT_SIZES.orders, lines: STORE_EXPORT_SIZES.lines };
    const orderFile = must(
      'orders',
      await orders.export(tenant, { layout: 'orders', format: 'csv' }, orderLimits),
    );
    const lineFile = must(
      'orders',
      await orders.export(tenant, { layout: 'line_items', format: 'csv' }, orderLimits),
    );
    const redirectFile = await redirects.export(tenant);

    const exporter =
      tenant.actor.kind === 'staff' ? toPublicId('user', tenant.actor.userId) : 'Hatti';
    const readme = [
      `The whole store, exported on ${at.toISOString()} by ${exporter}.`,
      '',
      `products.csv: ${count(productFile.products, 'product')}, in Shopify's product CSV, which ` +
        "Shopify's product import and Hatti's take back.",
      `inventory.csv: stock at each location, in Shopify's inventory CSV, which Shopify's ` +
        "inventory import and Hatti's take back.",
      `customers.csv: ${count(customerFile.rowCount, 'customer')}, as Customers > Export ` +
        "writes them, which Hatti's customer import takes back.",
      `orders.csv: ${count(orderFile.rowCount, 'order')}, a row each.`,
      `order-line-items.csv: ${count(lineFile.rowCount, 'line item')}, a row each, with ` +
        "their order's details beside them.",
      `redirects.csv: ${count(redirectFile.count, 'URL redirect')}, in Shopify's redirects ` +
        "CSV, which Shopify's import and Hatti's take back.",
      '',
      "Customers' numbers and addresses are personal data: keep this file safe, and delete it " +
        'once it is no longer needed.',
      '',
    ].join('\r\n');
    return [
      { path: 'README.txt', data: Buffer.from(readme, 'utf8') },
      { path: 'products.csv', data: Buffer.from(productFile.csv, 'utf8') },
      { path: 'inventory.csv', data: Buffer.from(stockFile.csv, 'utf8') },
      { path: 'customers.csv', data: Buffer.from(customerFile.csv, 'utf8') },
      { path: 'orders.csv', data: orderFile.file.content },
      { path: 'order-line-items.csv', data: lineFile.file.content },
      { path: 'redirects.csv', data: Buffer.from(redirectFile.csv, 'utf8') },
    ];
  }
}

/** The builder over `database`, its products' images served at `site`, as the worker makes it. */
export function storeExportBuilder(database: Database, site: PublicSite): StoreExportBuilder {
  const registry = new SegmentFieldRegistry();
  registry.register(ORDER_SEGMENT_FACTS);
  return new StoreExportBuilder({
    products: new ProductExportService(database, site),
    stock: new StockFileService(database),
    inventory: new InventoryService(database, new VariantService(database)),
    customers: new CustomerTransferService(
      database,
      registry,
      new SegmentService(database, registry),
    ),
    orders: new OrderExportService(database),
    redirects: new UrlRedirectService(database),
  });
}

function must<T>(
  part: string,
  result: { ok: true; value: T } | { ok: false; errors: { message: string }[] },
): T {
  if (!result.ok) {
    throw new StoreExportError(`The ${part} could not be exported: ${result.errors[0]!.message}`);
  }
  return result.value;
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString('en')} ${noun}${n === 1 ? '' : 's'}`;
}
