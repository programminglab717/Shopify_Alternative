import { InputChecker, fail, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  NO_COD_RULES,
  checkCodRules,
  type CodRulesInput,
  type CodRulesRecord,
} from './cod-rules.js';
import { CheckoutEvents, type CodSettingsUpdatedPayload } from './events.js';
import { codSettings } from './schema.js';

/**
 * The shop's rules for cash on delivery, in the caller's transaction `tx`: for checkout's page and
 * its orders.
 */
export async function codRulesIn(
  tx: Tx,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<CodRulesRecord> {
  const query = tx.select().from(codSettings).where(eq(codSettings.shopId, shopId));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) return NO_COD_RULES;
  return {
    maxOrderTotal: row.maxTotal,
    unavailableCities: row.unavailableCities,
    refusedDeliveriesLimit: row.refusalsLimit,
    fee: row.fee,
    updatedAt: row.updatedAt,
  };
}

/**
 * What a shop keeps cash on delivery to at checkout (CHK-07, ADR-075): orders up to a total of its
 * own, outside cities it names, from customers who refused fewer parcels than it allows; and what
 * it charges for it (CHK-08, ADR-076). A shop that set nothing takes cash on delivery for every
 * order the law allows, and charges nothing for it.
 */
@Injectable()
export class CodRulesService {
  constructor(private readonly db: Database) {}

  get(tenant: TenantContext): Promise<CodRulesRecord> {
    return this.db.tenant(tenant.shopId, (tx) => codRulesIn(tx, tenant.shopId));
  }

  /**
   * Changes those given, `unavailableCities` replacing them all, for checkouts from now on;
   * records `cod_settings.updated` if anything changed.
   */
  async update(
    tenant: TenantContext,
    input: CodRulesInput,
  ): Promise<MutationResult<CodRulesRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const before = await codRulesIn(tx, tenant.shopId, { lock: true });
      const check = new InputChecker();
      const next = checkCodRules(check, before, input, tenant.currency);
      if (!next) return fail(check.errors);
      const changed = [
        ...(next.maxOrderTotal !== before.maxOrderTotal ? ['maxOrderTotal'] : []),
        ...(next.unavailableCities.join('\n') !== before.unavailableCities.join('\n')
          ? ['unavailableCities']
          : []),
        ...(next.refusedDeliveriesLimit !== before.refusedDeliveriesLimit
          ? ['refusedDeliveriesLimit']
          : []),
        ...(next.fee !== before.fee ? ['fee'] : []),
      ];
      if (changed.length === 0) return { ok: true, value: before };
      const values = {
        maxTotal: next.maxOrderTotal,
        unavailableCities: next.unavailableCities,
        refusalsLimit: next.refusedDeliveriesLimit,
        fee: next.fee,
      };
      await tx
        .insert(codSettings)
        .values({ shopId: tenant.shopId, ...values })
        .onConflictDoUpdate({
          target: codSettings.shopId,
          set: { ...values, updatedAt: sql`now()` },
        });
      await appendEvent<CodSettingsUpdatedPayload>(tx, tenant.shopId, {
        type: CheckoutEvents.CodSettingsUpdated,
        aggregateType: 'cod_settings',
        aggregateId: tenant.shopId,
        payload: { changed },
      });
      return { ok: true, value: await codRulesIn(tx, tenant.shopId) };
    });
  }
}
