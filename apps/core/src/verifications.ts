import type { Database } from '@hatti/db';
import type { MessagesService } from '@hatti/messaging/public';
import type {
  VerificationDecisionProblem,
  VerificationLevel,
  VerificationReview,
  VerificationsService,
} from '@hatti/trust/public';
import { tellShop } from './worker/shop-notices.js';

// Hatti's people's decisions on shops' verifications (ONB-11, ADR-465), each told to the shop at
// its alerts number on WhatsApp, at Hatti's cost: approved, refused with why, or taken back.

/** Approves a request waiting, and tells the shop. */
export async function approveVerification(
  database: Database,
  verifications: VerificationsService,
  messages: MessagesService,
  id: string,
  input: { by: string; note?: string },
  now: Date = new Date(),
): Promise<VerificationReview | VerificationDecisionProblem> {
  const approved = await verifications.approve(id, input, now);
  if (typeof approved === 'string') return approved;
  await database.tenant(approved.shopId, (tx) =>
    tellShop(tx, messages, approved.shopId, {
      kind: 'shop_verified',
      dedupeKey: `shop_verified:${approved.id}`,
      variables: { shop: approved.shopName },
    }),
  );
  return approved;
}

/** Refuses a request waiting, with why, and tells the shop. */
export async function refuseVerification(
  database: Database,
  verifications: VerificationsService,
  messages: MessagesService,
  id: string,
  input: { by: string; answer: string },
  now: Date = new Date(),
): Promise<VerificationReview | VerificationDecisionProblem> {
  const refused = await verifications.refuse(id, input, now);
  if (typeof refused === 'string') return refused;
  await database.tenant(refused.shopId, (tx) =>
    tellShop(tx, messages, refused.shopId, {
      kind: 'shop_verification_refused',
      dedupeKey: `shop_verification_refused:${refused.id}`,
      variables: { shop: refused.shopName, note: refused.answer ?? '' },
    }),
  );
  return refused;
}

/** Takes back the shop `named`'s verification at `level`, with why, and tells the shop. */
export async function revokeVerification(
  database: Database,
  verifications: VerificationsService,
  messages: MessagesService,
  named: string,
  level: VerificationLevel,
  input: { by: string; answer: string },
  now: Date = new Date(),
): Promise<VerificationReview[] | 'not_found' | 'not_verified'> {
  const revoked = await verifications.revoke(named, level, input, now);
  if (typeof revoked === 'string') return revoked;
  const [first] = revoked;
  await database.tenant(first!.shopId, (tx) =>
    tellShop(tx, messages, first!.shopId, {
      kind: 'shop_verification_revoked',
      dedupeKey: `shop_verification_revoked:${first!.id}`,
      variables: { shop: first!.shopName, note: first!.answer ?? '' },
    }),
  );
  return revoked;
}
