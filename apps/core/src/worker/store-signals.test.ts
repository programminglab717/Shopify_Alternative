import { describe, expect, it } from 'vitest';
import { StoreSignals } from './store-signals.js';

describe("The worker's scan for signs of scam stores (ADR-842)", () => {
  it('scans, and says how many signs stand', async () => {
    const asked: Date[] = [];
    const sweep = new StoreSignals({
      scan: (at) => {
        asked.push(at ?? new Date(0));
        return Promise.resolve(2);
      },
    });
    const at = new Date('2026-10-28T09:00:00Z');
    expect(await sweep.sweep(at)).toBe(2);
    expect(asked).toEqual([at]);
  });
});
