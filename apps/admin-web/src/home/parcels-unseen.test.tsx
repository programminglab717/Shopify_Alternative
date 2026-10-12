import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn } from '../test-support';

const tally = (count: number) => ({ count, total: { amount: '0', currencyCode: 'PKR' } });

/** Home with nothing to do but the parcels the courier has not seen. */
function core(role: StaffRole, parcelsUnseen: number) {
  return fakeCore(role, (operation) => {
    if (operation === 'SetupChecklist') {
      return { setupChecklist: { done: 8, total: 8, steps: [] } };
    }
    if (operation === 'HomeStock') {
      return { home: { lowStock: { low: 0, out: 0, threshold: 5 }, transfersToReceive: 0 } };
    }
    if (operation !== 'Home') throw new Error(`unexpected ${operation}`);
    return {
      shop: { timezone: 'Asia/Karachi' },
      home: {
        toConfirm: tally(0),
        toReview: tally(0),
        awaitingPayment: tally(0),
        transfersToCheck: tally(0),
        toPack: tally(0),
        toBook: tally(0),
        returning: tally(0),
        returnsToReceive: tally(0),
        cashToCollect: tally(0),
        lostToClaim: tally(0),
        claimsOpen: tally(0),
        parcelsUnseen,
        today: {
          since: LATER,
          sales: tally(0),
          salesYesterday: tally(0),
          delivered: tally(0),
          returnedToOrigin: tally(0),
        },
      },
    };
  });
}

describe("Home's parcels the courier has not seen (ADR-380)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('takes an owner and a packer to the pickups that list them', async () => {
    for (const role of ['owner', 'packer'] as const) {
      vi.stubGlobal('fetch', core(role, 2).fetcher);
      renderAdmin('/shop_1');
      const link = await screen.findByRole('link', {
        name: /2 parcels handed over that the courier has not scanned in/,
      });
      expect(link.getAttribute('href')).toBe('/shop_1/shipping?tab=pickups');
      cleanup();
    }
    vi.stubGlobal('fetch', core('owner', 1).fetcher);
    renderAdmin('/shop_1');
    expect(
      await screen.findByRole('link', {
        name: /A parcel handed over that the courier has not scanned in/,
      }),
    ).toBeTruthy();
  });

  it('says nothing of them while there are none, or to staff who do not hand parcels over', async () => {
    vi.stubGlobal('fetch', core('owner', 0).fetcher);
    renderAdmin('/shop_1');
    await screen.findByText('All caught up. New orders will show here.');
    expect(screen.queryByText(/not scanned in/)).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', core('confirmation_agent', 3).fetcher);
    renderAdmin('/shop_1');
    await screen.findByText('All caught up. New orders will show here.');
    expect(screen.queryByText(/not scanned in/)).toBeNull();
  });
});
