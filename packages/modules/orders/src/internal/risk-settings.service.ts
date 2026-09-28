import { InputChecker, type Actor, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OrderEvents, type RiskSettingsUpdatedPayload } from './events.js';
import { loadRiskSettings, type RiskSettingsRecord } from './order-risk.js';

/** Fields left out stay as they are. */
export interface RiskSettingsInput {
  /**
   * Cash-on-delivery orders whose risk is this or more wait for review: 0.01 to 1, in hundredths.
   * null holds none.
   */
  holdAt?: number | null;
  /** Orders totalling this or more count as high value. Decimal, in major units. */
  highValue?: string | null;
}

/** When risky cash-on-delivery orders wait for review, per shop (COD-06). */
@Injectable()
export class RiskSettingsService {
  constructor(private readonly db: Database) {}

  /** The shop's policy, or the defaults. */
  get(tenant: TenantContext): Promise<RiskSettingsRecord> {
    return this.db.tenant(tenant.shopId, (tx) =>
      loadRiskSettings(tx, tenant.shopId, tenant.currency),
    );
  }

  /** Changes the policy for orders placed or re-addressed from now on. */
  async update(
    tenant: TenantContext,
    input: RiskSettingsInput,
  ): Promise<MutationResult<RiskSettingsRecord>> {
    const check = new InputChecker();
    let holdAt: number | null | undefined;
    if (input.holdAt === null || input.holdAt === undefined) {
      holdAt = input.holdAt;
    } else {
      const points = Math.round(input.holdAt * 100);
      const hundredths = Math.abs(input.holdAt * 100 - points) < 1e-9;
      if (!Number.isFinite(input.holdAt) || !hundredths || points < 1 || points > 100) {
        check.add(['input', 'holdAt'], 'INVALID', 'must be from 0.01 to 1, in hundredths');
      }
      holdAt = points;
    }
    let highValue: bigint | null | undefined;
    if (input.highValue !== undefined) {
      highValue = check.price(['input', 'highValue'], input.highValue, tenant.currency, {
        required: true,
      });
      if (highValue === 0n) check.add(['input', 'highValue'], 'INVALID', 'must be more than zero');
    }
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await loadRiskSettings(tx, tenant.shopId, tenant.currency);
      const next = {
        holdAt: holdAt === undefined ? current.holdAt : holdAt,
        highValue: highValue ?? current.highValue,
      };
      // Saving the defaults as they are makes them the shop's own.
      const given = holdAt !== undefined || highValue !== undefined;
      const unchanged = next.holdAt === current.holdAt && next.highValue === current.highValue;
      if (unchanged && (current.updatedAt !== null || !given)) return { ok: true, value: current };
      await tx.execute(sql`
        INSERT INTO orders.risk_settings (shop_id, hold_at, high_value)
        VALUES (${tenant.shopId}, ${next.holdAt}, ${next.highValue})
            ON CONFLICT (shop_id) DO UPDATE
                   SET hold_at = excluded.hold_at, high_value = excluded.high_value,
                       version = orders.risk_settings.version + 1, updated_at = now()`);
      await appendEvent<RiskSettingsUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.RiskSettingsUpdated,
        aggregateType: 'order_risk_settings',
        aggregateId: tenant.shopId,
        payload: {
          holdAt: next.holdAt,
          highValue: next.highValue.toString(),
          currency: tenant.currency,
          ...actorOf(tenant.actor),
        },
      });
      return { ok: true, value: await loadRiskSettings(tx, tenant.shopId, tenant.currency) };
    });
  }
}

function actorOf(actor: Actor): { actorKind: 'app' | 'staff'; actorId: string } {
  return actor.kind === 'app'
    ? { actorKind: 'app', actorId: actor.tokenId }
    : { actorKind: 'staff', actorId: actor.userId };
}
