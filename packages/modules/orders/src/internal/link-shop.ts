import { shopProfile, type StorefrontSite } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { LOGO_URL_SECONDS, shopLogoOf } from '@hatti/files/public';
import { policyHandle, shopAccentOf, shopPolicyVersionsOf } from '@hatti/online-store/public';
import type { ObjectStorage } from '@hatti/storage';
import type { LinkShop } from './links.js';
import type { ShownTerm } from './shown-order.js';

/**
 * What a link's page shows of its shop, in the caller's transaction `tx`: its name, its theme's
 * colour (ADR-069) and its logo (ADR-081), as its checkout's page does. Without `storage`, no
 * logo: its URL is signed as the page is made.
 */
export async function linkShopIn(
  tx: Tx,
  shopId: string,
  storage: ObjectStorage | undefined,
): Promise<LinkShop> {
  const profile = await shopProfile(tx, shopId);
  const logo = storage ? await shopLogoOf(tx, shopId) : null;
  return {
    name: profile.name,
    timezone: profile.timezone,
    accent: await shopAccentOf(tx, shopId),
    logo: logo && storage ? storage.signDownload(logo.key, LOGO_URL_SECONDS) : null,
  };
}

/**
 * What confirming an order through a link agrees to (ADR-114, ADR-115), as checkout names it
 * (ADR-057): the shop's policies, by their versions now, but its contact information, which
 * promises nothing; each at its storefront, which sends the customer on to the shop's primary
 * domain if it has one. In the caller's transaction `tx`.
 */
export async function linkTermsIn(
  tx: Tx,
  shopId: string,
  storefronts: StorefrontSite,
): Promise<ShownTerm[]> {
  const policies = (await shopPolicyVersionsOf(tx, shopId)).filter(
    (policy) => policy.type !== 'contact_information',
  );
  if (policies.length === 0) return [];
  const storefront = storefronts.url((await shopProfile(tx, shopId)).handle);
  return policies.map(({ type, versionId }) => ({
    type,
    versionId,
    url: `${storefront}/policies/${policyHandle(type)}`,
  }));
}
