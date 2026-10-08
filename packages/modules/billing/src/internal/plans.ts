import type { CurrencyCode } from '@hatti/money';

// What shops pay Hatti (BIL-01, ADR-154), as docs/product/03-pricing-and-business-model.md
// proposes it: plans priced in rupees, by the month or by the year, a year being ten months'
// price, with the staff, locations and orders a month each allows, and whether it includes a
// domain of the shop's own and payment gateways. Enterprise is agreed with each shop, not here.

export const PLAN_CODES = ['free', 'starter', 'growth', 'pro'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const BILLING_INTERVALS = ['monthly', 'yearly'] as const;
export type BillingIntervalValue = (typeof BILLING_INTERVALS)[number];

/** Shops pay Hatti in rupees. */
export const BILLING_CURRENCY: CurrencyCode = 'PKR';

export interface Plan {
  code: PlanCode;
  /** "Growth". */
  name: string;
  /** In paisa: for a month, and for a year. Free's are nothing. */
  prices: Readonly<Record<BillingIntervalValue, bigint>>;
  /** Members of staff, the owner among them, and locations it has room for. */
  staff: number;
  locations: number;
  /**
   * Orders a month it takes before those past them are locked until the shop's plan has room for
   * them (ADR-263); null for any number.
   */
  ordersPerMonth: number | null;
  /** Whether the shop may connect a domain of its own, and accounts with payment gateways (ADR-264). */
  customDomains: boolean;
  onlineGateways: boolean;
}

export const PLANS: Readonly<Record<PlanCode, Plan>> = {
  free: {
    code: 'free',
    name: 'Free',
    prices: { monthly: 0n, yearly: 0n },
    staff: 1,
    locations: 1,
    ordersPerMonth: 50,
    customDomains: false,
    onlineGateways: false,
  },
  starter: {
    code: 'starter',
    name: 'Starter',
    prices: { monthly: 2_499_00n, yearly: 24_990_00n },
    staff: 3,
    locations: 1,
    ordersPerMonth: null,
    customDomains: true,
    onlineGateways: true,
  },
  growth: {
    code: 'growth',
    name: 'Growth',
    prices: { monthly: 6_999_00n, yearly: 69_990_00n },
    staff: 8,
    locations: 3,
    ordersPerMonth: null,
    customDomains: true,
    onlineGateways: true,
  },
  pro: {
    code: 'pro',
    name: 'Pro',
    prices: { monthly: 17_999_00n, yearly: 179_990_00n },
    staff: 20,
    locations: 10,
    ordersPerMonth: null,
    customDomains: true,
    onlineGateways: true,
  },
};

export const BILLING_LIMITS = {
  /** A period's renewal invoice is made this many days before it ends. */
  renewalDays: 7,
  /** A plan whose period ended unpaid stays this many days before the shop is on Free. */
  graceDays: 7,
  /** A payment's page is offered again for this long, rather than a new one started. */
  reuseMinutes: 30,
  /** Payments an invoice starts at most, those the gateway refused included. */
  paymentsPerInvoice: 20,
  /** Invoices a list shows at most. */
  invoices: 50,
} as const;

/** What a plan at an interval comes to a month, to tell a bigger plan from a smaller one. */
export function monthlyValue(plan: PlanCode, interval: BillingIntervalValue | null): bigint {
  const prices = PLANS[plan].prices;
  return interval === 'yearly' ? prices.yearly / 12n : prices.monthly;
}

/**
 * Whether moving from `current` to `target` begins at once, paid for now less what is left of
 * the current period: from Free, to a plan worth more a month, or from paying monthly to yearly
 * for the same plan. Anything else waits for the current period to end. A yearly plan stays
 * yearly until its year ends, so what is left of it is always less than what replaces it.
 */
export function beginsAtOnce(
  current: { plan: PlanCode; interval: BillingIntervalValue | null },
  target: { plan: PlanCode; interval: BillingIntervalValue },
): boolean {
  if (current.plan === 'free') return true;
  if (current.interval === 'yearly' && target.interval === 'monthly') return false;
  if (target.plan === current.plan) {
    return current.interval === 'monthly' && target.interval === 'yearly';
  }
  return monthlyValue(target.plan, target.interval) > monthlyValue(current.plan, current.interval);
}

/** When a period begun at `start` ends: a month or a year on, on the same day or the month's last. */
export function periodEndOf(start: Date, interval: BillingIntervalValue): Date {
  const months = interval === 'yearly' ? 12 : 1;
  const end = new Date(start.getTime());
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, last));
  return end;
}

/** An invoice's number as Hatti prints it: "HB-000123". */
export function invoiceName(number: number | bigint): string {
  return `HB-${String(number).padStart(6, '0')}`;
}
