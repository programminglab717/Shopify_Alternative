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
  /**
   * Orders the shop's risk rules score this or more, 1 to 100, as they are placed, pay another
   * way (COD-06, ADR-099); null for no limit. Above the advance's `riskScore`, where it has one.
   */
  riskScoreLimit: number | null;
  /**
   * Orders the shop's risk rules score this or more, 0 to 100, as they are placed, ask the
   * shopper first for a code sent to the number they typed (CHK-09, ADR-148); 0 for every order
   * paid on delivery, null for none.
   */
  verifyFromScore: number | null;
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
  riskScoreLimit: null,
  verifyFromScore: null,
  fee: 0n,
  advance: null,
  updatedAt: null,
};

/**
 * What cash on delivery asks for in advance, paid by transfer into the shop's account before the
 * order ships (CHK-10, ADR-084): an amount, a percentage of the items after any code, or the
 * order's delivery charge; on every order, or only on those that meet each of its conditions:
 * items that come to more than `above`, a city of its `cities`, a customer who refused
 * `refusedDeliveries` parcels before (ADR-089), a customer new to the shop, a risk score of
 * `riskScore` or more (ADR-094), a product tagged with one of its `productTags` (ADR-224).
 */
export type CodAdvanceValue = (
  | { kind: 'fixed_amount'; amount: bigint }
  /** Hundredths of a percent: 2000 is 20%. */
  | { kind: 'percentage'; percentageBps: number }
  | { kind: 'delivery' }
) & {
  /** Minor units: only on orders whose items come to more; null for every order. */
  above: bigint | null;
  /** Only on orders to these cities, as `@hatti/pk` names them: "Karachi"; empty for everywhere. */
  cities: string[];
  /** Only of customers who refused this many parcels before, or more; null for every customer. */
  refusedDeliveries: number | null;
  /** Only of customers none of whose orders the shop delivered before. */
  newCustomers: boolean;
  /**
   * Only of orders whose risk score, 1 to 100, is this or more, as the shop's risk rules score
   * them as they are placed; null for every order. Such an order is asked it instead of waiting
   * for review.
   */
  riskScore: number | null;
  /**
   * Only on orders holding a product tagged with any of these, in any letter case: "pre-order";
   * empty for every order.
   */
  productTags: string[];
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
  /** Cities by name, alias or code, as addresses have them: "Karachi", "khi"; empty for all. */
  cities?: string[] | null;
  /** 1 to 100; null for every customer. */
  refusedDeliveries?: number | null;
  /** True for customers new to the shop alone. */
  newCustomers?: boolean | null;
  /** 0.01 to 1, in hundredths, as risk scores are said; null for every order. */
  riskScore?: number | null;
  /** Products' tags, as the shop writes them on its products: "pre-order"; empty for all. */
  productTags?: string[] | null;
}

export const COD_RULE_LIMITS = {
  cities: 200,
  /** Fewer, as checkout's page names them all (ADR-089). */
  advanceCities: 50,
  productTags: 50,
  refusedDeliveries: 100,
} as const;

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
  /** 0.01 to 1, in hundredths, as risk scores are said; null for none. */
  riskScoreLimit?: number | null;
  /** 0 to 1, in hundredths; 0 for every order paid on delivery; null for none. */
  verifyFromScore?: number | null;
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
  | { reason: 'customer' }
  /**
   * The shop's risk rules scored it at the shop's limit or above (ADR-099): known only once it is
   * placed.
   */
  | { reason: 'risk' }
  /** It was opened from a payment link the shop takes prepaid alone (ADR-248). */
  | { reason: 'link' };

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
  const product = taggedProductOf(order.products ?? [], rules.unavailableProductTags);
  if (product) return { reason: 'product', title: product.title };
  const city = order.city ? (findCity(order.city)?.name ?? null) : null;
  if (city !== null && rules.unavailableCities.includes(city)) return { reason: 'city', city };
  const limit = rules.refusedDeliveriesLimit;
  if (limit !== null && order.refused !== undefined && order.refused >= limit) {
    return { reason: 'customer' };
  }
  return null;
}

/** The first of `products` tagged with any of `tags`, in any letter case; null for none. */
function taggedProductOf(
  products: readonly CodProduct[],
  tags: readonly string[],
): CodProduct | null {
  if (tags.length === 0) return null;
  const lower = new Set(tags.map((tag) => tag.toLowerCase()));
  return (
    products.find((product) => product.tags.some((tag) => lower.has(tag.toLowerCase()))) ?? null
  );
}

/**
 * `advance` as a cart holding `products` is asked it, its products known before the shopper types
 * anything (ADR-224): with the first tagged with one of its tags, which the page names; with none,
 * where it names no tags; null where the cart holds none of them, as it isn't asked of the cart.
 */
export function advanceForCart(
  advance: CodAdvanceValue | null,
  products: readonly CodProduct[],
): { advance: CodAdvanceValue; product: string | null } | null {
  if (!advance) return null;
  if (advance.productTags.length === 0) return { advance, product: null };
  const product = taggedProductOf(products, advance.productTags);
  return product && { advance, product: product.title };
}

/**
 * What `advance` asks for on an order paid on delivery whose items come to `items` after any code,
 * delivered for `delivery` to `city`, by a customer who refused `refused` parcels before and took
 * `delivered` orders, in minor units of `currency`: what {@link advanceAmountOf} says, on an order
 * that meets its conditions ({@link advanceTakes}); nothing on one that doesn't. Null while it
 * isn't known: the delivery charge, the city or the customer, as before the shopper types them,
 * or the order's risk, scored as it is placed.
 */
export function advanceOf(
  advance: CodAdvanceValue | null,
  order: {
    items: bigint;
    delivery: bigint | null;
    city?: string | null;
    refused?: number;
    delivered?: number;
  },
  currency: CurrencyCode,
): bigint | null {
  if (!advance) return 0n;
  const takes = advanceTakes(advance, order);
  if (takes === false) return 0n;
  const amount = advanceAmountOf(advance, order, currency);
  const known = takes === true && advance.riskScore === null;
  return !known && amount !== 0n ? null : amount;
}

/**
 * Whether `advance` is asked of an order to `city` by a customer who refused `refused` parcels
 * before and took `delivered` orders (ADR-089, ADR-094): to one of its cities, if it names any; by
 * a customer who refused as many parcels as it says, or more, if it says; by a customer the shop
 * delivered nothing to before, if it asks new customers alone. Null while one it asks about isn't
 * known. Its risk score is another matter: the order is scored as it is placed
 * ({@link placedAdvanceOf}); and its products another, known before anything is typed
 * ({@link advanceForCart}).
 */
export function advanceTakes(
  advance: CodAdvanceValue,
  order: { city?: string | null; refused?: number; delivered?: number },
): boolean | null {
  let known = true;
  if (advance.cities.length > 0) {
    if (!order.city?.trim()) known = false;
    else if (!advance.cities.includes(findCity(order.city)?.name ?? '')) return false;
  }
  if (advance.refusedDeliveries !== null) {
    if (order.refused === undefined) known = false;
    else if (order.refused < advance.refusedDeliveries) return false;
  }
  if (advance.newCustomers) {
    if (order.delivered === undefined) known = false;
    else if (order.delivered > 0) return false;
  }
  return known ? true : null;
}

/** Whether `advance` needs to know who an order is from: its refusals, or whether it is new. */
export function advanceAsksOfCustomers(advance: CodAdvanceValue | null): boolean {
  return advance !== null && (advance.refusedDeliveries !== null || advance.newCustomers);
}

/**
 * What `advance` asks of an order being placed, paid on delivery, its city and customer known
 * (ADR-094): `due`, asked whatever its risk; or `ifRisky`, asked only if the shop's risk rules
 * score the order `from` or more, instead of holding it for review. Nothing of an order that
 * doesn't meet its other conditions.
 */
export function placedAdvanceOf(
  advance: CodAdvanceValue | null,
  order: { items: bigint; delivery: bigint; city: string; refused?: number; delivered?: number },
  currency: CurrencyCode,
): { due: bigint; ifRisky: { due: bigint; from: number } | null } {
  const takes = advance !== null && advanceTakes(advance, order) === true;
  const amount = takes ? (advanceAmountOf(advance, order, currency) ?? 0n) : 0n;
  if (amount === 0n) return { due: 0n, ifRisky: null };
  return advance!.riskScore === null
    ? { due: amount, ifRisky: null }
    : { due: 0n, ifRisky: { due: amount, from: advance!.riskScore } };
}

/**
 * What `advance` asks for on an order paid on delivery whose items come to `items` after any code,
 * delivered for `delivery`, in minor units of `currency` (ADR-084), whatever its cities and
 * customers: its amount, never more than the items; its percentage of them, rounded half up to a
 * whole rupee so that what is transferred stays whole; or the delivery charge, nothing where
 * delivery is free. Nothing at or below its total, or without one; null while it is the delivery
 * charge and that isn't known, as before the shopper types a city.
 */
export function advanceAmountOf(
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
  const cities = advance.cities.join('|');
  const whom = `${advance.refusedDeliveries ?? ''}:${advance.newCustomers}:${advance.riskScore ?? ''}`;
  // Its products' tags, where it names any: without, the key is what it was before them.
  const tags = advance.productTags.length > 0 ? `:${advance.productTags.join('|')}` : '';
  return `${advance.kind}:${what}:${advance.above ?? ''}:${cities}:${whom}${tags}`;
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
    riskScoreLimit,
    verifyFromScore,
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
    unavailableCities = checkCities(
      check,
      ['input', 'unavailableCities'],
      input.unavailableCities,
      COD_RULE_LIMITS.cities,
    );
  }
  if (input.unavailableProductTags !== undefined && input.unavailableProductTags !== null) {
    unavailableProductTags = checkProductTags(
      check,
      ['input', 'unavailableProductTags'],
      input.unavailableProductTags,
    );
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
  if (input.riskScoreLimit !== undefined) {
    riskScoreLimit = checkRiskScore(check, ['input', 'riskScoreLimit'], input.riskScoreLimit);
  }
  if (input.verifyFromScore !== undefined) {
    verifyFromScore = checkRiskScore(check, ['input', 'verifyFromScore'], input.verifyFromScore, 0);
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
  // Asked an advance from one score, an order is paid ahead from a higher one (ADR-099): from the
  // same or a lower one, the advance would never be asked.
  const from = advance?.riskScore ?? null;
  if (riskScoreLimit !== null && from !== null && riskScoreLimit <= from) {
    const said = (points: number) => (points / 100).toFixed(2);
    if (input.riskScoreLimit !== undefined) {
      check.addMessage(
        ['input', 'riskScoreLimit'],
        'INVALID',
        `The limit must be above the risk the advance is asked from, ${said(from)}`,
      );
    } else {
      check.addMessage(
        ['input', 'advance', 'riskScore'],
        'INVALID',
        `The risk must be below the limit for cash on delivery, ${said(riskScoreLimit)}`,
      );
    }
    return null;
  }
  return {
    maxOrderTotal,
    unavailableCities,
    unavailableProductTags,
    refusedDeliveriesLimit,
    riskScoreLimit,
    verifyFromScore,
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
  // Where, and of whom, it is asked (ADR-089): everywhere, and of everyone, unless said.
  const conditions = {
    above,
    cities: checkCities(
      check,
      [...field, 'cities'],
      input.cities ?? [],
      COD_RULE_LIMITS.advanceCities,
    ),
    refusedDeliveries:
      input.refusedDeliveries === undefined || input.refusedDeliveries === null
        ? null
        : check.integer([...field, 'refusedDeliveries'], input.refusedDeliveries, {
            min: 1,
            max: COD_RULE_LIMITS.refusedDeliveries,
          }),
    newCustomers: input.newCustomers ?? false,
    riskScore: checkRiskScore(check, [...field, 'riskScore'], input.riskScore),
    productTags: checkProductTags(check, [...field, 'productTags'], input.productTags),
  };
  if (amountGiven) {
    const amount = check.price([...field, 'amount'], input.amount, currency);
    if (amount === 0n) check.add([...field, 'amount'], 'INVALID', 'must be more than zero');
    if (check.errors.length > before || amount === null) return null;
    return { kind: 'fixed_amount', amount, ...conditions };
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
    return { kind: 'percentage', percentageBps: bps, ...conditions };
  }
  if (check.errors.length > before) return null;
  return { kind: 'delivery', ...conditions };
}

/**
 * A risk score as the API says it, 0.01 to 1 in hundredths, as the points the rules give: 1 to
 * 100; null for none.
 */
function checkRiskScore(
  check: InputChecker,
  field: string[],
  score: number | null | undefined,
  min = 1,
): number | null {
  if (score === null || score === undefined) return null;
  const points = Math.round(score * 100);
  if (
    !Number.isFinite(score) ||
    Math.abs(score * 100 - points) > 1e-9 ||
    points < min ||
    points > 100
  ) {
    check.add(field, 'INVALID', `must be from ${min === 0 ? '0' : '0.01'} to 1, in hundredths`);
    return null;
  }
  return points;
}

/**
 * Products' tags as staff typed them at `field`, each once whatever its letter case, as many as
 * {@link COD_RULE_LIMITS} allows at most.
 */
function checkProductTags(
  check: InputChecker,
  field: string[],
  inputs: string[] | null | undefined,
): string[] {
  const tags = check.tags(field, inputs);
  if (tags.length > COD_RULE_LIMITS.productTags) {
    check.addMessage(field, 'TOO_MANY', `At most ${COD_RULE_LIMITS.productTags} tags`);
  }
  return tags;
}

/** Cities as addresses name them, each once, `max` at most, from what staff typed at `field`. */
function checkCities(
  check: InputChecker,
  field: string[],
  inputs: readonly string[],
  max: number,
): string[] {
  if (inputs.length > max) {
    check.addMessage(field, 'TOO_MANY', `At most ${max} cities`);
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
