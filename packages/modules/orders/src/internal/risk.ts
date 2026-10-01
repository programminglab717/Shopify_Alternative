import { formatMoney, fromMajor, money, type CurrencyCode } from '@hatti/money';
import { findCity } from '@hatti/pk';
import { orderName } from './rules.js';
import type { AddressValue, RiskLevelValue, RiskReasonValue } from './schema.js';

/**
 * Cash-on-delivery risk from transparent rules (COD-06, MVP): points out of 100 for what makes a
 * parcel likely to come back unpaid, and points off for what makes it likely to be taken. A trained
 * model with the same shape of answer comes later (docs/architecture/09-ai-and-intelligence.md
 * §4.1).
 *
 * Fairness: no rule looks at which city an order is for, only whether the city is spelled in a way
 * couriers will recognise; no single address rule reaches the medium level on its own.
 */

/** Points each rule adds; negative points lower the risk. */
export const RISK_WEIGHTS = {
  refusedOnce: 35,
  refusedMore: 50,
  cancelledMore: 10,
  firstOrder: 10,
  trustedCustomer: -20,
  highValue: 20,
  manyUnits: 15,
  recentOrder: 25,
  noHouseNumber: 15,
  shortAddress: 10,
  unknownCity: 10,
} as const;

/** Units in one order that count as many. */
export const MANY_UNITS = 10;
/** Another unshipped order from the same customer this recently may be a duplicate. */
export const RECENT_ORDER_HOURS = 6;

/** A shop's risk policy. */
export interface RiskSettings {
  /** Cash-on-delivery orders scoring this or more (1 to 100) wait for review; null holds none. */
  holdAt: number | null;
  /** Orders totalling this or more count as high value; minor units of the shop's currency. */
  highValue: bigint;
}

/** The policy of a shop that has not set its own: hold high-risk orders, Rs 15,000 is a lot. */
export function defaultRiskSettings(currency: CurrencyCode): RiskSettings {
  return { holdAt: 60, highValue: fromMajor('15000', currency).amount };
}

export interface RiskAssessment {
  /** 0 to 100. */
  score: number;
  level: RiskLevelValue;
  /** Strongest first. */
  reasons: RiskReasonValue[];
}

/** What the rules look at. */
export interface RiskInputs {
  total: bigint;
  currency: CurrencyCode;
  units: number;
  address: AddressValue;
  /** The customer's other orders in this shop, as their delivery history counts them. */
  history: { orders: number; delivered: number; returned: number; cancelled: number };
  /** The number of another unshipped order from the customer, placed within the last hours. */
  recentOrderNumber: number | null;
  /** The shop's high-value amount, in minor units. */
  highValue: bigint;
}

export function riskLevelOf(score: number): RiskLevelValue {
  return score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';
}

export function assessRisk(inputs: RiskInputs): RiskAssessment {
  const reasons: RiskReasonValue[] = [];
  const add = (code: string, weight: number, message: string) =>
    reasons.push({ code, weight, message });
  const { history, address } = inputs;

  if (history.returned >= 2) {
    add(
      'refused_deliveries',
      RISK_WEIGHTS.refusedMore,
      `Refused ${history.returned} deliveries from this shop`,
    );
  } else if (history.returned === 1) {
    add('refused_deliveries', RISK_WEIGHTS.refusedOnce, 'Refused a delivery from this shop');
  }
  if (history.cancelled >= 2) {
    add(
      'cancelled_orders',
      RISK_WEIGHTS.cancelledMore,
      `Cancelled ${history.cancelled} orders before`,
    );
  }
  if (history.orders === 0) {
    add('first_order', RISK_WEIGHTS.firstOrder, 'First order from this number');
  } else if (history.delivered >= 2 && history.returned === 0) {
    add(
      'trusted_customer',
      RISK_WEIGHTS.trustedCustomer,
      `Took delivery of ${history.delivered} orders before, and refused none`,
    );
  }
  if (inputs.recentOrderNumber !== null) {
    add(
      'recent_order',
      RISK_WEIGHTS.recentOrder,
      `Another order from this number in the last ${RECENT_ORDER_HOURS} hours: ` +
        orderName(inputs.recentOrderNumber),
    );
  }
  if (inputs.total >= inputs.highValue) {
    add(
      'high_value',
      RISK_WEIGHTS.highValue,
      `High value: ${formatMoney(money(inputs.total, inputs.currency))}`,
    );
  }
  if (inputs.units >= MANY_UNITS) {
    add('many_units', RISK_WEIGHTS.manyUnits, `${inputs.units} items, more than most orders`);
  }
  if (!/\d/.test(address.address1)) {
    add('no_house_number', RISK_WEIGHTS.noHouseNumber, 'The address has no house or street number');
  }
  if (address.address1.length < 10) {
    add('short_address', RISK_WEIGHTS.shortAddress, 'The address is very short');
  }
  if (!findCity(address.city)) {
    add(
      'unknown_city',
      RISK_WEIGHTS.unknownCity,
      `"${address.city}" is not a city couriers know by that spelling`,
    );
  }

  const total = reasons.reduce((sum, reason) => sum + reason.weight, 0);
  const score = Math.min(100, Math.max(0, total));
  // Stable: equal weights keep the order above.
  reasons.sort((a, b) => b.weight - a.weight);
  return { score, level: riskLevelOf(score), reasons };
}

/** Whether the policy holds an order with this score for review. */
export function holdsForRisk(settings: RiskSettings, score: number): boolean {
  return settings.holdAt !== null && score >= settings.holdAt;
}

/**
 * Why an order waits for review, for its timeline: its score on the API's scale of 0 to 1, and what
 * raised it.
 */
export function heldForRiskMessage(assessment: RiskAssessment): string {
  return `Held for review: ${riskWords(assessment)}`;
}

/**
 * Why an order asks for an advance of `amount` by its risk, instead of waiting for review
 * (ADR-094), for its timeline.
 */
export function advanceForRiskMessage(assessment: RiskAssessment, amount: string): string {
  return `Asks for ${amount} in advance for its ${riskWords(assessment)}`;
}

/**
 * Why an order's score changed after it was placed, as its customer's history changed (ADR-112),
 * for its timeline: what it is now, what it was, and what raises it.
 */
export function rescoredMessage(previous: number, assessment: RiskAssessment): string {
  const raised = assessment.reasons.filter((reason) => reason.weight > 0);
  return (
    `Scored again as the customer's history changed: risk ${(assessment.score / 100).toFixed(2)} ` +
    `(${assessment.level}), was ${(previous / 100).toFixed(2)}.` +
    (raised.length > 0 ? ` ${raised.map((reason) => reason.message).join('; ')}` : '')
  );
}

/** "risk 0.65 (high). First order from this number; …": its score, and what raised it. */
function riskWords(assessment: RiskAssessment): string {
  const raised = assessment.reasons.filter((reason) => reason.weight > 0);
  return (
    `risk ${(assessment.score / 100).toFixed(2)} (${assessment.level}). ` +
    raised.map((reason) => reason.message).join('; ')
  );
}
