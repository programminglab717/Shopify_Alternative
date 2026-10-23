import { ShopifyAdmin, type BulkQueryOptions, type ShopifyCredentials } from '@hatti/shopify-admin';

/**
 * Where the core reaches the Shopify stores owners move from (ADR-749): through the process's
 * fetch, or a test's own, waiting as long for Shopify's exports as it is told to.
 */
export class ShopifyStores {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    readonly bulk: BulkQueryOptions = {},
  ) {}

  /** A store's Admin API with what its owner gave, used for one import and then let go. */
  connect(shop: string, credentials: ShopifyCredentials): ShopifyAdmin {
    return new ShopifyAdmin({ shop, credentials, fetch: this.fetchFn });
  }
}
