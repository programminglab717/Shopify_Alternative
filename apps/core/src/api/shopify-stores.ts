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

/** What the owner gave of their store's app: its token, or its client ID and secret. */
export function credentialsOf(
  accessToken?: string,
  clientId?: string,
  clientSecret?: string,
): ShopifyCredentials | null {
  const token = accessToken?.trim() ?? '';
  if (token !== '') return { accessToken: token };
  const id = clientId?.trim() ?? '';
  const secret = clientSecret?.trim() ?? '';
  return id !== '' && secret !== '' ? { clientId: id, clientSecret: secret } : null;
}
