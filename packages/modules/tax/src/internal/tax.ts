import type { InputChecker } from '@hatti/api';
import { allocate, divideRounded, money } from '@hatti/money';

/** Sales tax as a shop sets it, and as orders and checkout's page work it out (ADR-096). */
export const TAX_LIMITS = {
  /** The highest rate, in hundredths of a percent: 50%. */
  maxRate: 5_000,
} as const;

/** What receipts, invoices and the API call the tax, in English and Urdu. */
export const SALES_TAX = { en: 'Sales tax', ur: 'سیلز ٹیکس' } as const;

/** A shop's sales tax. */
export interface TaxSettingsRecord {
  /** Hundredths of a percent included in its prices: 1800 is 18%. Null: it charges none. */
  rate: number | null;
  /** Whether delivery charges, and the fee for paying on delivery, include it too. */
  taxDelivery: boolean;
  /** Null while the shop has set none. */
  updatedAt: Date | null;
}

/** A shop that has set nothing charges no tax. */
export const NO_TAX: TaxSettingsRecord = { rate: null, taxDelivery: false, updatedAt: null };

/**
 * The tax included in `amount`, in minor units, at `rate` hundredths of a percent: the amount less
 * what it would be without the tax, amount × rate ÷ (100% + rate), rounded half up.
 */
export function includedTax(amount: bigint, rate: number): bigint {
  if (amount <= 0n) return 0n;
  return divideRounded(amount * BigInt(rate), 10_000n + BigInt(rate), 'half-up');
}

/** An order's amounts, in minor units, as the tax in it is worked out from them. */
export interface TaxedAmounts {
  /** Each line's total before discounts, and whether its variant's price includes the tax. */
  lines: readonly { total: bigint; taxable: boolean }[];
  /**
   * Off the items: a code's, staff's and paying by transfer's, shared across the lines in
   * proportion to their totals, so that each line's tax is on what was paid for it.
   */
  discount: bigint;
  /** Its delivery charge and its fee for paying on delivery. */
  charges: bigint;
}

/** The tax included in an order, as it is placed. */
export interface OrderTax {
  /** The shop's rate; null when it charges none, and then there is no tax. */
  rate: number | null;
  /** Each line's tax, in the order given; zero on lines whose price doesn't include it. */
  lines: bigint[];
  /** The tax in its delivery charge and fee, where the shop's include it. */
  charges: bigint;
  total: bigint;
}

/**
 * The tax included in an order's `amounts` at the shop's `settings` (ADR-096): on each taxable
 * line, what was paid for it after its share of the discount, rounded to the paisa line by line,
 * as Shopify rounds; and on its charges, where the shop's include it.
 */
export function orderTaxOf(
  settings: Pick<TaxSettingsRecord, 'rate' | 'taxDelivery'>,
  amounts: TaxedAmounts,
): OrderTax {
  const { rate } = settings;
  if (rate === null) {
    return { rate: null, lines: amounts.lines.map(() => 0n), charges: 0n, total: 0n };
  }
  const shares = discountShares(
    amounts.lines.map((line) => line.total),
    amounts.discount,
  );
  const lines = amounts.lines.map((line, index) =>
    line.taxable ? includedTax(line.total - shares[index]!, rate) : 0n,
  );
  const charges = settings.taxDelivery ? includedTax(amounts.charges, rate) : 0n;
  return { rate, lines, charges, total: lines.reduce((sum, tax) => sum + tax, charges) };
}

/** `discount` shared across lines of `totals` in proportion, by the largest remainder. */
function discountShares(totals: readonly bigint[], discount: bigint): bigint[] {
  if (discount <= 0n || totals.every((total) => total <= 0n)) return totals.map(() => 0n);
  // The parts are minor units of whatever currency: a share has no currency of its own.
  return allocate(money(discount, 'PKR'), totals).map((part) => part.amount);
}

/** A rate as people read it: "18%", "17.5%". */
export function ratePercent(rate: number): string {
  return `${rate / 100}%`;
}

/**
 * "Sales tax 18% (included)", in English and Urdu: the tax a total includes at `rate`, as
 * receipts, invoices and checkout's page say it.
 */
export function taxIncludedWords(rate: number): { en: string; ur: string } {
  return {
    en: `${SALES_TAX.en} ${ratePercent(rate)} (included)`,
    ur: `${SALES_TAX.ur} ${ratePercent(rate)} (شامل)`,
  };
}

/**
 * The rate in `percentage`, 18 for 18%, in hundredths of a percent; null after saying at `field`
 * of `check` what is wrong with it.
 */
export function checkTaxRate(
  check: InputChecker,
  field: string[],
  percentage: number,
): number | null {
  const rate = Math.round(percentage * 100);
  if (
    !Number.isFinite(percentage) ||
    rate < 1 ||
    rate > TAX_LIMITS.maxRate ||
    Math.abs(percentage * 100 - rate) > 1e-6
  ) {
    check.addMessage(
      field,
      'INVALID',
      `Rate must be a percentage from 0.01 to ${TAX_LIMITS.maxRate / 100}, with two decimals at ` +
        'most, like 18 or 17.5',
    );
    return null;
  }
  return rate;
}
