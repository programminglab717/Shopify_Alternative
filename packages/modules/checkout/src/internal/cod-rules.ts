import type { InputChecker } from '@hatti/api';
import { divideRounded, exponentOf, type CurrencyCode } from '@hatti/money';
import { findCity } from '@hatti/pk';

/**
 * A shop's rules for cash on delivery at checkout (CHK-07, ADR-075, ADR-078): checkout offers bank
 * transfer instead where they keep it, or says why it can't take the order; its fee for it
 * (CHK-08, ADR-076), which checkout adds to orders paid on delivery; and what it asks for in
 * advance on them (CHK-10, ADR-084). Orders staff and apps place are the shop's own call, and keep
 * to the law's cap alone.
 */
export interface CodRulesRecord {
  /** Minor units: no cash on delivery for orders above it; null for no limit but the law's. */
  maxOrderTotal: bigint | null;
  /** Cities where checkout doesn't offer it, as `@hatti/pk` spells them: "Gilgit". */
  unavailableCities: string[];
  /**
   * Products tagged with any of these, in any letter case, are paid another way: "pre-order".
   */
  unavailableProductTags: string[];
  /** Customers who refused this many parcels, or more, pay another way; null for no limit. */
  refusedDeliveriesLimit: number | null;
  /** Minor units: what an order paid on delivery is charged for it (CHK-08); 0 for nothing. */
  fee: bigint;
  /** What checkout asks for in advance on an order paid on delivery (ADR-084); null for none. */
  advance: CodAdvanceValue | null;
  /** Null while the shop has set none. */
  updatedAt: Date | null;
}

/** What a shop that has set nothing keeps: cash on delivery for every order the law allows. */
export const NO_COD_RULES: CodRulesRecord = {
  maxOrderTotal: null,
  unavailableCities: [],
  unavailableProductTags: [],
  refusedDeliveriesLimit: null,
  fee: 0n,
  advance: null,
  updatedAt: null,
};

/**
 * What cash on delivery asks for in advance, paid by transfer into the shop's account before the
 * order ships (CHK-10, ADR-084): an amount, a percentage of the items after any code, or the
 * order's delivery charge; on every order, or on those whose items come to more than `above`.
 */
export type CodAdvanceValue = (
  | { kind: 'fixed_amount'; amount: bigint }
  /** Hundredths of a percent: 2000 is 20%. */
  | { kind: 'percentage'; percentageBps: number }
  | { kind: 'delivery' }
) & {
  /** Minor units: only on orders whose items come to more; null for every order. */
  above: bigint | null;
};

/** An amount, a percentage or the delivery charge: one of the three. */
export interface CodAdvanceInput {
  /** Decimal, in major units: "500". */
  amount?: string | null;
  /** 0.01 to 100, two decimals at most: 20 is 20%. */
  percentage?: number | null;
  /** True for the order's delivery charge. */
  deliveryCharge?: boolean | null;
  /** Decimal, in major units: "10,000"; null or blank for every order. */
  above?: string | null;
}

export const COD_RULE_LIMITS = { cities: 200, productTags: 50, refusedDeliveries: 100 } as const;

/**
 * Those left out stay as they are; `unavailableCities` and `unavailableProductTags`, when given,
 * replace them all.
 */
export interface CodRulesInput {
  /** Decimal, in major units, such as "25,000"; null or blank for none. */
  maxOrderTotal?: string | null;
  /** Cities by name, alias or code, as addresses have them: "Gilgit", "isb". */
  unavailableCities?: string[] | null;
  /** Products' tags, as the shop writes them on its products: "pre-order". */
  unavailableProductTags?: string[] | null;
  /** 1 to 100; null for none. */
  refusedDeliveriesLimit?: number | null;
  /** Decimal, in major units, such as "100"; null or blank for nothing. */
  fee?: string | null;
  /** Replaces what it asks for in advance; null for none. */
  advance?: CodAdvanceInput | null;
}

/** Why the shop's rules keep cash on delivery from an order (ADR-075). */
export type CodRefusal =
  /** It comes to more than the shop takes cash on delivery for. */
  | { reason: 'total'; max: bigint }
  /** It holds a product the shop takes cash on delivery for none of: the product's title. */
  | { reason: 'product'; title: string }
  /** The shop doesn't take cash on delivery in its city. */
  | { reason: 'city'; city: string }
  /** Its customer refused as many parcels before as the shop allows, or more. */
  | { reason: 'customer' };

/** A product in an order, as the shop's rules for cash on delivery see it. */
export interface CodProduct {
  title: string;
  tags: readonly string[];
}

/**
 * Why `rules` keep cash on delivery from an order of `total`, holding `products`, to `city`, by a
 * customer who refused `refused` parcels before; null when they don't. What isn't known yet is
 * left out: before the shopper types anything, the page knows the items alone.
 */
export function codRefusalOf(
  rules: CodRulesRecord,
  order: {
    total: bigint;
    products?: readonly CodProduct[];
    city?: string | null;
    refused?: number;
  },
): CodRefusal | null {
  if (rules.maxOrderTotal !== null && order.total > rules.maxOrderTotal) {
    return { reason: 'total', max: rules.maxOrderTotal };
  }
  const tags = new Set(rules.unavailableProductTags.map((tag) => tag.toLowerCase()));
  const product =
    tags.size === 0
      ? undefined
      : order.products?.find((candidate) =>
          candidate.tags.some((tag) => tags.has(tag.toLowerCase())),
        );
  if (product) return { reason: 'product', title: product.title };
  const city = order.city ? (findCity(order.city)?.name ?? null) : null;
  if (city !== null && rules.unavailableCities.includes(city)) return { reason: 'city', city };
  const limit = rules.refusedDeliveriesLimit;
  if (limit !== null && order.refused !== undefined && order.refused >= limit) {
    return { reason: 'customer' };
  }
  return null;
}

/**
 * What `advance` asks for on an order paid on delivery whose items come to `items` after any code,
 * delivered for `delivery`, in minor units of `currency` (ADR-084): its amount, never more than
 * the items; its percentage of them, rounded half up to a whole rupee so that what is transferred
 * stays whole; or the delivery charge, nothing where delivery is free. Nothing at or below its
 * total, or without one; null while it is the delivery charge and that isn't known, as before the
 * shopper types a city.
 */
export function advanceOf(
  advance: CodAdvanceValue | null,
  order: { items: bigint; delivery: bigint | null },
  currency: CurrencyCode,
): bigint | null {
  const { items, delivery } = order;
  if (!advance || (advance.above !== null && items <= advance.above)) return 0n;
  switch (advance.kind) {
    case 'fixed_amount':
      return advance.amount < items ? advance.amount : items;
    case 'percentage': {
      const unit = 10n ** BigInt(exponentOf(currency));
      const share =
        divideRounded(items * BigInt(advance.percentageBps), 10_000n * unit, 'half-up') * unit;
      return share < items ? share : items;
    }
    case 'delivery':
      return delivery;
  }
}

/** The advance as a string, the same for advances asking for the same: for comparing them. */
export function advanceKeyOf(advance: CodAdvanceValue | null): string {
  if (!advance) return '';
  const what =
    advance.kind === 'fixed_amount'
      ? advance.amount
      : advance.kind === 'percentage'
        ? advance.percentageBps
        : '';
  return `${advance.kind}:${what}:${advance.above ?? ''}`;
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
  let {
    maxOrderTotal,
    unavailableCities,
    unavailableProductTags,
    refusedDeliveriesLimit,
    fee,
    advance,
  } = current;
  if (input.maxOrderTotal !== undefined) {
    maxOrderTotal = check.price(['input', 'maxOrderTotal'], input.maxOrderTotal, currency);
    if (maxOrderTotal === 0n) {
      check.addMessage(['input', 'maxOrderTotal'], 'INVALID', 'The limit must be above Rs 0');
    }
  }
  if (input.unavailableCities !== undefined && input.unavailableCities !== null) {
    unavailableCities = checkCities(check, input.unavailableCities);
  }
  if (input.unavailableProductTags !== undefined && input.unavailableProductTags !== null) {
    const field = ['input', 'unavailableProductTags'];
    unavailableProductTags = check.tags(field, input.unavailableProductTags);
    if (unavailableProductTags.length > COD_RULE_LIMITS.productTags) {
      check.addMessage(field, 'TOO_MANY', `At most ${COD_RULE_LIMITS.productTags} tags`);
    }
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
  if (input.advance !== undefined) {
    advance =
      input.advance === null
        ? null
        : checkAdvance(check, ['input', 'advance'], input.advance, currency);
  }
  if (check.errors.length > before) return null;
  return {
    maxOrderTotal,
    unavailableCities,
    unavailableProductTags,
    refusedDeliveriesLimit,
    fee,
    advance,
  };
}

/** The advance `input` asks for, checked; null after adding what is wrong to `check`, at `field`. */
function checkAdvance(
  check: InputChecker,
  field: string[],
  input: CodAdvanceInput,
  currency: CurrencyCode,
): CodAdvanceValue | null {
  const before = check.errors.length;
  const amountGiven = (input.amount?.trim() ?? '') !== '';
  const percentage = input.percentage ?? null;
  const given = [amountGiven, percentage !== null, input.deliveryCharge === true].filter(Boolean);
  if (given.length !== 1) {
    check.addMessage(
      field,
      given.length === 0 ? 'BLANK' : 'INVALID',
      given.length === 0
        ? 'Say what to ask for in advance: an amount, a percentage or the delivery charge'
        : 'Ask for an amount, a percentage or the delivery charge: one of them',
    );
    return null;
  }
  const above = check.price([...field, 'above'], input.above, currency);
  if (above === 0n) {
    check.addMessage([...field, 'above'], 'INVALID', 'The total must be above Rs 0');
  }
  if (amountGiven) {
    const amount = check.price([...field, 'amount'], input.amount, currency);
    if (amount === 0n) check.add([...field, 'amount'], 'INVALID', 'must be more than zero');
    if (check.errors.length > before || amount === null) return null;
    return { kind: 'fixed_amount', amount, above };
  }
  if (percentage !== null) {
    const bps = Math.round(percentage * 100);
    if (!(bps >= 1 && bps <= 10_000) || Math.abs(percentage * 100 - bps) > 1e-6) {
      check.addMessage(
        [...field, 'percentage'],
        'INVALID',
        'Percentage must be from 0.01 to 100, with two decimals at most, like 20 or 12.5',
      );
    }
    if (check.errors.length > before) return null;
    return { kind: 'percentage', percentageBps: bps, above };
  }
  if (check.errors.length > before) return null;
  return { kind: 'delivery', above };
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
