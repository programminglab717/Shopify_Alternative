import type { ShopifyAdmin, ShopifyResult } from './admin.js';
import { jsonLines, runBulkQuery, type BulkQueryOptions } from './bulk.js';

/** A store's URL redirects, each a path and where it sends, as Shopify's bulk queries take them. */
export const REDIRECTS_BULK_QUERY = `{
  urlRedirects {
    edges { node { id path target } }
  }
}`;

const SHOP = `{ shop { name } }`;

/** A store's redirects as Shopify's redirects export, and the path each of its rows is of. */
export interface StoreRedirects {
  /** The store's name, as Shopify has it. */
  storeName: string;
  redirects: number;
  csv: string;
  /** The path of each row under the headings, the first being row 2, as imports count. */
  rowPaths: string[];
}

/** Redirects as Shopify's redirects export writes them: Redirect from, Redirect to. */
export function storeRedirectsCsv(redirects: readonly { path: string; target: string }[]): {
  csv: string;
  rowPaths: string[];
} {
  const quoted = (cell: string) => `"${cell.replace(/"/g, '""')}"`;
  const rows = [
    ['Redirect from', 'Redirect to'],
    ...redirects.map((each) => [each.path, each.target]),
  ];
  return {
    csv: rows.map((row) => row.map(quoted).join(',')).join('\r\n') + '\r\n',
    rowPaths: redirects.map((each) => each.path),
  };
}

/**
 * A store's URL redirects through its Admin API (ONB-05, ADR-751): the store asked first, which
 * proves the credentials, then its redirects in one bulk query, then Shopify's redirects export of
 * them. The app needs the read_online_store_navigation scope.
 */
export async function readStoreRedirects(
  admin: ShopifyAdmin,
  options: BulkQueryOptions = {},
): Promise<ShopifyResult<StoreRedirects>> {
  const shop = await admin.graphql<{ shop: { name: string } }>(SHOP);
  if (!shop.ok) return shop;
  const file = await runBulkQuery(admin, REDIRECTS_BULK_QUERY, options);
  if (!file.ok) {
    return file.kind === 'scope'
      ? {
          ...file,
          message:
            "The store's app may not read its redirects: give it the " +
            'read_online_store_navigation access scope',
        }
      : file;
  }
  let redirects: { path: string; target: string }[];
  try {
    redirects = jsonLines(file.value)
      .filter((line) => typeof line.path === 'string' && typeof line.target === 'string')
      .map((line) => ({ path: line.path as string, target: line.target as string }));
  } catch {
    return { ok: false, kind: 'other', message: "Shopify's export of the store could not be read" };
  }
  return {
    ok: true,
    value: {
      storeName: shop.value.shop.name,
      redirects: redirects.length,
      ...storeRedirectsCsv(redirects),
    },
  };
}
