import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { bankTransferSettingsIn } from '@hatti/orders/public';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  NO_COD_RULES,
  advanceKeyOf,
  checkCodRules,
  type CodAdvanceValue,
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
    unavailableProductTags: row.unavailableProductTags,
    refusedDeliveriesLimit: row.refusalsLimit,
    fee: row.fee,
    advance: advanceOfRow(row),
    updatedAt: row.updatedAt,
  };
}

function advanceOfRow(row: typeof codSettings.$inferSelect): CodAdvanceValue | null {
  const conditions = {
    above: row.advanceAbove,
    cities: row.advanceCities,
    refusedDeliveries: row.advanceRefused,
    newCustomers: row.advanceNewCustomers,
    riskScore: row.advanceRisk,
  };
  switch (row.advanceKind) {
    case 'fixed_amount':
      return { kind: 'fixed_amount', amount: row.advanceAmount!, ...conditions };
    case 'percentage':
      return { kind: 'percentage', percentageBps: row.advanceBps!, ...conditions };
    case 'delivery':
      return { kind: 'delivery', ...conditions };
    case null:
      return null;
  }
}

/**
 * What a shop keeps cash on delivery to at checkout (CHK-07, ADR-075): orders up to a total of its
 * own, of none of the products it tags (ADR-078), outside cities it names, from customers who
 * refused fewer parcels than it allows; what it charges for it (CHK-08, ADR-076); and what it asks
 * for in advance, paid into its bank account (CHK-10, ADR-084), where and of whom it asks it
 * (ADR-089, ADR-094). A shop that set nothing takes cash on delivery for every order the law allows,
 * charging and asking nothing ahead for it.
 */
@Injectable()
export class CodRulesService {
  constructor(private readonly db: Database) {}

  get(tenant: TenantContext): Promise<CodRulesRecord> {
    return this.db.tenant(tenant.shopId, (tx) => codRulesIn(tx, tenant.shopId));
  }

  /**
   * Changes those given, `unavailableCities` and `unavailableProductTags` replacing them all, for
   * checkouts from now on; records `cod_settings.updated` if anything changed.
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
        ...(next.unavailableProductTags.join('\n') !== before.unavailableProductTags.join('\n')
          ? ['unavailableProductTags']
          : []),
        ...(next.refusedDeliveriesLimit !== before.refusedDeliveriesLimit
          ? ['refusedDeliveriesLimit']
          : []),
        ...(next.fee !== before.fee ? ['fee'] : []),
        ...(advanceKeyOf(next.advance) !== advanceKeyOf(before.advance) ? ['advance'] : []),
      ];
      if (changed.length === 0) return { ok: true, value: before };
      // The customer pays it into the shop's account, which the order keeps (ADR-083).
      if (
        changed.includes('advance') &&
        next.advance &&
        !(await bankTransferSettingsIn(tx, tenant.shopId)).account
      ) {
        return failOne(
          ['input', 'advance'],
          'INVALID',
          "An advance is paid into the shop's bank account: give its account first",
        );
      }
      const advance = next.advance;
      const values = {
        maxTotal: next.maxOrderTotal,
        unavailableCities: next.unavailableCities,
        unavailableProductTags: next.unavailableProductTags,
        refusalsLimit: next.refusedDeliveriesLimit,
        fee: next.fee,
        advanceKind: advance?.kind ?? null,
        advanceAmount: advance?.kind === 'fixed_amount' ? advance.amount : null,
        advanceBps: advance?.kind === 'percentage' ? advance.percentageBps : null,
        advanceAbove: advance?.above ?? null,
        advanceCities: advance?.cities ?? [],
        advanceRefused: advance?.refusedDeliveries ?? null,
        advanceNewCustomers: advance?.newCustomers ?? false,
        advanceRisk: advance?.riskScore ?? null,
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
