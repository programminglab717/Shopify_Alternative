import { shopProfile } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { LOGO_URL_SECONDS, shopLogoOf } from '@hatti/files/public';
import { shopAccentOf } from '@hatti/online-store/public';
import type { ObjectStorage } from '@hatti/storage';
import type { LinkShop } from './links.js';

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
