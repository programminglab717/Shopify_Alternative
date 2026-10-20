import { describe, expect, it, vi } from 'vitest';
import { LapsedShifts } from './lapsed-shifts.js';

describe('Lapsed shifts at the Confirmation Desk in the worker (ADR-666)', () => {
  it('hands over what waits on them at the time asked, saying so only when something went', async () => {
    const handOverAllLapsed = vi.fn<(at?: Date) => Promise<number>>();
    handOverAllLapsed.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const sweeps = new LapsedShifts({ handOverAllLapsed }, logger as never);
    const at = new Date('2027-03-01T09:00:00Z');
    expect(await sweeps.sweep(at)).toBe(3);
    expect(await sweeps.sweep(at)).toBe(0);
    expect(handOverAllLapsed).toHaveBeenCalledWith(at);
    expect(logger.info.mock.calls).toEqual([
      [{ handed: 3 }, 'orders handed over from lapsed shifts'],
    ]);
  });
});
