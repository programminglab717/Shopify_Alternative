import type { AbandonedCheckoutService } from '@hatti/checkout/public';
import { describe, expect, it, vi } from 'vitest';
import { CheckoutReminders } from './checkout-reminders.js';

describe("The worker's checkout reminders (CHK-12)", () => {
  it('reminds, then offers the code, at the same time (ADR-393, ADR-426)', async () => {
    const remindDue = vi.fn<(at?: Date) => Promise<number>>().mockResolvedValue(2);
    const offerDue = vi.fn<(at?: Date) => Promise<number>>().mockResolvedValue(1);
    const reminders = new CheckoutReminders({
      remindDue,
      offerDue,
    } as unknown as AbandonedCheckoutService);
    const at = new Date('2026-10-16T09:00:00Z');
    expect(await reminders.sweep(at)).toEqual({ reminded: 2, offered: 1 });
    expect(remindDue).toHaveBeenCalledWith(at, expect.any(Function));
    expect(offerDue).toHaveBeenCalledWith(at, expect.any(Function));
  });
});
