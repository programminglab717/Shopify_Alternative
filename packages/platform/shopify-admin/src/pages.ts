import type { ShopifyAdmin, ShopifyResult } from './admin.js';
import { jsonLines, runBulkQuery, type BulkQueryOptions } from './bulk.js';

/** A store's own pages, as Shopify's bulk queries take them. */
export const PAGES_BULK_QUERY = `{
  pages {
    edges { node { id handle title body isPublished publishedAt templateSuffix } }
  }
}`;

const SHOP = `{ shop { name } }`;

/** A page of a store's, as Shopify has it. */
export interface StorePage {
  handle: string;
  title: string;
  /** HTML. */
  body: string;
  isPublished: boolean;
  /** When it was or is to be shown; null for one never published. */
  publishedAt: string | null;
  templateSuffix: string | null;
}

/** A store's pages, read through its Admin API. */
export interface StorePages {
  /** The store's name, as Shopify has it. */
  storeName: string;
  pages: StorePage[];
}

/**
 * A store's own pages through its Admin API (ONB-05, ADR-752), such as About us and its policies
 * of delivery: the store asked first, which proves the credentials, then every page in one bulk
 * query. The app needs the read_online_store_pages scope.
 */
export async function readStorePages(
  admin: ShopifyAdmin,
  options: BulkQueryOptions = {},
): Promise<ShopifyResult<StorePages>> {
  const shop = await admin.graphql<{ shop: { name: string } }>(SHOP);
  if (!shop.ok) return shop;
  const file = await runBulkQuery(admin, PAGES_BULK_QUERY, options);
  if (!file.ok) {
    return file.kind === 'scope'
      ? {
          ...file,
          message:
            "The store's app may not read its pages: give it the read_online_store_pages access " +
            'scope',
        }
      : file;
  }
  let pages: StorePage[];
  try {
    pages = jsonLines(file.value)
      .filter((line) => typeof line.handle === 'string' && typeof line.title === 'string')
      .map((line) => ({
        handle: line.handle as string,
        title: line.title as string,
        body: typeof line.body === 'string' ? line.body : '',
        isPublished: line.isPublished === true,
        publishedAt: typeof line.publishedAt === 'string' ? line.publishedAt : null,
        templateSuffix:
          typeof line.templateSuffix === 'string' && line.templateSuffix !== ''
            ? line.templateSuffix
            : null,
      }));
  } catch {
    return { ok: false, kind: 'other', message: "Shopify's export of the store could not be read" };
  }
  return { ok: true, value: { storeName: shop.value.shop.name, pages } };
}
