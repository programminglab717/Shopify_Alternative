import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

describe("Hatti's partners (PRT-01, ADR-504)", () => {
  beforeEach(() => signedIn());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('joins, opens a development store and lists its stores, each as it is theirs', async () => {
    let partner: unknown = null;
    let stores: unknown[] = [
      {
        id: 'shop_9',
        name: 'Gota Kinari',
        handle: 'gota-kinari',
        status: 'active',
        kind: 'client',
        role: 'marketer',
        accessEndsAt: null,
        since: '2026-10-01T10:00:00Z',
        transferredAt: null,
      },
    ];
    const core = fakeCore(
      'owner',
      () => ({}),
      (path, body, method) => {
        if (path === '/auth/partner' && method === 'GET') return { partner, stores };
        if (path === '/auth/partner') {
          partner = {
            businessName: 'Pixel Media',
            website: null,
            referralCode: 'k7mq2xpa',
            joinedAt: '2026-10-17T10:00:00Z',
          };
          return { partner };
        }
        if (path === '/auth/partner/stores') {
          const { name } = body as { name: string };
          stores = [
            {
              id: 'shop_10',
              name,
              handle: 'noor-jewels',
              status: 'active',
              kind: 'development',
              role: 'owner',
              accessEndsAt: null,
              since: '2026-10-17T10:00:00Z',
              transferredAt: null,
            },
            ...stores,
          ];
          return { shop: { id: 'shop_10', name, handle: 'noor-jewels', role: 'owner' } };
        }
        throw new Error(`unexpected ${path}`);
      },
    );
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/partners');

    await screen.findByRole('heading', { name: 'Hatti for partners' });
    await screen.findByLabelText('Your business name');
    type('Your business name', ' Pixel Media ');
    await press('Join as a partner');
    await screen.findByText('Your referral code: k7mq2xpa', { exact: false });
    expect(
      core.sent.find((each) => each.operation === '/auth/partner' && each.method === 'POST')
        ?.variables,
    ).toEqual({ businessName: 'Pixel Media', website: null });
    expect(screen.getByText('Client')).toBeTruthy();

    type("Your client's store name", 'Noor Jewels');
    await press('Open a development store');
    await screen.findByText(
      'Opened Noor Jewels. It shows shoppers that it opens soon until you hand it over.',
    );
    expect(await screen.findByText('Building')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Noor Jewels' })).toBeTruthy();
  });
});
