import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';

const TOKENS = {
  accessToken: 'hsa_2',
  accessTokenExpiresAt: LATER,
  refreshToken: 'hsr_2',
  refreshTokenExpiresAt: LATER,
  session: { id: 'ses_2', mfaVerified: true, authenticatedAt: LATER },
};

const sentTo = (fake: ReturnType<typeof fakeCore>, path: string) =>
  fake.sent.filter((each) => each.operation === path);

describe("Signing in through the shop's organisation (ADM-09, ADR-864)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the browser to the organisation's sign-in, keeping its state in the tab", async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as Location);
    const fake = fakeCore(
      'owner',
      () => ({}),
      (path) =>
        path === '/auth/sso/start'
          ? { url: 'https://login.example.com/authorize?state=s1', state: 's1' }
          : {},
    );
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/sign-in');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Sign in with your organisation (SSO)' }),
    );
    type('Work email', 'ali@zari.pk');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://login.example.com/authorize?state=s1'),
    );
    expect(sentTo(fake, '/auth/sso/start').at(-1)?.variables).toEqual({ email: 'ali@zari.pk' });
    expect(window.sessionStorage.getItem('hatti.sso.state')).toBe('s1');
  });

  it('trades the answer for the session where this tab started it, and says why not otherwise', async () => {
    const fake = fakeCore(
      'owner',
      () => ({}),
      (path) => (path === '/auth/sso/redeem' ? { status: 'signed_in', ...TOKENS } : {}),
    );
    vi.stubGlobal('fetch', fake.fetcher);

    window.history.replaceState(null, '', '/sso/callback?code=c1&state=other');
    window.sessionStorage.setItem('hatti.sso.state', 's1');
    renderAdmin('/sso/callback?code=c1&state=other');
    expect(await screen.findByText(/wasn't started in this tab/)).toBeTruthy();
    expect(sentTo(fake, '/auth/sso/redeem')).toEqual([]);
    cleanup();

    window.history.replaceState(null, '', '/sso/callback?error=not_member');
    renderAdmin('/sso/callback?error=not_member');
    expect(await screen.findByText(/you're not on this shop's staff with that email/)).toBeTruthy();
    cleanup();

    window.history.replaceState(null, '', '/sso/callback?code=c1&state=s1');
    window.sessionStorage.setItem('hatti.sso.state', 's1');
    const { router } = renderAdmin('/sso/callback?code=c1&state=s1');
    await waitFor(() =>
      expect(sentTo(fake, '/auth/sso/redeem').at(-1)?.variables).toEqual({ code: 'c1' }),
    );
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/sso/callback'));
    expect(window.sessionStorage.getItem('hatti.sso.state')).toBeNull();
  });

  it("lets the owner set the shop's provider and its domains, and require it", async () => {
    signedIn();
    let saved: Record<string, unknown> | null = null;
    const fake = fakeCore('owner', (operation, variables) => {
      switch (operation) {
        case 'Staff':
          return { staffMembers: [], staffInvitations: [] };
        case 'ShopSso':
          return { shopSso: saved };
        case 'ShopSsoUpdate': {
          const input = variables.input as Record<string, unknown>;
          saved = {
            issuer: input.issuer,
            clientId: input.clientId,
            secretHint: '0042',
            emailDomains: input.emailDomains,
            required: input.required,
            providerMfa: input.providerMfa,
            callbackUrl: 'https://api.hatti.pk/auth/sso/callback',
            domains: (input.emailDomains as string[]).map((domain) => ({
              domain,
              recordName: `_hatti-sso.${domain}`,
              provedAt: null,
            })),
            proofRecord: 'hatti-sso=0123456789abcdef0123456789abcdef',
          };
          return { shopSsoUpdate: { sso: saved, userErrors: [] } };
        }
        case 'ShopSsoDomainsCheck': {
          // DNS shows the record at the first domain alone.
          const domains = saved!.domains as { domain: string; provedAt: string | null }[];
          saved = {
            ...saved,
            domains: domains.map((each, index) => ({
              ...each,
              provedAt: index === 0 ? '2026-10-29T05:00:00.000Z' : null,
            })),
          };
          return { shopSsoDomainsCheck: { sso: saved, userErrors: [] } };
        }
        default:
          return undefined;
      }
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/staff');
    await screen.findByLabelText('Issuer URL');
    type('Issuer URL', 'https://login.microsoftonline.com/zari/v2.0');
    type('Client ID', 'hatti-zari');
    type('Client secret', 'organisation-secret-0042');
    type('Email domains', 'zari.pk, zari.com');
    fireEvent.click(screen.getByRole('checkbox', { name: /Staff sign in only through it/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save single sign-on' }));
    await waitFor(() =>
      expect(sentTo(fake, 'ShopSsoUpdate').at(-1)?.variables).toEqual({
        input: {
          issuer: 'https://login.microsoftonline.com/zari/v2.0',
          clientId: 'hatti-zari',
          clientSecret: 'organisation-secret-0042',
          emailDomains: ['zari.pk', 'zari.com'],
          required: true,
          providerMfa: true,
        },
      }),
    );
    expect(await screen.findByText('https://api.hatti.pk/auth/sso/callback')).toBeTruthy();
    expect(screen.getByText('Leave it blank to keep the one ending 0042.')).toBeTruthy();

    // Its domains, proved through DNS (ADR-919): the record to add, and a check.
    expect(screen.getByText('hatti-sso=0123456789abcdef0123456789abcdef')).toBeTruthy();
    expect(screen.getByText('_hatti-sso.zari.pk')).toBeTruthy();
    expect(screen.getAllByText('Not yet')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Check DNS' }));
    expect(await screen.findByText('Proved')).toBeTruthy();
    expect(screen.getAllByText('Not yet')).toHaveLength(1);
    expect(
      screen.getByText("DNS doesn't show the record yet. A new record can take an hour to appear."),
    ).toBeTruthy();
  });
});
