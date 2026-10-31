import { describe, expect, it, vi } from 'vitest';
import {
  OutboxRetention,
  type MaintainPartitions,
  type PurgePublished,
} from './outbox-retention.js';

describe('Outbox events deleted by the worker seven days after they were published (ADR-746)', () => {
  it('deletes a batch at a time until one comes back short, from seven days before the sweep', async () => {
    const purge = vi.fn<PurgePublished>();
    purge.mockResolvedValueOnce(5_000).mockResolvedValueOnce(5_000).mockResolvedValueOnce(12);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const retention = new OutboxRetention(purge, logger as never);

    expect(await retention.sweep(new Date('2026-10-23T10:00:00Z'))).toBe(10_012);
    expect(purge).toHaveBeenCalledTimes(3);
    expect(purge.mock.calls[0]).toEqual([new Date('2026-10-16T10:00:00Z'), 5_000]);
    expect(logger.info).toHaveBeenCalledWith(
      { deleted: 10_012 },
      'outbox events past seven days deleted',
    );
  });

  it('says nothing when nothing was old enough', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const retention = new OutboxRetention(async () => 0, logger as never);
    expect(await retention.sweep()).toBe(0);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("keeps the outbox's daily partitions first, the cut-off seven days before the sweep (ADR-988)", async () => {
    const calls: string[] = [];
    const partitions = vi.fn<MaintainPartitions>(async () => {
      calls.push('partitions');
      return { made: 1, dropped: 2 };
    });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const retention = new OutboxRetention(
      async () => {
        calls.push('purge');
        return 0;
      },
      logger as never,
      partitions,
    );
    const at = new Date('2026-10-23T10:00:00Z');
    await retention.sweep(at);
    expect(partitions).toHaveBeenCalledWith(at, new Date('2026-10-16T10:00:00Z'));
    expect(calls).toEqual(['partitions', 'purge']);
    expect(logger.info).toHaveBeenCalledWith(
      { made: 1, dropped: 2 },
      'outbox daily partitions made and dropped',
    );
  });
});
