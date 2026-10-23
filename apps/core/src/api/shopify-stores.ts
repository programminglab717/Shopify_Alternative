import type { TenantContext } from '@hatti/api';
import type { FileService } from '@hatti/files/public';
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

  /**
   * A store's image fetched from its CDN and kept as one of the shop's files (ADR-783), as an
   * article or a collection takes it: null for none; why not when it could not be fetched or
   * kept. Named as the CDN's path ends, else `name`.
   */
  async keepImage(
    files: FileService,
    tenant: TenantContext,
    image: { url: string; altText: string | null } | null,
    name: string,
  ): Promise<{ fileId: string; altText: string } | null | string> {
    if (!image) return null;
    const fetched = await this.images.fetch(image.url);
    if (!fetched.ok) return fetched.message;
    const altText = image.altText ?? '';
    const made = await files.createImage(tenant, {
      filename: filenameOf(image.url, name),
      body: fetched.body,
      alt: altText,
    });
    if (!made.ok) return made.errors.map((error) => error.message).join('; ');
    return { fileId: made.value.id, altText };
  }
}

/** The name of the file at `url`, as its path ends; `fallback` where it names none. */
export function filenameOf(url: string, fallback: string): string {
  let name = '';
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
  } catch {
    // Not a URL, or not one whose name reads: the fallback.
  }
  return (name.trim() || fallback).slice(0, 255);
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
