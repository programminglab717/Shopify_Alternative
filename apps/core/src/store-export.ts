import { PublicSite, type TenantContext } from '@hatti/api';
import {
  CollectionService,
  CombinedListingService,
  ProductExportService,
  StockFileService,
  VariantService,
} from '@hatti/catalog/public';
import {
  CustomerTransferService,
  SegmentFieldRegistry,
  SegmentService,
} from '@hatti/customers/public';
import type { Database } from '@hatti/db';
import { toPublicId } from '@hatti/ids';
import { InventoryService } from '@hatti/inventory/public';
import {
  ArticleService,
  BlogService,
  PageService,
  UrlRedirectService,
} from '@hatti/online-store/public';
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
  combinedListings: CombinedListingService;
  collections: CollectionService;
  pages: PageService;
  blogs: BlogService;
  articles: ArticleService;
}

/** Records read a page at a time, as many as there are. */
const PAGE = 250;

/**
 * The whole store as files (ADM-10, ADR-415, ADR-417), each in the format its own export writes,
 * so that each goes back in where an import takes it: Shopify's product and inventory CSVs, the
 * customers' CSV, the orders a row each and their line items a row each, and Shopify's redirects
 * CSV; the online store's collections, pages and blogs, and the combined listings (ADR-902), as
 * JSON; and a README saying what each is.
 * Made as `tenant`, an owner: each export's audit and watermarks name them.
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
    const content = await this.#content(tenant);
    const listings = await this.#combinedListings(tenant);

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
      `collections.json: ${count(content.collections.length, 'collection')}, with the ` +
        "rules of automated ones and the products' handles of manual ones.",
      `pages.json: ${count(content.pages.length, 'page')} of the online store.`,
      `blogs.json: ${count(content.blogs.length, 'blog')}, each with its articles.`,
      `combined-listings.json: ${count(listings.length, 'combined listing')}, each with its ` +
        "option and its products' handles and values, in English and Urdu.",
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
      { path: 'collections.json', data: json(content.collections) },
      { path: 'pages.json', data: json(content.pages) },
      { path: 'blogs.json', data: json(content.blogs) },
      { path: 'combined-listings.json', data: json(listings) },
    ];
  }

  /**
   * The shop's combined listings (ADR-902), the oldest first, each its option, whether it is one
   * card in collections, and its products by handle with their values, in English and Urdu.
   */
  async #combinedListings(tenant: TenantContext) {
    const { combinedListings } = this.sources;
    const listings = (await combinedListings.list(tenant)).reverse();
    const products = await combinedListings.productsOf(
      tenant,
      listings.flatMap((listing) => listing.products.map((product) => product.productId)),
    );
    return listings.map((listing) => ({
      optionName: listing.optionName,
      optionNameUr: listing.optionNameUr,
      oneCard: listing.oneCard,
      products: listing.products.map((product) => ({
        handle: products.get(product.productId)?.handle ?? null,
        value: product.value,
        valueUr: product.valueUr,
      })),
    }));
  }

  /**
   * The online store's content, which no CSV of Shopify's carries: its collections, pages, and
   * blogs with their articles, as JSON under their handles, each as the Admin API names its
   * fields.
   */
  async #content(tenant: TenantContext) {
    const { collections, pages, blogs, articles } = this.sources;
    const collected = [];
    for (const collection of await all((after) =>
      collections.list(tenant, { first: PAGE, after }),
    )) {
      const products: string[] = [];
      if (collection.rules === null) {
        let after: Parameters<CollectionService['products']>[2]['after'] = null;
        for (;;) {
          const page = await collections.products(tenant, collection.id, { first: PAGE, after });
          if (!page) break;
          products.push(...page.items.map((product) => product.handle));
          if (!page.hasNextPage) break;
          after = page.cursors.at(-1)!;
        }
      }
      collected.push({
        handle: collection.handle,
        title: collection.title,
        description: collection.description,
        sortOrder: collection.sortOrder,
        rules: collection.rules,
        disjunctive: collection.disjunctive,
        seo: collection.seo,
        ...(collection.rules === null ? { products } : {}),
      });
    }
    const pageList = (await all((after) => pages.list(tenant, { first: PAGE, after }))).map(
      (page) => ({
        handle: page.handle,
        title: page.title,
        body: page.body,
        isPublished: page.isPublished,
        publishedAt: page.publishedAt,
        templateSuffix: page.templateSuffix,
        seo: page.seo,
      }),
    );
    const blogList = [];
    for (const blog of await all((after) => blogs.list(tenant, { first: PAGE, after }))) {
      const written = await all((after) =>
        articles.list(tenant, { first: PAGE, after, blogId: blog.id }),
      );
      blogList.push({
        handle: blog.handle,
        title: blog.title,
        commentPolicy: blog.commentPolicy,
        templateSuffix: blog.templateSuffix,
        seo: blog.seo,
        articles: written.map((article) => ({
          handle: article.handle,
          title: article.title,
          body: article.body,
          summary: article.summary,
          author: article.author,
          tags: article.tags,
          isPublished: article.isPublished,
          publishedAt: article.publishedAt,
          templateSuffix: article.templateSuffix,
          seo: article.seo,
        })),
      });
    }
    return { collections: collected, pages: pageList, blogs: blogList };
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
    combinedListings: new CombinedListingService(database),
    collections: new CollectionService(database),
    pages: new PageService(database),
    blogs: new BlogService(database),
    articles: new ArticleService(database),
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

/** Every record a list gives, a page at a time, each page after the last one's last. */
async function all<T extends { id: string }>(
  list: (after: string | null) => Promise<{ items: T[]; hasNextPage: boolean }>,
): Promise<T[]> {
  const records: T[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await list(after);
    records.push(...page.items);
    if (!page.hasNextPage || page.items.length === 0) return records;
    after = page.items.at(-1)!.id;
  }
}

/** Indented JSON, as people read it. */
function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString('en')} ${noun}${n === 1 ? '' : 's'}`;
}
