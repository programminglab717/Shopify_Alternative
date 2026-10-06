import type { Logger } from '@hatti/logger';
import { describe, expect, it, vi } from 'vitest';
import type { StorefrontPublisher } from '../storefront/publisher.js';
import { STOREFRONT_IDLE_MS, StorefrontSweep } from './storefront-sweep.js';

describe('Storefronts left waiting (ADR-225)', () => {
  it("builds each shop taken, a hundred at a time, one shop's failure not the others'", async () => {
    const batches = [Array.from({ length: 100 }, (_, index) => `shop-${index}`), ['a', 'b']];
    const queue = { takeWaiting: vi.fn(async () => batches.shift() ?? []) };
    const publish = vi.fn(async (shopId: string) => {
      if (shopId === 'a') throw new Error('database down');
      return 2;
    });
    const warned: unknown[] = [];
    const logger = { warn: (obj: unknown) => warned.push(obj) } as unknown as Logger;
    const publisher = { queue, publish } as unknown as Pick<
      StorefrontPublisher,
      'queue' | 'publish'
    >;
    expect(await new StorefrontSweep(publisher, logger).sweep()).toBe(202);
    // A second batch taken because the first was whole, and no third after one that wasn't.
    expect(queue.takeWaiting.mock.calls).toEqual([
      [STOREFRONT_IDLE_MS, 100],
      [STOREFRONT_IDLE_MS, 100],
    ]);
    expect(publish).toHaveBeenCalledTimes(102);
    expect(warned).toEqual([expect.objectContaining({ shopId: 'a' })]);
  });
});
