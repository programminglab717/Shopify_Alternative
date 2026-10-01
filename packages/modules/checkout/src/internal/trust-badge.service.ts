import { InputChecker, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { shopPreferencesOf } from '@hatti/online-store/public';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { CheckoutEvents, type TrustBadgesUpdatedPayload } from './events.js';
import { trustBadges } from './schema.js';
import { checkTrustBadges, type TrustBadgeInput, type TrustBadgeValue } from './trust-badges.js';

/** The badges the shop chose for its checkout's page, in the caller's transaction `tx`. */
export async function trustBadgesIn(tx: Tx, shopId: string): Promise<TrustBadgeValue[]> {
  const [row] = await tx
    .select({ badges: trustBadges.badges })
    .from(trustBadges)
    .where(eq(trustBadges.shopId, shopId));
  return row?.badges ?? [];
}

/**
 * The badges a shop chooses for its checkout's page (CHK-14, ADR-086), from the platform's set,
 * which the page words in English and Urdu.
 */
@Injectable()
export class TrustBadgeService {
  constructor(private readonly db: Database) {}

  get(tenant: TenantContext): Promise<TrustBadgeValue[]> {
    return this.db.tenant(tenant.shopId, (tx) => trustBadgesIn(tx, tenant.shopId));
  }

  /**
   * Replaces the badges with `inputs`, in their order, for checkouts' pages from now on; records
   * `trust_badges.updated` if they changed. Help on WhatsApp needs the shop's number.
   */
  async update(
    tenant: TenantContext,
    inputs: readonly TrustBadgeInput[],
  ): Promise<MutationResult<TrustBadgeValue[]>> {
    const check = new InputChecker();
    const badges = checkTrustBadges(check, ['badges'], inputs);
    if (!badges) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const whatsapp = badges.findIndex((badge) => badge.kind === 'whatsapp');
      if (whatsapp >= 0 && !(await shopPreferencesOf(tx, tenant.shopId)).whatsappNumber) {
        return failOne(
          ['badges', String(whatsapp), 'kind'],
          'INVALID',
          "Help on WhatsApp needs the shop's WhatsApp number: set it in the online store's " +
            'preferences first',
        );
      }
      const before = await trustBadgesIn(tx, tenant.shopId);
      if (keyOf(before) === keyOf(badges)) return { ok: true, value: before };
      await tx
        .insert(trustBadges)
        .values({ shopId: tenant.shopId, badges })
        .onConflictDoUpdate({
          target: trustBadges.shopId,
          set: { badges, updatedAt: sql`now()` },
        });
      await appendEvent<TrustBadgesUpdatedPayload>(tx, tenant.shopId, {
        type: CheckoutEvents.TrustBadgesUpdated,
        aggregateType: 'trust_badges',
        aggregateId: tenant.shopId,
        payload: { badges: badges.map((badge) => badge.kind) },
      });
      return { ok: true, value: badges };
    });
  }
}

/** The badges in order, the same for the same badges however their stored keys are ordered. */
function keyOf(badges: readonly TrustBadgeValue[]): string {
  return badges.map((badge) => `${badge.kind}:${badge.days ?? ''}`).join(',');
}
