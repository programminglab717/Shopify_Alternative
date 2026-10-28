import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';
import { forgetReferral, referralCode, rememberReferral } from './referral';

describe("Hatti's partners (PRT-01, ADR-504)", () => {
  beforeEach(() => signedIn());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps a partner's referral code from its link until a shop takes it (ADR-505)", () => {
    window.localStorage.clear();
    rememberReferral('?ref=not-a-code');
    expect(referralCode()).toBeNull();
    rememberReferral('?ref=K7MQ2XPA');
    expect(referralCode()).toBe('k7mq2xpa');
    // Another page without one keeps it.
    rememberReferral('?shop=shop_1');
    expect(referralCode()).toBe('k7mq2xpa');
    forgetReferral();
    expect(referralCode()).toBeNull();
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
        if (path === '/auth/agreement') {
          return {
            documents: [
              { handle: 'terms', version: '2026-10-22', url: '/legal/terms' },
              { handle: 'acceptable-use', version: '2026-10-22', url: '/legal/acceptable-use' },
              { handle: 'data-processing', version: '2026-10-22', url: '/legal/data-processing' },
            ],
          };
        }
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
          const { name, agreed } = body as { name: string; agreed: Record<string, string> };
          // The partner agreed to Hatti's terms as the store's owner (ADR-737).
          expect(Object.keys(agreed)).toEqual(['terms', 'acceptable-use', 'data-processing']);
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
    (await screen.findByRole('checkbox', { name: /I agree to Hatti's/ })).click();
    await press('Open a development store');
    await screen.findByText(
      'Opened Noor Jewels. It shows shoppers that it opens soon until you hand it over.',
    );
    expect(await screen.findByText('Building')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Noor Jewels' })).toBeTruthy();
  });

  it('offers a theme of its development store to the theme store, and lists its own (ADR-853)', async () => {
    let themes = [
      {
        id: 'thls_1',
        name: 'Saada',
        description: '',
        price: '0',
        listed: true,
        shopId: 'shop_10',
        themeId: 'thm_1',
        updatedAt: '2026-10-20T10:00:00Z',
      },
    ];
    const core = fakeCore(
      'owner',
      (operation, variables) => {
        if (operation === 'Themes') {
          return {
            themes: {
              nodes: [
                {
                  id: 'thm_2',
                  name: 'Basant draft',
                  role: 'UNPUBLISHED',
                  base: 'hatti-base',
                  previewUrl: 'https://noor.hatti.pk/?preview_theme_id=thm_2',
                  publishAt: null,
                  createdAt: '2026-10-20T10:00:00Z',
                  updatedAt: '2026-10-20T10:00:00Z',
                },
              ],
            },
            platformThemes: [],
          };
        }
        if (operation === 'ThemeStoreOffer') {
          const input = variables.input as { name: string; price: string };
          themes = [
            ...themes,
            { ...themes[0]!, id: 'thls_2', name: input.name, price: '500000', listed: false },
          ];
          return {
            themeStoreOffer: { listing: { id: 'thls_2', name: input.name }, userErrors: [] },
          };
        }
        throw new Error(`unexpected ${operation}`);
      },
      (path) => {
        if (path === '/auth/partner') {
          return {
            partner: {
              businessName: 'Rang Studio',
              website: null,
              referralCode: 'rang0001',
              joinedAt: '2026-10-17T10:00:00Z',
            },
            stores: [
              {
                id: 'shop_10',
                name: 'Rang lab',
                handle: 'rang-lab',
                status: 'active',
                kind: 'development',
                role: 'owner',
                accessEndsAt: null,
                since: '2026-10-17T10:00:00Z',
                transferredAt: null,
              },
            ],
            earnings: null,
          };
        }
        if (path === '/auth/partner/apps') return { apps: [] };
        if (path === '/auth/partner/themes') return { themes };
        throw new Error(`unexpected ${path}`);
      },
    );
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/partners');

    expect(await screen.findByText('Saada')).toBeTruthy();
    expect(screen.getByText('In the store')).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByLabelText('Theme') as HTMLSelectElement).value).toBe('thm_2'),
    );
    type('Name in the store', 'Basant');
    fireEvent.change(screen.getByLabelText('Price in rupees, 0 for free'), {
      target: { value: '5000' },
    });
    await press('Offer to the theme store');
    expect(await screen.findByText('Basant waits for Hatti to look at it.')).toBeTruthy();
    expect(core.sent.find((each) => each.operation === 'ThemeStoreOffer')?.variables).toEqual({
      themeId: 'thm_2',
      input: { name: 'Basant', description: '', price: '5000' },
    });
    expect(await screen.findByText('Waiting for review')).toBeTruthy();
  });

  it('shows what it earned, its link, and keeps the bank account it is paid into (ADR-505)', async () => {
    let partner = {
      businessName: 'Pixel Media',
      website: null,
      referralCode: 'k7mq2xpa',
      payout: null as { title: string; iban: string } | null,
      joinedAt: '2026-10-01T10:00:00Z',
    };
    const earnings = {
      earned: '659780',
      paidOut: '59980',
      owed: '599800',
      entries: [
        {
          shopName: 'Zari Lawn',
          invoiceNumber: '1002',
          plan: 'growth',
          invoiceAmount: '2999000',
          sharePercent: 20,
          amount: '599800',
          earnedAt: '2026-10-16T10:00:00Z',
          paidOutAt: null,
          payoutReference: null,
        },
      ],
    };
    const core = fakeCore(
      'owner',
      () => ({}),
      (path, body, method) => {
        if (path !== '/auth/partner') throw new Error(`unexpected ${path}`);
        if (method === 'GET') return { partner, stores: [], earnings };
        const { payoutTitle, payoutIban } = body as { payoutTitle: string; payoutIban: string };
        partner = { ...partner, payout: { title: payoutTitle, iban: payoutIban } };
        return { partner };
      },
    );
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/partners');

    await screen.findByRole('heading', { name: 'Your earnings' });
    expect(screen.getAllByText('Rs 5,998')).toHaveLength(2);
    expect(screen.getByText('Rs 6,597.80')).toBeTruthy();
    expect(screen.getByText('20% of Rs 29,990', { exact: false })).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/sign-up?ref=k7mq2xpa`)).toBeTruthy();
    type('Bank account title', 'Pixel Media (Pvt) Ltd');
    type('IBAN', 'PK36SCBL0000001123456702');
    await press('Save bank account');
    await screen.findByText('Saved. Hatti pays what you are owed into this account.');
    expect(
      core.sent.find((each) => each.operation === '/auth/partner' && each.method === 'POST')
        ?.variables,
    ).toEqual({
      businessName: 'Pixel Media',
      website: null,
      payoutTitle: 'Pixel Media (Pvt) Ltd',
      payoutIban: 'PK36SCBL0000001123456702',
    });
  });
});
