import type { AccountDataExpiry } from '@hatti/checkout/public';
import { describe, expect, it, vi } from 'vitest';
import { AccountDataFiles } from './account-data-files.js';

describe("Shoppers' files of their own data in the worker (ADR-572)", () => {
  it('lets go of a batch at a time until one comes back short, logging what went and what failed', async () => {
    type Failed = (shopId: string, error: unknown) => void;
    const deleteExpired = vi.fn<(at?: Date, limit?: number, failed?: Failed) => Promise<number>>();
    deleteExpired.mockResolvedValueOnce(2).mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const sweeps = new AccountDataFiles(
      { deleteExpired } as unknown as AccountDataExpiry,
      logger as never,
    );
    const at = new Date('2027-03-01T09:00:00Z');
    expect(await sweeps.sweep(at, 2)).toBe(3);
    expect(deleteExpired.mock.calls.map(([when, limit]) => [when, limit])).toEqual([
      [at, 2],
      [at, 2],
    ]);
    expect(logger.info.mock.calls).toEqual([
      [{ deleted: 3 }, "shoppers' files of their data let go"],
    ]);
    expect(await sweeps.sweep(at, 2)).toBe(0);
    expect(logger.info).toHaveBeenCalledTimes(1);

    // A file storage could not delete waits for the next sweep, and the sweep stops there.
    const trouble = new Error('storage unavailable');
    deleteExpired.mockImplementationOnce(async (_at, _limit, failed) => {
      failed!('0190a1b2-0000-7000-8000-000000000001', trouble);
      return 1;
    });
    expect(await sweeps.sweep(at, 2)).toBe(1);
    expect(deleteExpired).toHaveBeenCalledTimes(4);
    expect(logger.warn.mock.calls).toEqual([
      [
        { err: trouble, shopId: '0190a1b2-0000-7000-8000-000000000001' },
        "shoppers' files of their data not let go",
      ],
    ]);
  });
});
