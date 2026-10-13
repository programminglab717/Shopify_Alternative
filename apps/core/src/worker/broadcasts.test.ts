import type { BroadcastRound } from '@hatti/messaging/public';
import { describe, expect, it } from 'vitest';
import { BroadcastQueue } from './broadcasts.js';

describe('The broadcasts sweep (ADR-422)', () => {
  it('queues each broadcast due round after round until it is all queued, waits or fails', async () => {
    const rounds: Record<string, BroadcastRound[]> = {
      sale: [
        { outcome: 'queued', queued: 500, done: false },
        { outcome: 'queued', queued: 120, done: true },
      ],
      night: [{ outcome: 'waiting', until: new Date('2026-10-14T05:00:00.000Z') }],
      gone: [{ outcome: 'failed', error: 'Its segment was deleted' }],
      broken: [],
      later: [{ outcome: 'queued', queued: 3, done: true }],
    };
    const asked: string[] = [];
    const queue = new BroadcastQueue({
      due: async () =>
        ['sale', 'night', 'gone', 'broken', 'later'].map((id) => ({ shopId: `shop-${id}`, id })),
      queueNext: async (shopId, id) => {
        asked.push(id);
        const round = rounds[id]!.shift();
        // One that throws is not the others'.
        if (!round) throw new Error(`${shopId} unreachable`);
        return round;
      },
    });
    expect(await queue.sweep(new Date('2026-10-13T08:00:00.000Z'))).toBe(623);
    expect(asked).toEqual(['sale', 'sale', 'night', 'gone', 'broken', 'later']);
  });
});
