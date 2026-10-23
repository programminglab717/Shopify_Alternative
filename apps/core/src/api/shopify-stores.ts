import { ImageFetcher } from '@hatti/images';
import {
  ShopifyAdmin,
  shopDomainOf,
  type BulkQueryOptions,
  type ShopifyCredentials,
  type ShopifyFailureKind,
} from '@hatti/shopify-admin';

/**
 * Where the core reaches the Shopify stores owners move from (ADR-749): through the process's
 * fetch, or a test's own, waiting as long for Shopify's exports as it is told to; and where it
 * fetches the stores' images from (ADR-783), never a private network.
 */
export class ShopifyStores {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    readonly bulk: BulkQueryOptions = {},
    readonly images: Pick<ImageFetcher, 'fetch'> = new ImageFetcher(),
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

/** What an import from a store refuses before reading it, in the API's terms. */
export interface StoreRefusal {
  field: string[] | null;
  code: string;
  message: string;
}

/** The store's address and the owner's app as given, or why they are refused. */
export function storeGiven(
  store: string,
  accessToken?: string,
  clientId?: string,
  clientSecret?: string,
): { ok: true; shop: string; credentials: ShopifyCredentials } | ({ ok: false } & StoreRefusal) {
  const shop = shopDomainOf(store);
  if (!shop) {
    return {
      ok: false,
      field: ['store'],
      code: 'INVALID',
      message: "Give the store's address at Shopify, as zari.myshopify.com, or its admin's link",
    };
  }
  const credentials = credentialsOf(accessToken, clientId, clientSecret);
  if (!credentials) {
    return {
      ok: false,
      field: ['accessToken'],
      code: 'BLANK',
      message: "Give the access token of the store's app, or the client ID and secret of its app",
    };
  }
  return { ok: true, shop, credentials };
}

/** Why Shopify did not answer, in the API's terms: on the app, the store, or neither. */
export function storeRefusalOf(failure: {
  kind: ShopifyFailureKind;
  message: string;
}): StoreRefusal {
  return {
    field:
      failure.kind === 'credentials' || failure.kind === 'scope'
        ? ['accessToken']
        : failure.kind === 'store'
          ? ['store']
          : null,
    code: failure.kind === 'busy' ? 'UNAVAILABLE' : 'INVALID',
    message: failure.message,
  };
}
