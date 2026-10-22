import { describe, expect, it, vi } from 'vitest';
import type { ClosedShopData, Purged } from '../closed-shops.js';
import { ClosedShopPurges } from './closed-shop-purges.js';

describe("The worker's purges of closed shops' data (ADR-741)", () => {
  const closedAt = new Date('2026-07-01T10:00:00Z');
  const at = new Date('2026-10-01T10:00:00Z');

  it('purges each shop due, logs one blocked or failing, and goes on to the next', async () => {
    const data = {
      due: vi.fn(async () => [
        { id: 'a', name: 'A', closedAt },
        { id: 'b', name: 'B', closedAt },
        { id: 'c', name: 'C', closedAt },
        { id: 'd', name: 'D', closedAt },
      ]),
      purge: vi.fn<ClosedShopData['purge']>(async (id): Promise<Purged | null> => {
        if (id === 'b') return { deleted: {}, blocked: ['catalog.products'] };
        if (id === 'c') throw new Error('connection lost');
        if (id === 'd') return null;
        return { deleted: { 'catalog.products': 3 }, blocked: [] };
      }),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const purges = new ClosedShopPurges(data, logger as never);
    expect(await purges.sweep(at)).toEqual(['a']);
    expect(data.due).toHaveBeenCalledWith(at, 5);
    expect(data.purge.mock.calls).toEqual([
      ['a', at],
      ['b', at],
      ['c', at],
      ['d', at],
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      { shopId: 'a', deleted: { 'catalog.products': 3 } },
      "closed shop's data deleted",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { shopId: 'b', blocked: ['catalog.products'] },
      "closed shop's data not all deleted",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'c' }),
      "closed shop's data not deleted",
    );
  });

  it('purges nothing when no shop is due', async () => {
    const data = { due: vi.fn(async () => []), purge: vi.fn() };
    expect(await new ClosedShopPurges(data).sweep(at)).toEqual([]);
    expect(data.purge).not.toHaveBeenCalled();
  });
});
