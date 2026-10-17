import type { PublicSite } from '@hatti/api';
import type { ProductService } from '@hatti/catalog/public';
import type { Database } from '@hatti/db';
import { toPublicId } from '@hatti/ids';
import type { MessagesService } from '@hatti/messaging/public';
import {
  RIGHTS_LINK_PATH,
  rightsLinkToken,
  type RightsAnswered,
  type RightsComplaintRecord,
  type RightsComplaintsService,
} from '@hatti/trust/public';
import { tellShop } from './worker/shop-notices.js';

// A rights complaint Hatti's people uphold (TNS-04, ADR-475): the listings it names taken off sale
// and held there, its decision kept, and the store's owner told what was taken down, who
// complained and how to reach them, at Hatti's cost, with the link they answer it by (ADR-476).
// Hatti's people refuse their answer with why, or let the listings go, the owner told either way.

/** The longest list of listings' titles a notice carries. */
const TITLES_MAX = 300;

/** What became of a complaint upheld: the listings held, or why none were. */
export type RightsUpheld =
  | { complaint: RightsComplaintRecord; held: { id: string; title: string }[] }
  | 'not_found'
  | 'decided';

/**
 * Upholds the open rights complaint `id`: its listings, those still the shop's, made drafts and
 * held off sale with the complaint's number; then the decision, with what was done and the
 * secret of the owner's link; then the store's owner told, with the link.
 */
export async function upholdRights(
  database: Database,
  rights: RightsComplaintsService,
  products: ProductService,
  messages: MessagesService,
  site: PublicSite,
  id: string,
  input: { by: string; note: string },
  now: Date = new Date(),
): Promise<RightsUpheld> {
  const complaint = await rights.get(id);
  if (!complaint) return 'not_found';
  if (complaint.status !== 'open') return 'decided';
  const reference = toPublicId('rightsComplaint', complaint.id);
  const held = await products.holdOffSale(
    complaint.shopId,
    complaint.listings.map((listing) => listing.id),
    reference,
  );
  const token = rightsLinkToken();
  const decided = await rights.decide(
    complaint.id,
    { status: 'upheld', ...input, linkToken: token },
    now,
  );
  if (typeof decided === 'string') return decided;
  if (held.length > 0) {
    const titles = held.map((listing) => `"${listing.title}"`).join(', ');
    await database.tenant(complaint.shopId, (tx) =>
      tellShop(tx, messages, complaint.shopId, {
        kind: 'listings_taken_down',
        dedupeKey: `listings_taken_down:${complaint.id}`,
        variables: {
          shop: complaint.shopName,
          product: titles.length > TITLES_MAX ? `${titles.slice(0, TITLES_MAX - 1)}…` : titles,
          name:
            complaint.actingAs === 'agent'
              ? `${complaint.complainant} for ${complaint.rightsOwner}`
              : complaint.rightsOwner,
          reference,
          note: input.note.trim(),
          email: complaint.email,
          url: site.url(`/${RIGHTS_LINK_PATH}/${token}`),
        },
      }),
    );
  }
  return { complaint: decided, held };
}

/**
 * Lets go the listings held for the upheld complaint `id`, with why, which upholds the owner's
 * answer waiting: the catalog's hold lifted from them and their copies, and the owner told to put
 * them on sale again.
 */
export async function releaseRights(
  database: Database,
  rights: RightsComplaintsService,
  products: ProductService,
  messages: MessagesService,
  id: string,
  input: { by: string; note: string },
  now: Date = new Date(),
): Promise<
  | { complaint: RightsComplaintRecord; released: number }
  | Exclude<RightsAnswered, RightsComplaintRecord>
> {
  const complaint = await rights.release(id, input, now);
  if (typeof complaint === 'string') return complaint;
  const reference = toPublicId('rightsComplaint', complaint.id);
  const released = await products.releaseHold(complaint.shopId, reference);
  await database.tenant(complaint.shopId, (tx) =>
    tellShop(tx, messages, complaint.shopId, {
      kind: 'listings_released',
      dedupeKey: `listings_released:${complaint.id}`,
      variables: { shop: complaint.shopName, reference, note: complaint.releaseNote ?? '' },
    }),
  );
  return { complaint, released };
}

/**
 * Refuses the owner's answer to the upheld complaint `id`, with why, which its link's page shows;
 * the listings stay held. The owner is told on WhatsApp.
 */
export async function refuseRightsCounter(
  database: Database,
  rights: RightsComplaintsService,
  messages: MessagesService,
  id: string,
  input: { by: string; answer: string },
  now: Date = new Date(),
): Promise<RightsAnswered> {
  const complaint = await rights.refuseCounter(id, input, now);
  if (typeof complaint === 'string') return complaint;
  await database.tenant(complaint.shopId, (tx) =>
    tellShop(tx, messages, complaint.shopId, {
      kind: 'rights_counter_refused',
      dedupeKey: `rights_counter_refused:${complaint.id}`,
      variables: {
        shop: complaint.shopName,
        reference: toPublicId('rightsComplaint', complaint.id),
        note: complaint.counterAnswer ?? '',
      },
    }),
  );
  return complaint;
}
