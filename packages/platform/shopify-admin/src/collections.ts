import type { ShopifyAdmin, ShopifyResult } from './admin.js';
import { jsonLines, runBulkQuery, type BulkQueryOptions } from './bulk.js';

/**
 * A store's collections, their rules and, for each, its products' handles in the collection's own
 * order, as Shopify's bulk queries take them.
 */
export const COLLECTIONS_BULK_QUERY = `{
  collections {
    edges {
      node {
        id handle title descriptionHtml sortOrder templateSuffix
        seo { title description }
        image { url altText }
        ruleSet { appliedDisjunctively rules { column relation condition } }
        products { edges { node { id handle } } }
      }
    }
  }
}`;

const SHOP = `{ shop { name currencyCode weightUnit } }`;

/** A rule of a store's smart collection, as Shopify has it: its column and relation upper case. */
export interface StoreCollectionRule {
  column: string;
  relation: string;
  condition: string;
}

/** A store's collection, as Shopify has it. */
export interface StoreCollection {
  handle: string;
  title: string;
  /** HTML. */
  descriptionHtml: string;
  /** Shopify's, as MANUAL or BEST_SELLING. */
  sortOrder: string;
  templateSuffix: string | null;
  seo: { title: string | null; description: string | null };
  /** Its image at Shopify's CDN (ADR-785); null for none. */
  image: { url: string; altText: string | null } | null;
  /** Null for a collection whose products were chosen by hand. */
  ruleSet: { appliedDisjunctively: boolean; rules: StoreCollectionRule[] } | null;
  /** Its products' handles, in its order. */
  products: string[];
}

/** A store's collections, read through its Admin API. */
export interface StoreCollections {
  /** The store's name, as Shopify has it. */
  storeName: string;
  /** The currency its rules' prices are in, ISO 4217. */
  currency: string;
  /** The unit its rules' weights are in: GRAMS, KILOGRAMS, OUNCES or POUNDS. */
  weightUnit: string;
  collections: StoreCollection[];
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * A store's collections through its Admin API (ONB-05, ADR-754): the store asked first, which
 * proves the credentials and says the currency and unit of weight its rules are in, then every
 * collection with its rules and products in one bulk query. The app needs the read_products
 * scope, which reading its products needs anyway.
 */
export async function readStoreCollections(
  admin: ShopifyAdmin,
  options: BulkQueryOptions = {},
): Promise<ShopifyResult<StoreCollections>> {
  const shop = await admin.graphql<{
    shop: { name: string; currencyCode: string; weightUnit: string };
  }>(SHOP);
  if (!shop.ok) return shop;
  const file = await runBulkQuery(admin, COLLECTIONS_BULK_QUERY, options);
  if (!file.ok) return file;
  const collections = new Map<string, StoreCollection>();
  try {
    for (const line of jsonLines(file.value)) {
      const id = String(line.id ?? '');
      if (id.startsWith('gid://shopify/Collection/')) {
        const seo = line.seo as { title?: unknown; description?: unknown } | null | undefined;
        const image = line.image as { url?: unknown; altText?: unknown } | null | undefined;
        const imageUrl = text(image?.url);
        const ruleSet = line.ruleSet as
          { appliedDisjunctively?: unknown; rules?: StoreCollectionRule[] } | null | undefined;
        collections.set(id, {
          handle: String(line.handle),
          title: String(line.title),
          descriptionHtml: typeof line.descriptionHtml === 'string' ? line.descriptionHtml : '',
          sortOrder: text(line.sortOrder) ?? 'MANUAL',
          templateSuffix: text(line.templateSuffix),
          seo: { title: text(seo?.title), description: text(seo?.description) },
          image: imageUrl === null ? null : { url: imageUrl, altText: text(image?.altText) },
          ruleSet: ruleSet
            ? {
                appliedDisjunctively: ruleSet.appliedDisjunctively === true,
                rules: (ruleSet.rules ?? []).map((rule) => ({
                  column: String(rule.column),
                  relation: String(rule.relation),
                  condition: typeof rule.condition === 'string' ? rule.condition : '',
                })),
              }
            : null,
          products: [],
        });
        continue;
      }
      const collection =
        typeof line.__parentId === 'string' ? collections.get(line.__parentId) : undefined;
      if (collection && id.startsWith('gid://shopify/Product/')) {
        collection.products.push(String(line.handle));
      }
    }
  } catch {
    return { ok: false, kind: 'other', message: "Shopify's export of the store could not be read" };
  }
  return {
    ok: true,
    value: {
      storeName: shop.value.shop.name,
      currency: shop.value.shop.currencyCode,
      weightUnit: shop.value.shop.weightUnit,
      collections: [...collections.values()],
    },
  };
}
