import type { PublicSite } from '@hatti/api';
import type { Database } from '@hatti/db';
import type { MessagesService } from '@hatti/messaging/public';
import {
  APPEAL_LINK_PATH,
  appealToken,
  type AppealRecord,
  type AppealsService,
  type TakedownResult,
  type TakedownsService,
} from '@hatti/trust/public';
import { tellShop } from './worker/shop-notices.js';

// Taking a store down, and restoring it, with its owner told (TNS-01, ADR-461): at the shop's
// alerts number on WhatsApp and by email to its owner, at Hatti's cost. Told before it goes down,
// since identity gives an owner's address for active shops alone, and once it is open again. The
// notice carries the link its owner appeals by (ADR-462), on Hatti's own address.

/**
 * Takes the store `named` down, by its handle or ID, after telling its owner why, with the link
 * to appeal by.
 */
export async function takeDown(
  database: Database,
  takedowns: TakedownsService,
  messages: MessagesService,
  site: PublicSite,
  named: string,
  input: { reason: string; note: string; by: string },
  now: Date = new Date(),
): Promise<TakedownResult> {
  const shop = await takedowns.shop(named);
  if (!shop) return 'not_found';
  if (shop.status !== 'active') return 'not_active';
  const token = appealToken();
  await database.tenant(shop.id, (tx) =>
    tellShop(tx, messages, shop.id, {
      kind: 'store_suspended',
      dedupeKey: `store_suspended:${now.toISOString()}`,
      variables: {
        shop: shop.name,
        note: input.note.trim(),
        url: site.url(`/${APPEAL_LINK_PATH}/${token}`),
      },
    }),
  );
  return takedowns.suspend(shop.id, { ...input, appealToken: token }, now);
}

/** Restores the store `named`, taken down, and tells its owner why. */
export async function restoreStore(
  database: Database,
  takedowns: TakedownsService,
  messages: MessagesService,
  named: string,
  input: { note: string; by: string },
  now: Date = new Date(),
): Promise<TakedownResult> {
  const restored = await takedowns.restore(named, input, now);
  if (typeof restored === 'string') return restored;
  await database.tenant(restored.shopId, (tx) =>
    tellShop(tx, messages, restored.shopId, {
      kind: 'store_restored',
      dedupeKey: `store_restored:${restored.id}`,
      variables: { shop: restored.shopName, note: restored.restoreNote ?? '' },
    }),
  );
  return restored;
}

/**
 * Refuses an appeal waiting, with why, and tells the store's owner on WhatsApp: its link's page
 * shows the answer. Not by email, which identity gives for active shops alone.
 */
export async function refuseAppeal(
  database: Database,
  appeals: AppealsService,
  messages: MessagesService,
  id: string,
  input: { by: string; answer: string },
  now: Date = new Date(),
): Promise<AppealRecord | 'not_found' | 'answered'> {
  const refused = await appeals.refuse(id, input, now);
  if (typeof refused === 'string') return refused;
  await database.tenant(refused.shopId, (tx) =>
    tellShop(tx, messages, refused.shopId, {
      kind: 'store_appeal_refused',
      dedupeKey: `store_appeal_refused:${refused.id}`,
      variables: { shop: refused.shopName, note: refused.answer ?? '' },
    }),
  );
  return refused;
}
