import type { Database } from '@hatti/db';
import type {
  MessagesService,
  SmsSenderDecisionProblem,
  SmsSenderReview,
  SmsSendersService,
} from '@hatti/messaging/public';
import { verifiedLevelIn } from '@hatti/trust/public';
import { tellShop } from './worker/shop-notices.js';

// Hatti's people's decisions on shops' own SMS sender names (MKT-02, ADR-469), each told to the
// shop at its alerts number, at Hatti's cost: approved, refused with why, or taken back. A name
// is approved only for a shop Hatti has verified (ADR-465), as operators register it for a known
// business.

/**
 * Approves a request waiting, once its operators registered the name, and tells the shop. Not for
 * a shop Hatti has not verified.
 */
export async function approveSmsSender(
  database: Database,
  senders: SmsSendersService,
  messages: MessagesService,
  id: string,
  input: { by: string; note?: string },
  now: Date = new Date(),
): Promise<SmsSenderReview | SmsSenderDecisionProblem | 'not_verified'> {
  const shopId = await senders.shopOf(id);
  if (!shopId) return 'not_found';
  if ((await database.tenant(shopId, (tx) => verifiedLevelIn(tx, shopId))) === null) {
    return 'not_verified';
  }
  const approved = await senders.approve(id, input, now);
  if (typeof approved === 'string') return approved;
  await database.tenant(approved.shopId, (tx) =>
    tellShop(tx, messages, approved.shopId, {
      kind: 'sms_sender_approved',
      dedupeKey: `sms_sender_approved:${approved.id}`,
      variables: { shop: approved.shopName, sender: approved.name },
    }),
  );
  return approved;
}

/** Refuses a request waiting, with why, and tells the shop. */
export async function refuseSmsSender(
  database: Database,
  senders: SmsSendersService,
  messages: MessagesService,
  id: string,
  input: { by: string; answer: string },
  now: Date = new Date(),
): Promise<SmsSenderReview | SmsSenderDecisionProblem> {
  const refused = await senders.refuse(id, input, now);
  if (typeof refused === 'string') return refused;
  await database.tenant(refused.shopId, (tx) =>
    tellShop(tx, messages, refused.shopId, {
      kind: 'sms_sender_refused',
      dedupeKey: `sms_sender_refused:${refused.id}`,
      variables: { shop: refused.shopName, sender: refused.name, note: refused.answer ?? '' },
    }),
  );
  return refused;
}

/** Takes back the name the shop `named` sends from, with why, and tells the shop. */
export async function revokeSmsSender(
  database: Database,
  senders: SmsSendersService,
  messages: MessagesService,
  named: string,
  input: { by: string; answer: string },
  now: Date = new Date(),
): Promise<SmsSenderReview | 'not_found' | 'not_approved'> {
  const revoked = await senders.revoke(named, input, now);
  if (typeof revoked === 'string') return revoked;
  await database.tenant(revoked.shopId, (tx) =>
    tellShop(tx, messages, revoked.shopId, {
      kind: 'sms_sender_revoked',
      dedupeKey: `sms_sender_revoked:${revoked.id}`,
      variables: { shop: revoked.shopName, sender: revoked.name, note: revoked.answer ?? '' },
    }),
  );
  return revoked;
}
