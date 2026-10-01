import type { InputChecker } from '@hatti/api';
import { divideRounded, exponentOf, money, toMajorString, type CurrencyCode } from '@hatti/money';

/**
 * What a shop takes off orders paid by bank transfer, as its prepaid incentive (CHK-08, ADR-077):
 * a percentage of the items, up to a cap if it sets one, or an amount off them. Checkout takes it
 * off the items after any discount code.
 */
export type TransferDiscountValue =
  /** Hundredths of a percent: 500 is 5%. */
  | { kind: 'percentage'; percentageBps: number; cap: bigint | null }
  | { kind: 'fixed_amount'; amount: bigint };

/** A percentage, with a cap or not, or an amount: one of the two. */
export interface TransferDiscountInput {
  /** 0.01 to 50, two decimals at most: 5 is 5%. */
  percentage?: number | null;
  /** Decimal, in major units: the most a percentage takes off an order, "500"; blank for none. */
  cap?: string | null;
  /** Decimal, in major units: "150". */
  amount?: string | null;
}

/** The most a percentage may take off, in hundredths of a percent: half of what the items cost. */
export const TRANSFER_DISCOUNT_MAX_BPS = 5_000;

/**
 * What `discount` takes off items coming to `items`, in minor units of `currency`: its percentage
 * of them, rounded half up to a whole rupee so that what is transferred stays whole, no more than
 * its cap; or its amount, no more than they come to.
 */
export function transferDiscountOf(
  discount: TransferDiscountValue | null,
  items: bigint,
  currency: CurrencyCode,
): bigint {
  if (!discount || items <= 0n) return 0n;
  if (discount.kind === 'fixed_amount') return discount.amount < items ? discount.amount : items;
  const unit = 10n ** BigInt(exponentOf(currency));
  const off =
    divideRounded(items * BigInt(discount.percentageBps), 10_000n * unit, 'half-up') * unit;
  const capped = discount.cap !== null && off > discount.cap ? discount.cap : off;
  return capped < items ? capped : items;
}

/**
 * The discount `input` gives, checked; null after adding what is wrong to `check`, at `field`.
 */
export function checkTransferDiscount(
  check: InputChecker,
  field: string[],
  input: TransferDiscountInput,
  currency: CurrencyCode,
): TransferDiscountValue | null {
  const errorsBefore = check.errors.length;
  const percentage = input.percentage ?? null;
  const amountGiven = (input.amount?.trim() ?? '') !== '';
  const capGiven = (input.cap?.trim() ?? '') !== '';
  if (percentage !== null && amountGiven) {
    check.addMessage(
      [...field, 'amount'],
      'INVALID',
      'Take a percentage or an amount off, not both',
    );
    return null;
  }
  if (percentage === null && !amountGiven) {
    check.addMessage(
      [...field, 'percentage'],
      'BLANK',
      'Say what paying by transfer takes off: a percentage or an amount',
    );
    return null;
  }
  if (percentage === null) {
    if (capGiven) {
      check.addMessage(
        [...field, 'cap'],
        'INVALID',
        'A cap is for a percentage: an amount is what it takes off',
      );
    }
    const amount = check.price([...field, 'amount'], input.amount, currency);
    if (amount === 0n) check.add([...field, 'amount'], 'INVALID', 'must be more than zero');
    if (check.errors.length > errorsBefore || amount === null) return null;
    return { kind: 'fixed_amount', amount };
  }
  const bps = Math.round(percentage * 100);
  if (!(bps >= 1 && bps <= TRANSFER_DISCOUNT_MAX_BPS) || Math.abs(percentage * 100 - bps) > 1e-6) {
    check.addMessage(
      [...field, 'percentage'],
      'INVALID',
      `Percentage must be from 0.01 to ${TRANSFER_DISCOUNT_MAX_BPS / 100}, with two decimals ` +
        'at most, like 5 or 2.5',
    );
  }
  const cap = check.price([...field, 'cap'], input.cap, currency);
  if (cap === 0n) check.add([...field, 'cap'], 'INVALID', 'must be more than zero');
  if (check.errors.length > errorsBefore) return null;
  return { kind: 'percentage', percentageBps: bps, cap };
}

/** Whether two discounts take the same off every order. */
export function sameTransferDiscount(
  a: TransferDiscountValue | null,
  b: TransferDiscountValue | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'fixed_amount') return b.kind === 'fixed_amount' && a.amount === b.amount;
  return b.kind === 'percentage' && a.percentageBps === b.percentageBps && a.cap === b.cap;
}

/** A discount as the API has it, for the audit log: a percent, and amounts in major units. */
export function auditedTransferDiscount(
  discount: TransferDiscountValue | null,
  currency: CurrencyCode,
) {
  if (!discount) return null;
  const major = (amount: bigint) => toMajorString(money(amount, currency));
  return discount.kind === 'percentage'
    ? {
        percentage: discount.percentageBps / 100,
        cap: discount.cap === null ? null : major(discount.cap),
      }
    : { amount: major(discount.amount) };
}
