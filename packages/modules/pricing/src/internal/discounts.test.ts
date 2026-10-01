import { describe, expect, it } from 'vitest';
import {
  discountOf,
  discountStatus,
  discountSummary,
  percentText,
  typedCode,
} from './discounts.js';
import type { DiscountCodeRecord } from './records.js';

const CODE: DiscountCodeRecord = {
  id: '01a0f3b1-9685-7065-988d-604298214e34',
  code: 'EID25',
  title: 'EID25',
  kind: 'percentage',
  percentageBps: 2_500,
  amount: null,
  minimumSubtotal: null,
  startsAt: new Date('2026-10-01T00:00:00+05:00'),
  endsAt: null,
  usageLimit: null,
  oncePerCustomer: false,
  used: 0,
  version: 1,
  createdAt: new Date('2026-10-01T00:00:00+05:00'),
  updatedAt: new Date('2026-10-01T00:00:00+05:00'),
};

describe('Discount codes', () => {
  it('reads a code as shoppers type it', () => {
    expect(typedCode('  eid25 ')).toBe('eid25');
    expect(typedCode('SAVE-500_X')).toBe('SAVE-500_X');
    for (const text of ['', ' ', 'EID 25', 'عید', 'a'.repeat(65), 'EID25!']) {
      expect(typedCode(text), text).toBeNull();
    }
  });

  it('works between its dates', () => {
    const at = (iso: string) => new Date(iso);
    expect(discountStatus(CODE, at('2026-09-30T23:59:59+05:00'))).toBe('scheduled');
    expect(discountStatus(CODE, at('2026-10-01T00:00:00+05:00'))).toBe('active');
    const ending = { ...CODE, endsAt: at('2026-10-07T00:00:00+05:00') };
    expect(discountStatus(ending, at('2026-10-06T23:59:59+05:00'))).toBe('active');
    expect(discountStatus(ending, at('2026-10-07T00:00:00+05:00'))).toBe('expired');
  });

  it('takes a percentage of the items, an amount off them, or the delivery charge', () => {
    const order = { subtotal: 4_998_00n, shipping: 250_00n };
    expect(discountOf(CODE, order)).toEqual({ items: 1_249_50n, shipping: 0n });
    // Rounded half up to the paisa: 12.5% of Rs 9.99 is Rs 1.24875.
    const eighth = { ...CODE, percentageBps: 1_250 };
    expect(discountOf(eighth, { subtotal: 999n, shipping: 0n }).items).toBe(125n);
    expect(discountOf({ ...CODE, percentageBps: 10_000 }, order).items).toBe(4_998_00n);
    const fixed = { ...CODE, kind: 'fixed_amount' as const, percentageBps: null, amount: 500_00n };
    expect(discountOf(fixed, order)).toEqual({ items: 500_00n, shipping: 0n });
    // Never more than the items come to.
    expect(discountOf(fixed, { subtotal: 300_00n, shipping: 250_00n }).items).toBe(300_00n);
    const free = { ...CODE, kind: 'free_shipping' as const, percentageBps: null };
    expect(discountOf(free, order)).toEqual({ items: 0n, shipping: 250_00n });
  });

  it('says what a code gives, in a line', () => {
    expect(percentText(2_500)).toBe('25%');
    expect(percentText(1_050)).toBe('10.5%');
    expect(percentText(1_005)).toBe('10.05%');
    expect(percentText(1)).toBe('0.01%');
    expect(discountSummary(CODE, 'PKR')).toBe('25% off the order');
    expect(
      discountSummary(
        {
          ...CODE,
          kind: 'fixed_amount',
          percentageBps: null,
          amount: 500_00n,
          minimumSubtotal: 3_000_00n,
          oncePerCustomer: true,
          usageLimit: 1_000,
        },
        'PKR',
      ),
    ).toBe('Rs 500 off orders of Rs 3,000 or more; one use a customer, 1,000 uses in all');
    const free = { ...CODE, kind: 'free_shipping' as const, percentageBps: null };
    expect(discountSummary(free, 'PKR')).toBe('Free delivery');
    expect(discountSummary({ ...free, minimumSubtotal: 2_000_00n, usageLimit: 1 }, 'PKR')).toBe(
      'Free delivery on orders of Rs 2,000 or more; 1 use in all',
    );
  });
});
