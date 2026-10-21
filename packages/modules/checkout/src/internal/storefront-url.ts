import type { StorefrontSite } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { primaryHostIn } from '@hatti/online-store/public';

/**
 * The address of the shop's storefront, for links from checkout's pages and messages back to it,
 * in the caller's transaction `tx` (ADR-714): at its primary domain, while DNS points that at the
 * platform; else at its platform subdomain, by its `handle`.
 */
export async function storefrontUrlIn(
  tx: Tx,
  site: StorefrontSite,
  shopId: string,
  handle: string,
): Promise<string> {
  const host = await primaryHostIn(tx, shopId);
  return host ? site.urlAt(host) : site.url(handle);
}
