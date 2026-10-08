import type { Tx } from '@hatti/db';

/**
 * What a shop's plan with Hatti counts and limits (BIL-01, ADR-154): its staff and locations, and
 * its orders a month (ADR-263).
 */
export type PlanLimitKind = 'staff' | 'locations' | 'ordersPerMonth';

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
}

/** Why one more is refused: "The Free plan has room for 1 location: choose a bigger plan for more". */
export function planLimitMessage(limit: PlanLimit, one: string, many: string): string {
  return (
    `The ${limit.plan} plan has room for ${limit.limit} ${limit.limit === 1 ? one : many}: ` +
    'choose a bigger plan for more'
  );
}
