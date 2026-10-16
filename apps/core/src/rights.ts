import type { ProductService } from '@hatti/catalog/public';
import type { Database } from '@hatti/db';
import { toPublicId } from '@hatti/ids';
import type { MessagesService } from '@hatti/messaging/public';
import type { RightsComplaintRecord, RightsComplaintsService } from '@hatti/trust/public';
import { tellShop } from './worker/shop-notices.js';

// A rights complaint Hatti's people uphold (TNS-04, ADR-475): the listings it names taken off sale
// and held there, its decision kept, and the store's owner told what was taken down, who
// complained and how to reach them, at Hatti's cost.

/** The longest list of listings' titles a notice carries. */
const TITLES_MAX = 300;

/** What became of a complaint upheld: the listings held, or why none were. */
export type RightsUpheld =
  | { complaint: RightsComplaintRecord; held: { id: string; title: string }[] }
  | 'not_found'
  | 'decided';

/**
 * Upholds the open rights complaint `id`: its listings, those still the shop's, made drafts and
 * held off sale with the complaint's number; then the decision, with what was done; then the
 * store's owner told.
 */
export async function upholdRights(
  database: Database,
  rights: RightsComplaintsService,
  products: ProductService,
  messages: MessagesService,
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
  const decided = await rights.decide(complaint.id, { status: 'upheld', ...input }, now);
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
        },
      }),
    );
  }
  return { complaint: decided, held };
}
