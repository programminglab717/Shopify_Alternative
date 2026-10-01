import { divideRounded, formatMoney, money, type CurrencyCode } from '@hatti/money';
import type { DiscountCodeRecord, DiscountStatusValue } from './records.js';

/** How codes are written: letters, digits, hyphens and underscores, up to 64. */
export const DISCOUNT_CODE = /^[A-Za-z0-9_-]{1,64}$/;

/** A shop keeps at most this many codes. */
export const DISCOUNT_CODE_LIMIT = 10_000;

/** A code as the shopper typed it, trimmed; null when no code could be written so. */
export function typedCode(text: string): string | null {
  const code = text.trim();
  return DISCOUNT_CODE.test(code) ? code : null;
}

/** Whether a code works at `at`, by its dates alone. */
export function discountStatus(
  code: Pick<DiscountCodeRecord, 'startsAt' | 'endsAt'>,
  at: Date = new Date(),
): DiscountStatusValue {
  if (code.startsAt > at) return 'scheduled';
  if (code.endsAt !== null && code.endsAt <= at) return 'expired';
  return 'active';
}

/** What a code takes off an order: from its items, and from what delivery costs. */
export interface DiscountAmounts {
  items: bigint;
  shipping: bigint;
}

/**
 * What `code` takes off an order whose items come to `subtotal` and whose delivery costs
 * `shipping`, in minor units: a percentage of the items, rounded half up; an amount off them, no
 * more than they come to; or the delivery charge. Whether the code may be used is for the caller.
 */
export function discountOf(
  code: Pick<DiscountCodeRecord, 'kind' | 'percentageBps' | 'amount'>,
  order: { subtotal: bigint; shipping: bigint },
): DiscountAmounts {
  switch (code.kind) {
    case 'percentage':
      return {
        items: divideRounded(order.subtotal * BigInt(code.percentageBps ?? 0), 10_000n, 'half-up'),
        shipping: 0n,
      };
    case 'fixed_amount': {
      const amount = code.amount ?? 0n;
      return { items: amount < order.subtotal ? amount : order.subtotal, shipping: 0n };
    }
    case 'free_shipping':
      return { items: 0n, shipping: order.shipping };
  }
}

/** "10.5%" from hundredths of a percent. */
export function percentText(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const hundredths = bps % 100;
  if (hundredths === 0) return `${whole}%`;
  return `${whole}.${String(hundredths).padStart(2, '0').replace(/0$/, '')}%`;
}

/**
 * What a code gives, in a line for staff: "10% off orders of Rs 3,000 or more; one use a
 * customer".
 */
export function discountSummary(code: DiscountCodeRecord, currency: CurrencyCode): string {
  const rs = (amount: bigint) => formatMoney(money(amount, currency));
  const minimum = code.minimumSubtotal === null ? null : rs(code.minimumSubtotal);
  const what =
    code.kind === 'percentage'
      ? `${percentText(code.percentageBps ?? 0)} off`
      : code.kind === 'fixed_amount'
        ? `${rs(code.amount ?? 0n)} off`
        : 'Free delivery';
  const which =
    code.kind === 'free_shipping'
      ? minimum
        ? ` on orders of ${minimum} or more`
        : ''
      : minimum
        ? ` orders of ${minimum} or more`
        : ' the order';
  const limits = [
    code.oncePerCustomer ? 'one use a customer' : null,
    code.usageLimit === null
      ? null
      : `${code.usageLimit.toLocaleString('en')} ${code.usageLimit === 1 ? 'use' : 'uses'} in all`,
  ].filter((limit) => limit !== null);
  return `${what}${which}${limits.length > 0 ? `; ${limits.join(', ')}` : ''}`;
}
