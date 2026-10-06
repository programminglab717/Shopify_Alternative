import type { Logger } from '@hatti/logger';
import { describe, expect, it, vi } from 'vitest';
import { PaymentInquiries } from './payment-inquiries.js';

describe('Payments asked after (ADR-208)', () => {
  it("asks after each shop's payments due, one shop's failure not the others'", async () => {
    const at = new Date('2026-10-06T10:00:00Z');
    const payments = {
      shopsWithInquiriesDue: vi.fn(async () => ['shop-a', 'shop-b', 'shop-c']),
      inquireDue: vi.fn(async (shopId: string) => {
        if (shopId === 'shop-b') throw new Error('database down');
        return shopId === 'shop-a' ? { asked: 2, paid: 1 } : { asked: 1, paid: 0 };
      }),
    };
    const warned: unknown[] = [];
    const logger = { info: vi.fn(), warn: (obj: unknown) => warned.push(obj) } as unknown as Logger;
    const sweeps = new PaymentInquiries(payments, logger);
    expect(await sweeps.sweep(at)).toEqual({ asked: 3, paid: 1 });
    expect(payments.shopsWithInquiriesDue).toHaveBeenCalledWith(at);
    expect(payments.inquireDue.mock.calls.map(([shopId]) => shopId)).toEqual([
      'shop-a',
      'shop-b',
      'shop-c',
    ]);
    expect(warned).toEqual([expect.objectContaining({ shopId: 'shop-b' })]);
  });
});
