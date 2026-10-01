import type { InputChecker } from '@hatti/api';
import type { CurrencyCode } from '@hatti/money';
import { findCity } from '@hatti/pk';

/**
 * A shop's rules for cash on delivery at checkout (CHK-07, ADR-075): checkout offers bank transfer
 * instead where they keep it, or says why it can't take the order; and its fee for it (CHK-08,
 * ADR-076), which checkout adds to orders paid on delivery. Orders staff and apps place are the
 * shop's own call, and keep to the law's cap alone.
 */
export interface CodRulesRecord {
  /** Minor units: no cash on delivery for orders above it; null for no limit but the law's. */
  maxOrderTotal: bigint | null;
  /** Cities where checkout doesn't offer it, as `@hatti/pk` spells them: "Gilgit". */
  unavailableCities: string[];
  /** Customers who refused this many parcels, or more, pay another way; null for no limit. */
  refusedDeliveriesLimit: number | null;
  /** Minor units: what an order paid on delivery is charged for it (CHK-08); 0 for nothing. */
  fee: bigint;
  /** Null while the shop has set none. */
  updatedAt: Date | null;
}

/** What a shop that has set nothing keeps: cash on delivery for every order the law allows. */
export const NO_COD_RULES: CodRulesRecord = {
  maxOrderTotal: null,
  unavailableCities: [],
  refusedDeliveriesLimit: null,
  fee: 0n,
  updatedAt: null,
};

export const COD_RULE_LIMITS = { cities: 200, refusedDeliveries: 100 } as const;

/** Those left out stay as they are; `unavailableCities`, when given, replaces them all. */
export interface CodRulesInput {
  /** Decimal, in major units, such as "25,000"; null or blank for none. */
  maxOrderTotal?: string | null;
  /** Cities by name, alias or code, as addresses have them: "Gilgit", "isb". */
  unavailableCities?: string[] | null;
  /** 1 to 100; null for none. */
  refusedDeliveriesLimit?: number | null;
  /** Decimal, in major units, such as "100"; null or blank for nothing. */
  fee?: string | null;
}

/** Why the shop's rules keep cash on delivery from an order (ADR-075). */
export type CodRefusal =
  /** It comes to more than the shop takes cash on delivery for. */
  | { reason: 'total'; max: bigint }
  /** The shop doesn't take cash on delivery in its city. */
  | { reason: 'city'; city: string }
  /** Its customer refused as many parcels before as the shop allows, or more. */
  | { reason: 'customer' };

/**
 * Why `rules` keep cash on delivery from an order of `total` to `city`, by a customer who refused
 * `refused` parcels before; null when they don't. What isn't known yet is left out: before the
 * shopper types anything, the page knows the items' total alone.
 */
export function codRefusalOf(
  rules: CodRulesRecord,
  order: { total: bigint; city?: string | null; refused?: number },
): CodRefusal | null {
  if (rules.maxOrderTotal !== null && order.total > rules.maxOrderTotal) {
    return { reason: 'total', max: rules.maxOrderTotal };
  }
  const city = order.city ? (findCity(order.city)?.name ?? null) : null;
  if (city !== null && rules.unavailableCities.includes(city)) return { reason: 'city', city };
  const limit = rules.refusedDeliveriesLimit;
  if (limit !== null && order.refused !== undefined && order.refused >= limit) {
    return { reason: 'customer' };
  }
  return null;
}

/**
 * The rules `input` makes of `current`, or null after adding what is wrong to `check`. Cities are
 * the ones addresses name, each once.
 */
export function checkCodRules(
  check: InputChecker,
  current: CodRulesRecord,
  input: CodRulesInput,
  currency: CurrencyCode,
): Omit<CodRulesRecord, 'updatedAt'> | null {
  const before = check.errors.length;
  let { maxOrderTotal, unavailableCities, refusedDeliveriesLimit, fee } = current;
  if (input.maxOrderTotal !== undefined) {
    maxOrderTotal = check.price(['input', 'maxOrderTotal'], input.maxOrderTotal, currency);
    if (maxOrderTotal === 0n) {
      check.addMessage(['input', 'maxOrderTotal'], 'INVALID', 'The limit must be above Rs 0');
    }
  }
  if (input.unavailableCities !== undefined && input.unavailableCities !== null) {
    unavailableCities = checkCities(check, input.unavailableCities);
  }
  if (input.refusedDeliveriesLimit !== undefined) {
    refusedDeliveriesLimit =
      input.refusedDeliveriesLimit === null
        ? null
        : check.integer(['input', 'refusedDeliveriesLimit'], input.refusedDeliveriesLimit, {
            min: 1,
            max: COD_RULE_LIMITS.refusedDeliveries,
          });
  }
  if (input.fee !== undefined) {
    fee = check.price(['input', 'fee'], input.fee, currency) ?? 0n;
  }
  if (check.errors.length > before) return null;
  return { maxOrderTotal, unavailableCities, refusedDeliveriesLimit, fee };
}

function checkCities(check: InputChecker, inputs: readonly string[]): string[] {
  const field = ['input', 'unavailableCities'];
  if (inputs.length > COD_RULE_LIMITS.cities) {
    check.addMessage(field, 'TOO_MANY', `At most ${COD_RULE_LIMITS.cities} cities`);
    return [];
  }
  const cities: string[] = [];
  inputs.forEach((text, index) => {
    const city = findCity(text);
    if (!city) {
      check.addMessage(
        [...field, String(index)],
        'INVALID',
        `"${text.trim()}" is not a city of Pakistan we know`,
      );
    } else if (!cities.includes(city.name)) {
      cities.push(city.name);
    }
  });
  return cities;
}
