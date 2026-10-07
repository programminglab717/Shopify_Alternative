import type { DomainCheck, DomainService } from '@hatti/online-store/public';
import { describe, expect, it, vi } from 'vitest';
import { DomainChecks } from './domain-checks.js';

describe("Shops' domains checked again in the worker (ADR-262)", () => {
  const shopId = '0190a1b2-0000-7000-8000-000000000001';
  const due = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({ shopId, id: `domain-${from + index}` }));
  const none = { pointed: 0, unpointed: 0, disconnected: 0, unanswered: 0, skipped: 0 };

  it('checks those due a batch at a time until one comes back short, one failure not the others', async () => {
    const domainsToCheck = vi
      .fn<(limit: number) => Promise<{ shopId: string; id: string }[]>>()
      .mockResolvedValueOnce(due(0, 100))
      .mockResolvedValueOnce(due(100, 3))
      .mockResolvedValue([]);
    const trouble = new Error('connection terminated');
    const recheck = vi.fn<(shopId: string, id: string) => Promise<DomainCheck>>(async (_, id) => {
      if (id === 'domain-1') return 'unpointed';
      if (id === 'domain-2') return 'disconnected';
      if (id === 'domain-3') throw trouble;
      return id === 'domain-4' ? 'unanswered' : 'pointed';
    });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const checks = new DomainChecks(
      { domainsToCheck, recheck } as unknown as DomainService,
      logger as never,
    );
    expect(await checks.sweep()).toEqual({
      ...none,
      pointed: 99,
      unpointed: 1,
      disconnected: 1,
      unanswered: 1,
    });
    expect(domainsToCheck.mock.calls).toEqual([[100], [100]]);
    expect(recheck).toHaveBeenCalledTimes(103);
    expect(logger.info.mock.calls).toEqual([
      [{ shopId, domainId: 'domain-1', check: 'unpointed' }, 'domain pointed elsewhere'],
      [{ shopId, domainId: 'domain-2', check: 'disconnected' }, 'domain pointed elsewhere'],
    ]);
    expect(logger.warn.mock.calls).toEqual([
      [{ err: trouble, shopId, domainId: 'domain-3' }, 'domain not checked again'],
    ]);
    // None due: nothing asked.
    expect(await checks.sweep()).toEqual(none);
  });

  it('stops after ten batches in a sweep, the rest left to the next', async () => {
    const domainsToCheck = vi.fn(async () => due(0, 100));
    const recheck = vi.fn(async (): Promise<DomainCheck> => 'pointed');
    const checks = new DomainChecks({ domainsToCheck, recheck } as unknown as DomainService);
    expect(await checks.sweep()).toEqual({ ...none, pointed: 1_000 });
    expect(domainsToCheck).toHaveBeenCalledTimes(10);
  });
});
