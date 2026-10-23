import type { ShopifyAdmin, ShopifyResult } from './admin.js';
import { jsonLines, runBulkQuery, type BulkQueryOptions } from './bulk.js';

const METAFIELDS = `metafields { edges { node { id namespace key type value } } }`;

/**
 * A store's metafields, as Shopify's bulk queries take them (ADR-789): one query for each kind
 * of owner, as a bulk query reads one connection at its top; each owner by what names it in the
 * shop, its metafields on lines of their own.
 */
export const METAFIELDS_BULK_QUERIES = {
  product: `{ products { edges { node { id handle ${METAFIELDS} } } } }`,
  variant: `{ productVariants { edges { node { id title product { handle } ${METAFIELDS} } } } }`,
  collection: `{ collections { edges { node { id handle ${METAFIELDS} } } } }`,
} as const;

const SHOP = `{ shop { name } }`;

/** A metafield of a store's, as Shopify has it: its type as Shopify names it. */
export interface StoreMetafield {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

/**
 * What a store's metafields are on: a product or collection by its handle, a variant by its
 * product's handle and its title, "M / Maroon", or "Default Title" for a product's only one.
 */
export type StoreMetafieldOwner =
  | { type: 'product' | 'collection'; handle: string }
  | { type: 'variant'; handle: string; title: string };

/** An owner's metafields at the store. */
export interface StoreOwnerMetafields {
  owner: StoreMetafieldOwner;
  metafields: StoreMetafield[];
}

/** A store's metafields, read through its Admin API, owners without any left out. */
export interface StoreMetafields {
  storeName: string;
  owners: StoreOwnerMetafields[];
}

/**
 * A store's products', variants' and collections' metafields through its Admin API (ONB-05,
 * ADR-789): the store asked first, which proves the credentials, then a bulk query for each kind
 * of owner, one after another, as Shopify runs one at a time. The app needs the read_products
 * scope.
 */
export async function readStoreMetafields(
  admin: ShopifyAdmin,
  options: BulkQueryOptions = {},
): Promise<ShopifyResult<StoreMetafields>> {
  const shop = await admin.graphql<{ shop: { name: string } }>(SHOP);
  if (!shop.ok) return shop;
  const owners: StoreOwnerMetafields[] = [];
  for (const kind of ['product', 'variant', 'collection'] as const) {
    const file = await runBulkQuery(admin, METAFIELDS_BULK_QUERIES[kind], options);
    if (!file.ok) return file;
    const byId = new Map<string, StoreOwnerMetafields>();
    try {
      for (const line of jsonLines(file.value)) {
        const id = String(line.id ?? '');
        if (id.startsWith('gid://shopify/Metafield/')) {
          const owner = typeof line.__parentId === 'string' ? byId.get(line.__parentId) : undefined;
          if (!owner) continue;
          owner.metafields.push({
            namespace: String(line.namespace ?? ''),
            key: String(line.key ?? ''),
            type: String(line.type ?? ''),
            value: typeof line.value === 'string' ? line.value : '',
          });
          continue;
        }
        if (kind === 'variant') {
          const product = line.product as { handle?: unknown } | null | undefined;
          if (typeof product?.handle !== 'string') continue;
          byId.set(id, {
            owner: { type: 'variant', handle: product.handle, title: String(line.title ?? '') },
            metafields: [],
          });
        } else if (typeof line.handle === 'string') {
          byId.set(id, { owner: { type: kind, handle: line.handle }, metafields: [] });
        }
      }
    } catch {
      return {
        ok: false,
        kind: 'other',
        message: "Shopify's export of the store could not be read",
      };
    }
    owners.push(...[...byId.values()].filter((owner) => owner.metafields.length > 0));
  }
  return { ok: true, value: { storeName: shop.value.shop.name, owners } };
}
