import type { StoreCreditService } from '@hatti/customers/public';
import { describe, expect, it, vi } from 'vitest';
import { StoreCreditExpiry } from './store-credit-expiry.js';

describe('Store credit expiry in the worker (ADR-184)', () => {
  it('records what expired at the time asked, and says so only when something did', async () => {
    const expireDue = vi.fn<(at?: Date) => Promise<number>>();
    expireDue.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const sweeps = new StoreCreditExpiry(
      { expireDue } as unknown as StoreCreditService,
      logger as never,
    );
    const at = new Date('2027-03-01T09:00:00Z');
    expect(await sweeps.sweep(at)).toBe(3);
    expect(await sweeps.sweep(at)).toBe(0);
    expect(expireDue).toHaveBeenCalledWith(at);
    expect(logger.info.mock.calls).toEqual([[{ expired: 3 }, 'store credit expired']]);
  });
});
