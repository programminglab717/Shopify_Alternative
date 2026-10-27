import type { PushCampaignRound } from '@hatti/messaging/public';
import { describe, expect, it } from 'vitest';
import { PushCampaigns } from './push-campaigns.js';

describe("The worker's push campaigns (ADR-834)", () => {
  it('pushes each campaign round after round until it is sent, waiting, or gone', async () => {
    const rounds = new Map<string, PushCampaignRound[]>([
      [
        'a',
        [
          { outcome: 'pushed', sent: 500, done: false },
          { outcome: 'pushed', sent: 20, done: true },
        ],
      ],
      ['b', [{ outcome: 'waiting', until: new Date() }]],
      ['c', []],
      ['d', [{ outcome: 'pushed', sent: 3, done: true }]],
    ]);
    const asked: string[] = [];
    const sweep = new PushCampaigns({
      due: () => Promise.resolve([...rounds.keys()].map((id) => ({ shopId: `shop-${id}`, id }))),
      pushNext: (shopId, id) => {
        asked.push(id);
        // One that throws is left to the next sweep; the others go on.
        if (id === 'c') return Promise.reject(new Error('down'));
        return Promise.resolve(rounds.get(id)!.shift() ?? { outcome: 'none' });
      },
    });
    expect(await sweep.sweep()).toBe(523);
    expect(asked).toEqual(['a', 'a', 'b', 'c', 'd']);
  });
});
