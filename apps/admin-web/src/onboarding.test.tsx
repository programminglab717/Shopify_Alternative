import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserFetch } from './api/client';
import { SessionProvider } from './auth/context';
import { SessionStore } from './auth/session';
import { LocaleProvider } from './i18n/locale';
import { createAdminRouter } from './router';

const LATER = new Date(Date.now() + 3_600_000).toISOString();
const tokens = (mfaVerified: boolean) => ({
  accessToken: 'hsa_1',
  accessTokenExpiresAt: LATER,
  refreshToken: 'hsr_1',
  refreshTokenExpiresAt: LATER,
  session: { id: 'ses_1', mfaVerified, authenticatedAt: new Date().toISOString() },
});

/** A fake core: each `/auth` path's answer, and every request it was sent. */
function fakeCore() {
  const sent: { path: string; body: unknown }[] = [];
  const shops: { id: string; name: string; role: string; mfaRequired: boolean }[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : null;
    sent.push({ path, body });
    switch (path) {
      case '/auth/phone/code':
        return json(200, { phone: '0300 •••4567', channel: 'whatsapp', resendAfter: LATER });
      case '/auth/phone/sign-in':
        return body?.code === '123456'
          ? json(200, { status: 'sign_up_required', signUpToken: 'hsu_1', phone: body.phone })
          : json(401, { error: { code: 'INVALID_CODE', message: 'Invalid code' } });
      case '/auth/phone/sign-up':
        return json(201, { user: { id: 'usr_1', name: body?.name }, ...tokens(false) });
      case '/auth/me':
        return json(200, {
          user: { id: 'usr_1', name: 'Ayesha', language: 'en' },
          session: { id: 'ses_1', mfaVerified: false },
          shops,
        });
      case '/auth/shops': {
        const shop = { id: 'shop_1', name: body!.name!, role: 'owner', mfaRequired: true };
        shops.push(shop);
        return json(201, { shop });
      }
      case '/auth/two-step/totp/setup':
        return json(200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/Hatti' });
      default:
        return json(404, { error: { code: 'NOT_FOUND', message: path } });
    }
  });
  return { fetcher, sent };
}

function renderAdmin(path: string) {
  const session = new SessionStore(browserFetch);
  const router = createAdminRouter(session, createMemoryHistory({ initialEntries: [path] }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <LocaleProvider initial="en">
      <SessionProvider store={session}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </SessionProvider>
    </LocaleProvider>,
  );
  return { router, session };
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = async (name: string) => {
  await act(async () => fireEvent.click(screen.getByRole('button', { name })));
};

describe('A merchant new to Hatti', () => {
  let core: ReturnType<typeof fakeCore>;

  beforeEach(() => {
    window.localStorage.clear();
    core = fakeCore();
    vi.stubGlobal('fetch', core.fetcher);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('signs up by mobile, opens a shop, and is asked to turn on the second step', async () => {
    const { router } = renderAdmin('/');
    await screen.findByRole('heading', { name: 'Sign in to Hatti' });
    expect(router.state.location.pathname).toBe('/sign-in');

    // A number that is not a Pakistani mobile is caught before anything is sent.
    type('Mobile number', '12345');
    await press('Send code');
    expect(screen.getByRole('alert').textContent).toContain('Enter a Pakistani mobile number');
    expect(core.sent).toEqual([]);

    type('Mobile number', '0300 123 4567');
    await press('Send code');
    await screen.findByText('We sent a 6-digit code to 0300 •••4567.');
    expect(core.sent.at(-1)).toEqual({
      path: '/auth/phone/code',
      body: { phone: '+923001234567', channel: 'whatsapp', language: 'en' },
    });

    type('Code', '000000');
    await press('Sign in');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That code is not right. Check it and try again.',
    );

    type('Code', '123456');
    await press('Sign in');
    await screen.findByRole('heading', { name: 'Welcome to Hatti' });
    type('Your name', 'Ayesha Khan');
    await press('Open my account');

    await screen.findByRole('heading', { name: 'Open your shop' });
    expect(router.state.location.pathname).toBe('/shops');
    type('Shop name', 'Zari Fashions');
    await press('Open my shop');

    // An owner's role needs the second step before the shop's admin opens.
    await screen.findByRole('heading', { name: 'Protect your shop with a second step' });
    expect(router.state.location).toMatchObject({
      pathname: '/two-step',
      search: { shop: 'shop_1' },
    });
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeTruthy();
    expect(core.sent.map((request) => request.path)).toContain('/auth/shops');
    expect(JSON.parse(window.localStorage.getItem('hatti.session')!)).toMatchObject({
      refreshToken: 'hsr_1',
    });
  });
});
