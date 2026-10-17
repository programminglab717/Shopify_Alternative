import { cleanup, screen } from '@testing-library/react';
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
