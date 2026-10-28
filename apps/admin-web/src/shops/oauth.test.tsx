import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmIdentity, fakeCore, LATER, renderAdmin, signedIn } from '../test-support';
import { installLinkOf, type PartnerApp } from './partner-apps';

const LINK =
  '/oauth/authorize?client_id=hca_1&scope=read_products,write_orders' +
  '&redirect_uri=https%3A%2F%2Freviews.example.pk%2Fcallback&state=n0nce';

const CONSENT = {
  app: {
    name: 'Reviews Pro',
    appUrl: 'https://reviews.example.pk',
    partner: 'Bazaar Labs',
    scopes: ['read_products', 'write_orders'],
    listed: false,
  },
};

function core(options: { confirmed?: boolean } = {}) {
  let confirmed = options.confirmed ?? true;
  return fakeCore(
    'owner',
    () => ({}),
    (path) => {
      if (path.startsWith('/auth/oauth/app?')) return CONSENT;
      if (path === '/auth/oauth/authorize') {
        if (!confirmed) {
          return new Response(
            JSON.stringify({
              error: { code: 'REAUTHENTICATION_REQUIRED', message: 'Confirm it is you first' },
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          );
        }
        return { redirectUrl: 'https://reviews.example.pk/callback?code=c0de&shop=shop_1' };
      }
      if (path === '/auth/reauthenticate/options') {
        return { methods: ['password'], passkeyOptions: null, googleOptions: null, phone: null };
      }
      if (path === '/auth/reauthenticate') {
        confirmed = true;
        return { authenticatedAt: LATER, sensitiveActionsUntil: LATER };
      }
      return {};
    },
  );
}

describe('Installing a public app (DEV-05, ADR-851)', () => {
  const assign = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    assign.mockReset();
    vi.stubGlobal('location', {
      ...window.location,
      assign,
      search: LINK.slice(LINK.indexOf('?')),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows what the app asks, and sends the owner back to it with its code', async () => {
    signedIn();
    const fake = core({ confirmed: false });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin(LINK);

    expect(await screen.findByText('Reviews Pro, by Bazaar Labs, asks to:')).toBeTruthy();
    expect(screen.getByText('See products')).toBeTruthy();
    expect(screen.getByText('See and change orders')).toBeTruthy();
    expect(screen.getByText(/^Hatti hasn't reviewed this app yet/)).toBeTruthy();
    expect((screen.getByLabelText('Install on') as HTMLSelectElement).value).toBe('shop_1');

    fireEvent.click(screen.getByRole('button', { name: 'Install app' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        'https://reviews.example.pk/callback?code=c0de&shop=shop_1',
      ),
    );
    const approvals = fake.sent.filter((each) => each.operation === '/auth/oauth/authorize');
    expect(approvals.at(-1)?.variables).toEqual({
      clientId: 'hca_1',
      redirectUri: 'https://reviews.example.pk/callback',
      scope: 'read_products,write_orders',
      state: 'n0nce',
      shopId: 'shop_1',
    });
  });

  it('keeps the link while a merchant signs in', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    const { router } = renderAdmin(LINK);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(window.sessionStorage.getItem('hatti.oauth')).toBe(LINK);
  });

  it('opens the kept link once the merchant has signed in', async () => {
    signedIn();
    window.sessionStorage.setItem('hatti.oauth', LINK);
    vi.stubGlobal('fetch', core().fetcher);
    const { router } = renderAdmin('/shops');
    await waitFor(() => expect(router.state.location.pathname).toBe('/oauth/authorize'));
    expect(await screen.findByText('Reviews Pro, by Bazaar Labs, asks to:')).toBeTruthy();
    expect(window.sessionStorage.getItem('hatti.oauth')).toBeNull();
  });

  it('refuses a link that is missing what it needs', async () => {
    vi.stubGlobal('location', { ...window.location, assign, search: '?client_id=hca_1' });
    signedIn();
    vi.stubGlobal('fetch', core().fetcher);
    renderAdmin('/oauth/authorize?client_id=hca_1');
    expect(
      await screen.findByText(/^This link to install an app is missing something/),
    ).toBeTruthy();
  });

  it("gives partners their app's install link", () => {
    const app: PartnerApp = {
      id: 'papp_1',
      name: 'Reviews Pro',
      appUrl: 'https://reviews.example.pk',
      redirectUrls: ['https://reviews.example.pk/callback'],
      scopes: ['read_products', 'write_orders'],
      clientId: 'hca_1',
      listed: true,
      createdAt: LATER,
    };
    expect(installLinkOf(app, 'https://admin.hatti.pk')).toBe(
      'https://admin.hatti.pk/oauth/authorize?client_id=hca_1' +
        '&scope=read_products%2Cwrite_orders&redirect_uri=https%3A%2F%2Freviews.example.pk%2Fcallback',
    );
  });
});
