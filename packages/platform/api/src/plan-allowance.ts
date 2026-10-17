import type { Tx } from '@hatti/db';

/**
 * What a shop's plan with Hatti counts and limits (BIL-01, ADR-154): its staff and locations, and
 * its orders a month (ADR-263).
 */
export type PlanLimitKind = 'staff' | 'locations' | 'ordersPerMonth';

/**
 * What a shop's plan with Hatti includes or leaves out (BIL-01, ADR-264): a domain of the shop's
 * own, and its accounts with payment gateways; custom apps, automations and the abandoned
 * checkout reminder, cashback, and Meta's conversions API (ADR-523); hiding "Powered by
 * Hatti" from its storefront (ADR-526); and true profit in the sales report (ADR-529).
 */
export type PlanFeature =
  | 'customDomains'
  | 'onlineGateways'
  | 'customApps'
  | 'automations'
  | 'loyalty'
  | 'conversionsApi'
  | 'removeBranding'
  | 'trueProfit';

/** A limit of the shop's plan. */
export interface PlanLimit {
  /** How many the plan allows. */
  limit: number;
  /** The plan's name, such as "Free", to say which. */
  plan: string;
}

/**
 * The limits of a shop's plan, as the billing module keeps them (ADR-154). Modules that add what
 * a plan limits ask before adding one; without it, as in most tests, nothing is limited.
 */
export abstract class PlanAllowance {
  /** What the shop's plan allows of `kind`; null when it sets no limit. */
  abstract limitOf(shopId: string, kind: PlanLimitKind): Promise<PlanLimit | null>;

  /** {@link limitOf}, read in the shop's transaction `tx`, as placing an order asks it. */
  abstract limitIn(tx: Tx, shopId: string, kind: PlanLimitKind): Promise<PlanLimit | null>;

  /**
   * The name of the shop's plan, such as "Free", when it leaves `feature` out; null when it
   * includes it. Asked before connecting, making or turning one on: those already are kept.
   * What is only shown, as true profit is, is asked each time it is shown.
   */
  abstract excludes(shopId: string, feature: PlanFeature): Promise<string | null>;
}

/**
 * Why one is not connected: "The Free plan doesn't include payment gateways: choose a bigger plan
 * to connect one", or made or turned on as `doing` says.
 */
export function planFeatureMessage(
  plan: string,
  what: string,
  doing: string = 'connect one',
): string {
  return `The ${plan} plan doesn't include ${what}: choose a bigger plan to ${doing}`;
}

/** Why one more is refused: "The Free plan has room for 1 location: choose a bigger plan for more". */
export function planLimitMessage(limit: PlanLimit, one: string, many: string): string {
  return (
    `The ${limit.plan} plan has room for ${limit.limit} ${limit.limit === 1 ? one : many}: ` +
    'choose a bigger plan for more'
  );
}
