import type { CheckoutExpiry, ExpiredCounts } from '@hatti/checkout/public';
import { describe, expect, it, vi } from 'vitest';
import { ExpiredCheckouts } from './expired-checkouts.js';

describe('Expired carts and checkouts in the worker (ADR-230)', () => {
  it('deletes a batch at a time until one comes back short, at the time asked, logging what went and what failed', async () => {
    type Failed = (shopId: string, error: unknown) => void;
    const deleteExpired =
      vi.fn<(at?: Date, limit?: number, failed?: Failed) => Promise<ExpiredCounts>>();
    const trouble = new Error('statement timeout');
    deleteExpired
      .mockImplementationOnce(async (_at, _limit, failed) => {
        // One shop's failure is logged, and the rest go on.
        failed!('0190a1b2-0000-7000-8000-000000000001', trouble);
        return { checkouts: 12, carts: 1_000, proofs: 3 };
      })
      .mockResolvedValueOnce({ checkouts: 0, carts: 1_000, proofs: 0 })
      .mockResolvedValueOnce({ checkouts: 0, carts: 41, proofs: 0 })
      .mockResolvedValueOnce({ checkouts: 0, carts: 0, proofs: 0 });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const sweeps = new ExpiredCheckouts(
      { deleteExpired } as unknown as CheckoutExpiry,
      logger as never,
    );
    const at = new Date('2027-03-01T09:00:00Z');
    expect(await sweeps.sweep(at)).toEqual({ checkouts: 12, carts: 2_041, proofs: 3 });
    expect(deleteExpired.mock.calls.map(([when, limit]) => [when, limit])).toEqual([
      [at, 1_000],
      [at, 1_000],
      [at, 1_000],
    ]);
    expect(await sweeps.sweep(at)).toEqual({ checkouts: 0, carts: 0, proofs: 0 });
    expect(deleteExpired).toHaveBeenCalledTimes(4);
    expect(logger.info.mock.calls).toEqual([
      [{ checkouts: 12, carts: 2_041, proofs: 3 }, 'expired carts and checkouts deleted'],
    ]);
    expect(logger.warn.mock.calls).toEqual([
      [
        { err: trouble, shopId: '0190a1b2-0000-7000-8000-000000000001' },
        'expired carts and checkouts not deleted',
      ],
    ]);
  });
});
