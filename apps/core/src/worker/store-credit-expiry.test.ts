import type { StoreCreditService } from '@hatti/customers/public';
import { describe, expect, it, vi } from 'vitest';
import { StoreCreditExpiry } from './store-credit-expiry.js';

describe('Store credit expiry in the worker (ADR-184, ADR-192)', () => {
  it('records what expired, and reminds of what expires soon, at the time asked, saying so only when something did', async () => {
    const expireDue = vi.fn<(at?: Date) => Promise<number>>();
    expireDue.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    const remindDue = vi.fn<(at?: Date) => Promise<number>>();
    remindDue.mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const sweeps = new StoreCreditExpiry(
      { expireDue, remindDue } as unknown as StoreCreditService,
      logger as never,
    );
    const at = new Date('2027-03-01T09:00:00Z');
    expect(await sweeps.sweep(at)).toEqual({ expired: 3, reminded: 0 });
    expect(await sweeps.sweep(at)).toEqual({ expired: 0, reminded: 2 });
    expect(expireDue).toHaveBeenCalledWith(at);
    expect(remindDue).toHaveBeenCalledWith(at);
    expect(logger.info.mock.calls).toEqual([
      [{ expired: 3 }, 'store credit expired'],
      [{ reminded: 2 }, 'store credit expiring: customers reminded'],
    ]);
  });
});
