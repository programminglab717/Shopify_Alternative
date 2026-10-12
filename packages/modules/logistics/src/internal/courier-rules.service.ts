import { InputChecker, fail, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import type { DeliveryRateRow } from '@hatti/orders/public';
import { appendEvent } from '@hatti/events';
import { findCity } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { LogisticsEvents, type CourierRulesUpdatedPayload } from './events.js';
import { chargeEstimate, type RateCardRecord } from './rate-cards.service.js';

/**
 * How an account is picked for a rule naming none (ADR-385, ADR-387): the cheapest by the
 * accounts' rate cards, or the best value, the cheapest for each parcel delivered.
 */
export const COURIER_RULE_PICKS = ['cheapest', 'best_value'] as const;
export type CourierRulePick = (typeof COURIER_RULE_PICKS)[number];

/**
 * A courier's delivery rate counts once this many of its parcels in the last
 * {@link DELIVERY_RATE_DAYS} days arrived anywhere (ADR-387).
 */
export const DELIVERY_RATE_MIN = 10;
export const DELIVERY_RATE_DAYS = 90;

/** Rules a shop keeps at most, and cities a rule names at most. */
export const COURIER_RULE_LIMITS = { rules: 50, cities: 100 } as const;

/**
 * Which courier account books an order when staff do not name one (SHP-06, ADR-382): the first
 * of the shop's rules that the order's city and its cash to collect match.
 */
export interface CourierRuleRecord {
  id: string;
  /** Null for one of the shop's accounts picked by their rate cards (ADR-385). */
  accountId: string | null;
  /** How that account is picked; null where the rule names one. */
  pick: CourierRulePick | null;
  /** Cities as Pakistan's list names them; none for anywhere. */
  cities: string[];
  /** The cash to collect, in minor units: at least, and below; null for no bound. */
  codAtLeast: bigint | null;
  codBelow: bigint | null;
  /** Its account was archived since: the rule is passed over. */
  accountArchived: boolean;
}

export interface CourierRuleInput {
  /** Null for one of the shop's accounts picked by their rate cards (ADR-385). */
  accountId: string | null;
  /** How, without an account: the cheapest unless said (ADR-387). */
  pick?: CourierRulePick | null;
  /** Cities of Pakistan, as addresses name them; none or null for anywhere. */
  cities?: readonly string[] | null;
  /** Decimal, in major units; null or blank for no bound. */
  codAtLeast?: string | null;
  codBelow?: string | null;
}

type RuleRow = {
  id: string;
  account_id: string | null;
  pick: CourierRulePick | null;
  cities: string[];
  cod_at_least: string | null;
  cod_below: string | null;
  archived: boolean;
};

/** What a rule is matched against, and the cheapest account priced by. */
export interface RuledParcel {
  city: string | null;
  codAmount: bigint;
  weightGrams: number | null;
}

/** The account a rule chose for an order, and the rule. */
export interface RuledAccount {
  rule: CourierRuleRecord;
  accountId: string;
}

/** How often an account's courier delivers a parcel to the city it goes to: 0 to 1. */
export type DeliveryRateOf = (accountId: string, parcel: RuledParcel) => number;

/**
 * How often `courier` (as parcels name it) delivers to `city` (ADR-387), from `rates`: its rate in
 * the city, else everywhere, else the shop's with every courier, each once
 * {@link DELIVERY_RATE_MIN} parcels arrived anywhere; else 1, as nothing is known.
 */
export function deliveryRateFor(
  rates: readonly DeliveryRateRow[],
  courier: string | null,
  city: string | null,
): number {
  const key = (value: string | null) => (value ? value.trim().toLowerCase() : null);
  const [courierKey, cityKey] = [key(courier), key(city)];
  const rateOf = (row: DeliveryRateRow | undefined) =>
    row && row.finished >= DELIVERY_RATE_MIN ? row.delivered / row.finished : null;
  const find = (c: string | null, t: string | null) =>
    rates.find((row) => row.courier === c && row.city === t);
  return (
    (courierKey && cityKey ? rateOf(find(courierKey, cityKey)) : null) ??
    (courierKey ? rateOf(find(courierKey, null)) : null) ??
    rateOf(find(null, null)) ??
    1
  );
}

/**
 * The account the first of `rules` that `parcel` matches books it with (ADR-382), passing over
 * those whose account was archived; undefined when none does. A rule naming no account picks one
 * among `cards` (live accounts' that can book, the shop's default first): the cheapest (ADR-385),
 * whose card prices the parcel's way out and cash the least; or the best value (ADR-387), the
 * cheapest for each parcel delivered by `deliveryRateOf`; the first of those equal. With no card,
 * it is passed over. A city is matched as Pakistan's list names it, so "Pindi" is Rawalpindi.
 */
export function accountByRules(
  rules: readonly CourierRuleRecord[],
  parcel: RuledParcel,
  cards: readonly RateCardRecord[],
  deliveryRateOf: DeliveryRateOf = () => 1,
): RuledAccount | undefined {
  const name = parcel.city ? (findCity(parcel.city)?.name ?? null) : null;
  for (const rule of rules) {
    const matches =
      !rule.accountArchived &&
      (rule.cities.length === 0 || (name !== null && rule.cities.includes(name))) &&
      (rule.codAtLeast === null || parcel.codAmount >= rule.codAtLeast) &&
      (rule.codBelow === null || parcel.codAmount < rule.codBelow);
    if (!matches) continue;
    if (rule.accountId !== null) return { rule, accountId: rule.accountId };
    const picked =
      rule.pick === 'best_value'
        ? bestValueOf(cards, parcel, deliveryRateOf)
        : cheapestOf(cards, parcel);
    if (picked) return { rule, accountId: picked };
  }
  return undefined;
}

/** The account whose card prices `parcel`'s way out and cash the least; the first of equals. */
export function cheapestOf(
  cards: readonly RateCardRecord[],
  parcel: RuledParcel,
): string | undefined {
  let best: { accountId: string; cost: bigint } | undefined;
  for (const card of cards) {
    const estimate = chargeEstimate(card, parcel);
    const cost = estimate.out + estimate.codFee;
    if (!best || cost < best.cost) best = { accountId: card.accountId, cost };
  }
  return best?.accountId;
}

/**
 * The account whose card prices `parcel` the least for each one delivered (ADR-387): its way out,
 * the cash fee where delivered and the charge back where not, over how often its courier
 * delivers; the first of equals. A courier that never delivers costs without end.
 */
export function bestValueOf(
  cards: readonly RateCardRecord[],
  parcel: RuledParcel,
  deliveryRateOf: DeliveryRateOf,
): string | undefined {
  let best: { accountId: string; cost: number } | undefined;
  for (const card of cards) {
    const { out, codFee, back } = chargeEstimate(card, parcel);
    const rate = deliveryRateOf(card.accountId, parcel);
    const cost =
      rate > 0
        ? (Number(out) + rate * Number(codFee) + (1 - rate) * Number(back)) / rate
        : Number.POSITIVE_INFINITY;
    if (!best || cost < best.cost) best = { accountId: card.accountId, cost };
  }
  return best?.accountId;
}

/** The shop's rules in their order, in the caller's transaction. */
export async function courierRulesIn(tx: Tx, shopId: string): Promise<CourierRuleRecord[]> {
  const { rows } = await tx.execute<RuleRow>(sql`
    SELECT r.id, r.account_id, r.pick, r.cities, r.cod_at_least::text AS cod_at_least,
           r.cod_below::text AS cod_below, a.archived_at IS NOT NULL AS archived
      FROM logistics.courier_rules r
      LEFT JOIN logistics.courier_accounts a ON a.shop_id = r.shop_id AND a.id = r.account_id
     WHERE r.shop_id = ${shopId}
     ORDER BY r.position`);
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    pick: row.pick,
    cities: row.cities,
    codAtLeast: row.cod_at_least === null ? null : BigInt(row.cod_at_least),
    codBelow: row.cod_below === null ? null : BigInt(row.cod_below),
    accountArchived: row.archived,
  }));
}

/**
 * The shop's courier rules (SHP-06, ADR-382): kept in their order, replaced all at once, each
 * naming cities, a range of cash to collect, or both, and the account that books what matches;
 * or none, for the cheapest by rate cards (ADR-385), which may be for every order.
 */
@Injectable()
export class CourierRuleService {
  constructor(private readonly db: Database) {}

  list(tenant: TenantContext): Promise<CourierRuleRecord[]> {
    return this.db.tenant(tenant.shopId, (tx) => courierRulesIn(tx, tenant.shopId));
  }

  /**
   * Replaces the shop's rules with `inputs`, in their order; none for none. Each names a live
   * account of the shop's, and cities, a range of cash, or both; or no account, for the cheapest
   * by rate cards once one has a card. Records `courier_rules.updated` if anything changed.
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
      const { rows: carded } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM logistics.rate_cards c
          JOIN logistics.courier_accounts a ON a.shop_id = c.shop_id AND a.id = c.account_id
         WHERE c.shop_id = ${shopId} AND a.archived_at IS NULL`);
      const rules = inputs.map((input, index) => {
        const at = ['rules', String(index)];
        if (input.accountId === null) {
          if (carded[0]!.count === 0) {
            check.addMessage(
              [...at, 'accountId'],
              'INVALID',
              'Give a courier account a rate card first, for the cheapest to be chosen by',
            );
          }
        } else if (!archived.has(input.accountId)) {
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
        // A rule for the cheapest may be for every order; one account's would be the default's.
        const anywhere = named.length === 0 && !input.codAtLeast?.trim() && !input.codBelow?.trim();
        if (anywhere && input.accountId !== null) {
          check.addMessage(at, 'BLANK', 'Name the cities, or the cash to collect, the rule is for');
        }
        const pick: CourierRulePick | null =
          input.accountId === null ? (input.pick ?? 'cheapest') : null;
        if (pick !== null && !COURIER_RULE_PICKS.includes(pick)) {
          check.addMessage([...at, 'pick'], 'INVALID', `has no pick "${String(pick)}"`);
        }
        return { accountId: input.accountId, pick, cities, codAtLeast, codBelow };
      });
      if (!check.ok) return fail(check.errors);

      const before = await courierRulesIn(tx, shopId);
      const same =
        before.length === rules.length &&
        before.every(
          (rule, index) =>
            rule.accountId === rules[index]!.accountId &&
            rule.pick === rules[index]!.pick &&
            rule.cities.join('\n') === rules[index]!.cities.join('\n') &&
            rule.codAtLeast === rules[index]!.codAtLeast &&
            rule.codBelow === rules[index]!.codBelow,
        );
      if (same) return { ok: true, value: before };

      await tx.execute(sql`DELETE FROM logistics.courier_rules WHERE shop_id = ${shopId}`);
      for (const [position, rule] of rules.entries()) {
        await tx.execute(sql`
          INSERT INTO logistics.courier_rules
                 (shop_id, position, account_id, pick, cities, cod_at_least, cod_below)
          VALUES (${shopId}, ${position}, ${rule.accountId}, ${rule.pick},
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
