import { describe, expect, it, vi } from 'vitest';
import { CommentAddressRetention, type ForgetAddresses } from './comment-retention.js';

describe("Comments' addresses forgotten by the worker 90 days after they were posted (ADR-748)", () => {
  it('forgets a batch at a time until one comes back short, as of the sweep', async () => {
    const forget = vi.fn<ForgetAddresses>();
    forget.mockResolvedValueOnce(1_000).mockResolvedValueOnce(7);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const retention = new CommentAddressRetention(forget, logger as never);
    const at = new Date('2026-10-23T10:00:00Z');

    expect(await retention.sweep(at)).toBe(1_007);
    expect(forget.mock.calls).toEqual([
      [at, 1_000],
      [at, 1_000],
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      { cleared: 1_007 },
      'comments past ninety days forgot their addresses',
    );
  });

  it('says nothing when no comment was old enough', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const retention = new CommentAddressRetention(
      { forgetAddresses: async () => 0 },
      logger as never,
    );
    expect(await retention.sweep()).toBe(0);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
