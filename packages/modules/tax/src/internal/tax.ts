import type { InputChecker } from '@hatti/api';
import { allocate, divideRounded, money } from '@hatti/money';

/** Sales tax as a shop sets it, and as orders and checkout's page work it out (ADR-096). */
export const TAX_LIMITS = {
  /** The highest rate, in hundredths of a percent: 50%. */
  maxRate: 5_000,
  /** The categories a shop keeps (ADR-097). */
  categories: 20,
  /** A category's name. */
  categoryName: 60,
} as const;

/** A tax code, Shopify's variants' "Tax code", as categories name them: "REDUCED". */
export const TAX_CODE = /^[A-Za-z0-9._-]{1,40}$/;

/** What receipts, invoices and the API call the tax, in English and Urdu. */
export const SALES_TAX = { en: 'Sales tax', ur: 'سیلز ٹیکس' } as const;

/**
 * A rate of the shop's own for some products (ADR-097): those whose variants' tax code is its
 * code, matched in any letter case.
 */
export interface TaxCategoryValue {
  /** As variants name it: "REDUCED". */
  code: string;
  name: string;
  /** Hundredths of a percent. */
  rate: number;
}

/** A category as the shop gives it: its rate as a percentage, 10 for 10%. */
export interface TaxCategoryInput {
  code: string;
  name: string;
  rate: number;
}

/** A shop's sales tax. */
export interface TaxSettingsRecord {
  /** Hundredths of a percent included in its prices: 1800 is 18%. Null: it charges none. */
  rate: number | null;
  /** Whether delivery charges, and the fee for paying on delivery, include it too. */
  taxDelivery: boolean;
  /** Rates of its own for products whose variants name their codes, in the shop's order. */
  categories: TaxCategoryValue[];
  /**
   * The NTN FBR registered the shop under, which its invoices name (ADR-190): "1234567-8", or a
   * sole trader's CNIC, "35202-1234567-1"; null for none.
   */
  ntn: string | null;
  /** Its sales tax registration number, 13 digits, which makes its invoices tax invoices. */
  strn: string | null;
  /** Null while the shop has set none. */
  updatedAt: Date | null;
}

/** A shop that has set nothing charges no tax. */
export const NO_TAX: TaxSettingsRecord = {
  rate: null,
  taxDelivery: false,
  categories: [],
  ntn: null,
  strn: null,
  updatedAt: null,
};

/** What of a shop's settings works out the tax in an order: its categories are optional. */
export type TaxRates = Pick<TaxSettingsRecord, 'rate' | 'taxDelivery'> & {
  categories?: readonly TaxCategoryValue[];
};

/**
 * The rate a variant's price includes (ADR-097): its tax code's category's, or else the shop's;
 * none for a variant the shop doesn't tax, and none at all while the shop charges none.
 */
export function lineRateOf(
  settings: Omit<TaxRates, 'taxDelivery'>,
  line: { taxable: boolean; taxCode?: string | null },
): number | null {
  if (settings.rate === null || !line.taxable) return null;
  const code = line.taxCode?.toLowerCase();
  const category = code
    ? settings.categories?.find((each) => each.code.toLowerCase() === code)
    : undefined;
  return category?.rate ?? settings.rate;
}

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
  /**
   * Each line's total before discounts, whether its variant's price includes the tax, and its
   * variant's tax code, which may name one of the shop's categories.
   */
  lines: readonly { total: bigint; taxable: boolean; taxCode?: string | null }[];
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
  /** The shop's rate, its charges' too; null when it charges none, and then there is no tax. */
  rate: number | null;
  /**
   * Each line's rate and tax, in the order given: no rate, and no tax, on lines whose price
   * doesn't include it.
   */
  lines: { rate: number | null; tax: bigint }[];
  /** The tax in its delivery charge and fee, where the shop's include it. */
  charges: bigint;
  total: bigint;
}

/**
 * The tax included in an order's `amounts` at the shop's `settings` (ADR-096): on each taxable
 * line, what was paid for it after its share of the discount, at its tax code's category's rate
 * or else the shop's (ADR-097), rounded to the paisa line by line, as Shopify rounds; and on its
 * charges at the shop's rate, where the shop's include it.
 */
export function orderTaxOf(settings: TaxRates, amounts: TaxedAmounts): OrderTax {
  const { rate } = settings;
  if (rate === null) {
    const none = amounts.lines.map(() => ({ rate: null, tax: 0n }));
    return { rate: null, lines: none, charges: 0n, total: 0n };
  }
  const shares = discountShares(
    amounts.lines.map((line) => line.total),
    amounts.discount,
  );
  const lines = amounts.lines.map((line, index) => {
    const lineRate = lineRateOf(settings, line);
    return {
      rate: lineRate,
      tax: lineRate === null ? 0n : includedTax(line.total - shares[index]!, lineRate),
    };
  });
  const charges = settings.taxDelivery ? includedTax(amounts.charges, rate) : 0n;
  return { rate, lines, charges, total: lines.reduce((sum, line) => sum + line.tax, charges) };
}

/**
 * Taxes added up by rate, the lowest first, as receipts and invoices give them a line each: an
 * order's lines' and its charges'. Parts without a rate, and rates whose tax comes to nothing, are
 * left out.
 */
export function taxesByRate(
  parts: readonly { rate: number | null; tax: bigint }[],
): Map<number, bigint> {
  const byRate = new Map<number, bigint>();
  for (const { rate, tax } of parts) {
    if (rate !== null) byRate.set(rate, (byRate.get(rate) ?? 0n) + tax);
  }
  return new Map([...byRate].filter(([, tax]) => tax > 0n).sort(([a], [b]) => a - b));
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
 * The categories `inputs` give, checked: codes as variants name them, each once in any letter
 * case, names, and rates as {@link checkTaxRate} checks them. What is wrong is said at `field` of
 * `check`.
 */
export function checkTaxCategories(
  check: InputChecker,
  field: string[],
  inputs: readonly TaxCategoryInput[],
): TaxCategoryValue[] {
  if (inputs.length > TAX_LIMITS.categories) {
    check.add(field, 'TOO_MANY', `can have at most ${TAX_LIMITS.categories}`);
  }
  const seen = new Set<string>();
  const categories: TaxCategoryValue[] = [];
  inputs.forEach((input, index) => {
    const at = [...field, String(index)];
    const code = input.code.trim();
    if (!TAX_CODE.test(code)) {
      check.addMessage(
        [...at, 'code'],
        'INVALID',
        'Code must be 1 to 40 letters, digits, dots, dashes or underscores, as variants name it, ' +
          'like REDUCED',
      );
    } else if (seen.has(code.toLowerCase())) {
      check.addMessage([...at, 'code'], 'TAKEN', `Another category's code is ${code}`);
    }
    seen.add(code.toLowerCase());
    const name = check.text([...at, 'name'], input.name, {
      required: true,
      max: TAX_LIMITS.categoryName,
    });
    const rate = checkTaxRate(check, [...at, 'rate'], input.rate);
    if (name !== null && rate !== null) categories.push({ code, name, rate });
  });
  return categories;
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

/**
 * An NTN as typed, spaces and dashes as anyone writes them (ADR-190): "1234567-8", seven digits
 * and a check digit, or a sole trader's CNIC, "35202-1234567-1", as FBR now registers them; null
 * after adding what is wrong to `check`.
 */
export function checkNtn(check: InputChecker, field: string[], typed: string): string | null {
  const digits = typed.replace(/[\s-]/g, '');
  if (/^\d{8}$/.test(digits)) return `${digits.slice(0, 7)}-${digits.slice(7)}`;
  if (/^\d{13}$/.test(digits)) {
    return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
  }
  check.addMessage(
    field,
    'INVALID',
    'NTN must be seven digits and a check digit, like 1234567-8, or a CNIC, like 35202-1234567-1',
  );
  return null;
}

/** A sales tax registration number as typed: its 13 digits; null after adding what is wrong. */
export function checkStrn(check: InputChecker, field: string[], typed: string): string | null {
  const digits = typed.replace(/[\s-]/g, '');
  if (/^\d{13}$/.test(digits)) return digits;
  check.addMessage(field, 'INVALID', 'STRN must be 13 digits, like 3277876175852');
  return null;
}
