import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushCampaignValue } from '../api/types';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const SENT: PushCampaignValue = {
  id: 'pcmp_1',
  title: 'Eid sale',
  body: '30% off lawn, today only',
  path: '/collections/eid',
  status: 'SENT',
  sent: 1180,
  failed: 2,
  gone: 14,
  createdAt: '2026-10-26T10:00:00Z',
  sentAt: '2026-10-26T10:02:00Z',
};

/** A fake core keeping the shop's campaigns as the core would. */
function pushCore(options: { available?: boolean; subscribers?: number } = {}) {
  let campaigns = [SENT];
  return fakeCore('marketer', (operation, variables) => {
    switch (operation) {
      case 'ShopperPushes':
        return {
          shopperPushes: {
            available: options.available ?? true,
            subscribers: options.subscribers ?? 1214,
            perDay: 3,
            campaigns,
          },
        };
      case 'PushCampaignSend': {
        const input = variables.input as { title: string; body: string; path: string | null };
        if (input.path === '//evil') {
          return {
            pushCampaignSend: {
              campaign: null,
              userErrors: [
                {
                  field: ['input', 'path'],
                  code: 'INVALID',
                  message: 'Path must be a page of the shop, like /collections/eid',
                },
              ],
            },
          };
        }
        const made: PushCampaignValue = {
          ...SENT,
          id: 'pcmp_2',
          title: input.title,
          body: input.body,
          path: input.path ?? '/',
          status: 'SENDING',
          sent: 0,
          failed: 0,
          gone: 0,
          createdAt: '2026-10-27T10:00:00Z',
          sentAt: null,
        };
        campaigns = [made, ...campaigns];
        return { pushCampaignSend: { campaign: made, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('Push notifications in the admin (OS-14, ADR-835)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends a push to every browser with them on, says what the core refuses, and lists those sent', async () => {
    const core = pushCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/marketing/pushes');

    expect(await screen.findByText('Browsers with your notifications on: 1,214')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Pushes sent' });
    expect(within(list).getByText('Eid sale')).toBeTruthy();
    expect(within(list).getByText(/Reached 1,180; 14 had turned them off/)).toBeTruthy();

    type('Title', 'Chand Raat');
    type('Message', 'Free delivery tonight');
    type('Page it opens', '//evil');
    await press('Send to everyone');
    await screen.findByText(/must be a page of the shop/);
    type('Page it opens', '');
    await press('Send to everyone');
    await screen.findByText('Sending. It reaches everyone within a few minutes.');
    expect(
      core.sent
        .filter((each) => each.operation === 'PushCampaignSend')
        .map((each) => each.variables),
    ).toEqual([
      { input: { title: 'Chand Raat', body: 'Free delivery tonight', path: '//evil' } },
      { input: { title: 'Chand Raat', body: 'Free delivery tonight', path: null } },
    ]);
    expect(await within(list).findByText('Chand Raat')).toBeTruthy();
    expect(within(list).getByText('Sending')).toBeTruthy();
  });

  it('sends nothing while no browser has them on, and says when Hatti pushes nothing', async () => {
    vi.stubGlobal('fetch', pushCore({ subscribers: 0 }).fetcher);
    renderAdmin('/shop_1/marketing/pushes');
    const send = await screen.findByRole('button', { name: 'Send to everyone' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    vi.stubGlobal('fetch', pushCore({ available: false }).fetcher);
    renderAdmin('/shop_1/marketing/pushes');
    expect(
      await screen.findByText('Push notifications are not turned on for Hatti yet.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send to everyone' })).toBeNull();
  });
});
