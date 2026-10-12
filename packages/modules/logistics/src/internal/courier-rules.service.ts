import { InputChecker, fail, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { findCity } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { LogisticsEvents, type CourierRulesUpdatedPayload } from './events.js';

/** Rules a shop keeps at most, and cities a rule names at most. */
export const COURIER_RULE_LIMITS = { rules: 50, cities: 100 } as const;

/**
 * Which courier account books an order when staff do not name one (SHP-06, ADR-382): the first
 * of the shop's rules that the order's city and its cash to collect match.
 */
export interface CourierRuleRecord {
  id: string;
  accountId: string;
  /** Cities as Pakistan's list names them; none for anywhere. */
  cities: string[];
  /** The cash to collect, in minor units: at least, and below; null for no bound. */
  codAtLeast: bigint | null;
  codBelow: bigint | null;
  /** Its account was archived since: the rule is passed over. */
  accountArchived: boolean;
}

export interface CourierRuleInput {
  accountId: string;
  /** Cities of Pakistan, as addresses name them; none or null for anywhere. */
  cities?: readonly string[] | null;
  /** Decimal, in major units; null or blank for no bound. */
  codAtLeast?: string | null;
  codBelow?: string | null;
}

type RuleRow = {
  id: string;
  account_id: string;
  cities: string[];
  cod_at_least: string | null;
  cod_below: string | null;
  archived: boolean;
};

/**
 * The first of `rules` an order to `city` with `codAmount` to collect matches, passing over those
 * whose account was archived; undefined when none does. A city is matched as Pakistan's list
 * names it, so "Pindi" is Rawalpindi.
 */
export function ruleFor(
  rules: readonly CourierRuleRecord[],
  city: string | null,
  codAmount: bigint,
): CourierRuleRecord | undefined {
  const name = city ? (findCity(city)?.name ?? null) : null;
  return rules.find(
    (rule) =>
      !rule.accountArchived &&
      (rule.cities.length === 0 || (name !== null && rule.cities.includes(name))) &&
      (rule.codAtLeast === null || codAmount >= rule.codAtLeast) &&
      (rule.codBelow === null || codAmount < rule.codBelow),
  );
}

/** The shop's rules in their order, in the caller's transaction. */
export async function courierRulesIn(tx: Tx, shopId: string): Promise<CourierRuleRecord[]> {
  const { rows } = await tx.execute<RuleRow>(sql`
    SELECT r.id, r.account_id, r.cities, r.cod_at_least::text AS cod_at_least,
           r.cod_below::text AS cod_below, a.archived_at IS NOT NULL AS archived
      FROM logistics.courier_rules r
      JOIN logistics.courier_accounts a ON a.shop_id = r.shop_id AND a.id = r.account_id
     WHERE r.shop_id = ${shopId}
     ORDER BY r.position`);
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    cities: row.cities,
    codAtLeast: row.cod_at_least === null ? null : BigInt(row.cod_at_least),
    codBelow: row.cod_below === null ? null : BigInt(row.cod_below),
    accountArchived: row.archived,
  }));
}

/**
 * The shop's courier rules (SHP-06, ADR-382): kept in their order, replaced all at once, each
 * naming cities, a range of cash to collect, or both, and the account that books what matches.
 */
@Injectable()
export class CourierRuleService {
  constructor(private readonly db: Database) {}

  list(tenant: TenantContext): Promise<CourierRuleRecord[]> {
    return this.db.tenant(tenant.shopId, (tx) => courierRulesIn(tx, tenant.shopId));
  }

  /**
   * Replaces the shop's rules with `inputs`, in their order; none for none. Each names a live
   * account of the shop's, and cities, a range of cash, or both. Records
   * `courier_rules.updated` if anything changed.
   */
  async replace(
    tenant: TenantContext,
    inputs: readonly CourierRuleInput[],
  ): Promise<MutationResult<CourierRuleRecord[]>> {
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx) => {
      const check = new InputChecker();
      if (inputs.length > COURIER_RULE_LIMITS.rules) {
        check.addMessage(
          ['rules'],
          'INVALID',
          `A shop has at most ${COURIER_RULE_LIMITS.rules} courier rules`,
        );
        return fail(check.errors);
      }
      const { rows: accounts } = await tx.execute<{ id: string; archived: boolean }>(sql`
        SELECT id, archived_at IS NOT NULL AS archived FROM logistics.courier_accounts
         WHERE shop_id = ${shopId}`);
      const archived = new Map(accounts.map((account) => [account.id, account.archived]));
      const rules = inputs.map((input, index) => {
        const at = ['rules', String(index)];
        if (!archived.has(input.accountId)) {
          check.addMessage([...at, 'accountId'], 'NOT_FOUND', 'Courier account not found');
        } else if (archived.get(input.accountId)) {
          check.addMessage([...at, 'accountId'], 'INVALID', 'The courier account is archived');
        }
        const named = input.cities ?? [];
        const cities: string[] = [];
        if (named.length > COURIER_RULE_LIMITS.cities) {
          check.addMessage(
            [...at, 'cities'],
            'INVALID',
            `A rule names at most ${COURIER_RULE_LIMITS.cities} cities`,
          );
        }
        named.forEach((text, place) => {
          const city = findCity(text);
          if (!city) {
            check.addMessage(
              [...at, 'cities', String(place)],
              'INVALID',
              `"${text.trim()}" is not a city of Pakistan we know`,
            );
          } else if (!cities.includes(city.name)) {
            cities.push(city.name);
          }
        });
        const codAtLeast = check.price([...at, 'codAtLeast'], input.codAtLeast, tenant.currency);
        const codBelow = check.price([...at, 'codBelow'], input.codBelow, tenant.currency);
        if (codBelow === 0n) {
          check.addMessage([...at, 'codBelow'], 'INVALID', 'The cash must be below more than Rs 0');
        }
        if (codAtLeast !== null && codBelow !== null && codAtLeast >= codBelow) {
          check.addMessage(
            [...at, 'codBelow'],
            'INVALID',
            'The cash it is below must be more than the cash it is at least',
          );
        }
        if (named.length === 0 && !input.codAtLeast?.trim() && !input.codBelow?.trim()) {
          check.addMessage(at, 'BLANK', 'Name the cities, or the cash to collect, the rule is for');
        }
        return { accountId: input.accountId, cities, codAtLeast, codBelow };
      });
      if (!check.ok) return fail(check.errors);

      const before = await courierRulesIn(tx, shopId);
      const same =
        before.length === rules.length &&
        before.every(
          (rule, index) =>
            rule.accountId === rules[index]!.accountId &&
            rule.cities.join('\n') === rules[index]!.cities.join('\n') &&
            rule.codAtLeast === rules[index]!.codAtLeast &&
            rule.codBelow === rules[index]!.codBelow,
        );
      if (same) return { ok: true, value: before };

      await tx.execute(sql`DELETE FROM logistics.courier_rules WHERE shop_id = ${shopId}`);
      for (const [position, rule] of rules.entries()) {
        await tx.execute(sql`
          INSERT INTO logistics.courier_rules
                 (shop_id, position, account_id, cities, cod_at_least, cod_below)
          VALUES (${shopId}, ${position}, ${rule.accountId},
                  ${sql.param(rule.cities)}::text[], ${rule.codAtLeast}, ${rule.codBelow})`);
      }
      await appendEvent<CourierRulesUpdatedPayload>(tx, shopId, {
        type: LogisticsEvents.CourierRulesUpdated,
        aggregateType: 'courier_rules',
        aggregateId: shopId,
        payload: { count: rules.length },
      });
      return { ok: true, value: await courierRulesIn(tx, shopId) };
    });
  }
}
