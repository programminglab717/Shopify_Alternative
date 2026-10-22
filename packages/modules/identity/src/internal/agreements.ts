import type { Db } from '@hatti/db';
import { SHOP_AGREEMENT, legalVersions, type LegalHandle } from '@hatti/legal';
import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { AuthError } from './errors.js';
import type { ClientInfo } from './identity.service.js';

// A shop's owner agrees to Hatti's terms, acceptable use policy and data processing agreement to
// open it (ADR-737): the versions they were shown, checked against the current ones, and recorded
// with who agreed and from where.

/** What the client says its user agreed to: each document's handle and the version shown. */
export type AgreedVersions = Readonly<Record<string, string>>;

/**
 * The versions agreed to, of the documents a shop's owner must agree to. Refuses an agreement
 * missing one, and one to a version no longer current, so that the page shows the new text.
 */
export function shopAgreement(
  agreed: AgreedVersions | null | undefined,
): Record<LegalHandle, string> {
  const current = legalVersions();
  const missing = SHOP_AGREEMENT.filter((handle) => !agreed?.[handle]);
  if (missing.length > 0) {
    throw new AuthError('INVALID_INPUT', 422, 'Some details need fixing', {
      fields: {
        agreed:
          "Agree to Hatti's terms of service, acceptable use policy and data processing agreement",
      },
    });
  }
  if (SHOP_AGREEMENT.some((handle) => agreed![handle] !== current[handle])) {
    throw new AuthError(
      'TERMS_CHANGED',
      409,
      "Hatti's terms have changed since they were shown: read them again to agree",
    );
  }
  return Object.fromEntries(SHOP_AGREEMENT.map((handle) => [handle, current[handle]])) as Record<
    LegalHandle,
    string
  >;
}

/** Records what the owner agreed to, in the transaction that opens the shop. */
export async function recordShopAgreement(
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  shopId: string,
  userId: string,
  documents: Record<LegalHandle, string>,
  client: ClientInfo,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO identity.shop_agreements (id, shop_id, user_id, documents, ip, user_agent)
         VALUES (${newId()}, ${shopId}, ${userId}, ${JSON.stringify(documents)}::jsonb,
                 ${client.ip ?? null}, ${client.userAgent?.slice(0, 512) ?? null})`);
}

/** What a shop's owner is asked to agree to: each document's handle, titles and version. */
export function shopAgreementDocuments(): { handle: LegalHandle; version: string }[] {
  const current = legalVersions();
  return SHOP_AGREEMENT.map((handle) => ({ handle, version: current[handle] }));
}

/**
 * Of `shopIds`, those `userId` has not agreed to Hatti's terms for as they are now (ADR-739): a
 * shop opened before agreements were kept, one handed to them, or one whose terms have changed
 * since they last agreed.
 */
export async function agreementsDue(
  executor: Pick<Db, 'execute'>,
  userId: string,
  shopIds: readonly string[],
): Promise<Set<string>> {
  if (shopIds.length === 0) return new Set();
  const current = Object.fromEntries(
    shopAgreementDocuments().map((each) => [each.handle, each.version]),
  );
  const { rows } = await executor.execute<{ id: string }>(sql`
    SELECT s.id FROM unnest(${sql.param([...shopIds])}::uuid[]) AS s(id)
     WHERE NOT EXISTS (SELECT 1 FROM identity.shop_agreements a
                        WHERE a.shop_id = s.id AND a.user_id = ${userId}
                          AND a.documents @> ${JSON.stringify(current)}::jsonb)`);
  return new Set(rows.map((row) => row.id));
}
