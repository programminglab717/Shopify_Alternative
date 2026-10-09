import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';

const TOKENS = {
  accessToken: 'hsa_2',
  accessTokenExpiresAt: LATER,
  refreshToken: 'hsr_2',
  refreshTokenExpiresAt: LATER,
  session: { id: 'ses_2', mfaVerified: true, authenticatedAt: LATER },
};

/** What the browser's passkey signs, and the JSON of it the core is sent. */
const ASSERTION = {
  id: 'cred_1',
  rawId: new Uint8Array([1, 2, 3]).buffer,
  type: 'public-key',
  response: {
    clientDataJSON: new Uint8Array([4]).buffer,
    authenticatorData: new Uint8Array([5]).buffer,
    signature: new Uint8Array([6]).buffer,
    userHandle: new Uint8Array([7]).buffer,
  },
  getClientExtensionResults: () => ({}),
  authenticatorAttachment: 'platform',
};
const SIGNED = {
  id: 'cred_1',
  rawId: 'AQID',
  type: 'public-key',
  response: { clientDataJSON: 'BA', authenticatorData: 'BQ', signature: 'Bg', userHandle: 'Bw' },
  clientExtensionResults: {},
  authenticatorAttachment: 'platform',
};
const PASSKEY_OPTIONS = {
  challenge: 'AAAA',
  allowCredentials: [{ id: 'cHNr', type: 'public-key' }],
};

/** A browser that makes passkeys, its `get()` answering as given. */
function passkeysHere(get = vi.fn(async () => ASSERTION as unknown)) {
  vi.stubGlobal('PublicKeyCredential', class {});
  Object.defineProperty(navigator, 'credentials', {
    value: { create: vi.fn(), get },
    configurable: true,
  });
  return get;
}

/** Google Identity Services as loaded: its button gives back `token` when tapped. */
function googleHere(token = 'google-id-token') {
  let callback: (answer: { credential: string }) => void = () => {};
  const initialize = vi.fn((config: { callback: typeof callback }) => {
    callback = config.callback;
  });
  const renderButton = vi.fn((parent: HTMLElement) => {
    const button = document.createElement('button');
    button.textContent = "Google's button";
    button.onclick = () => callback({ credential: token });
    parent.append(button);
  });
  vi.stubGlobal('google', { accounts: { id: { initialize, renderButton } } });
  return initialize;
}

const refused = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const sentTo = (fake: ReturnType<typeof fakeCore>, path: string, method = 'POST') =>
  fake.sent.filter((each) => each.operation === path && each.method === method);

describe('Signing in with a passkey or Google', () => {
  beforeEach(() => window.localStorage.clear());

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('signs in with a passkey alone, says when none was used, and takes one as the second step', async () => {
    const get = passkeysHere();
    get.mockRejectedValueOnce(new DOMException('No', 'NotAllowedError'));
    const fake = fakeCore(
      'owner',
      () => ({}),
      (path) => {
        if (path === '/auth/sign-in/passkey/options') return { options: PASSKEY_OPTIONS };
        if (path === '/auth/sign-in/passkey') return { status: 'signed_in', ...TOKENS };
        return {};
      },
    );
    vi.stubGlobal('fetch', fake.fetcher);
    const { router } = renderAdmin('/sign-in');

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));
    expect(await screen.findByText(/No passkey was used/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
    await waitFor(() =>
      expect(sentTo(fake, '/auth/sign-in/passkey').at(-1)?.variables).toEqual({
        response: SIGNED,
      }),
    );
    const { publicKey } = (
      get.mock.calls.at(-1) as unknown as [
        { publicKey: { challenge: ArrayBuffer; allowCredentials: { id: ArrayBuffer }[] } },
      ]
    )[0];
    expect([...new Uint8Array(publicKey.challenge)]).toEqual([0, 0, 0]);
    expect([...new Uint8Array(publicKey.allowCredentials[0]!.id)]).toEqual([112, 115, 107]);
    await waitFor(() => expect(router.state.location.pathname).toBe('/shop_1'));
    cleanup();
    window.localStorage.clear();

    const second = fakeCore(
      'owner',
      () => ({}),
      (path) => {
        if (path === '/auth/sign-in') {
          return {
            status: 'mfa_required',
            challengeToken: 'hsc_1',
            methods: ['passkey'],
            passkeyOptions: PASSKEY_OPTIONS,
          };
        }
        if (path === '/auth/sign-in/verify') return { status: 'signed_in', ...TOKENS };
        return {};
      },
    );
    vi.stubGlobal('fetch', second.fetcher);
    renderAdmin('/sign-in');
    fireEvent.click(await screen.findByRole('tab', { name: 'Email' }));
    type('Email', 'sana@zari.pk');
    type('Password', 'a long password');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Use a passkey' }));
    expect(screen.queryByLabelText('Code')).toBeNull();
    await waitFor(() =>
      expect(sentTo(second, '/auth/sign-in/verify').at(-1)?.variables).toEqual({
        challengeToken: 'hsc_1',
        passkey: SIGNED,
      }),
    );
  });

  it("signs in with Google's own button, a new account going on to open a shop", async () => {
    const initialize = googleHere();
    const fake = fakeCore(
      'owner',
      () => ({}),
      (path) => {
        if (path === '/auth/google/options') {
          return { clientId: 'cid.apps.googleusercontent.com', nonce: 'n_1', expiresAt: LATER };
        }
        if (path === '/auth/google/sign-in') {
          return { status: 'signed_in', signedUp: true, ...TOKENS };
        }
        return {};
      },
    );
    vi.stubGlobal('fetch', fake.fetcher);
    const { router } = renderAdmin('/sign-in');

    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    fireEvent.click(await screen.findByRole('button', { name: "Google's button" }));
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 'cid.apps.googleusercontent.com', nonce: 'n_1' }),
    );
    await waitFor(() =>
      expect(sentTo(fake, '/auth/google/sign-in').at(-1)?.variables).toEqual({
        idToken: 'google-id-token',
        language: 'en',
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/shops'));
    cleanup();
    window.localStorage.clear();

    vi.stubGlobal(
      'fetch',
      fakeCore(
        'owner',
        () => ({}),
        (path) =>
          path === '/auth/google/options' ? refused(503, 'GOOGLE_SIGN_IN_UNAVAILABLE') : {},
      ).fetcher,
    );
    renderAdmin('/sign-in');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByText(/Signing in with Google is not set up here/)).toBeTruthy();
  });

  it('confirms who you are with a passkey or Google, and connects Google from your account', async () => {
    signedIn();
    passkeysHere(vi.fn().mockRejectedValue(new DOMException('No', 'NotAllowedError')));
    googleHere('google-again');
    let confirmed = false;
    const fake = fakeCore(
      'owner',
      () => ({}),
      (path, _body, method) => {
        if (path === '/auth/sessions') return { sessions: [] };
        if (path === '/auth/passkeys' && method === 'GET') return { passkeys: [] };
        if (path === '/auth/google' && method === 'DELETE') {
          return confirmed ? {} : refused(403, 'REAUTHENTICATION_REQUIRED');
        }
        if (path === '/auth/reauthenticate/options') {
          return {
            methods: ['passkey', 'google', 'password'],
            passkeyOptions: PASSKEY_OPTIONS,
            googleOptions: { clientId: 'cid', nonce: 'n_2', expiresAt: LATER },
            phone: null,
          };
        }
        if (path === '/auth/reauthenticate') {
          confirmed = true;
          return { authenticatedAt: LATER, sensitiveActionsUntil: LATER };
        }
        return {};
      },
      { google: { email: 'sana.zari@gmail.com', connectedAt: LATER } },
    );
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/account');

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Google' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with your passkey' }));
    expect(await screen.findByText(/No passkey was used/)).toBeTruthy();
    await waitFor(() => expect(sentTo(fake, '/auth/reauthenticate/options')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Use Google' }));
    fireEvent.click(await screen.findByRole('button', { name: "Google's button" }));
    await waitFor(() =>
      expect(sentTo(fake, '/auth/reauthenticate').at(-1)?.variables).toEqual({
        googleIdToken: 'google-again',
      }),
    );
    expect(await screen.findByText('Google no longer signs you in.')).toBeTruthy();
    expect(sentTo(fake, '/auth/google', 'DELETE')).toHaveLength(2);
    cleanup();

    const connecting = fakeCore(
      'owner',
      () => ({}),
      (path, _body, method) => {
        if (path === '/auth/sessions') return { sessions: [] };
        if (path === '/auth/passkeys' && method === 'GET') return { passkeys: [] };
        if (path === '/auth/google/options')
          return { clientId: 'cid', nonce: 'n_3', expiresAt: LATER };
        return {};
      },
      { google: null },
    );
    vi.stubGlobal('fetch', connecting.fetcher);
    renderAdmin('/shop_1/account');
    const signingIn = await screen.findByRole('region', { name: 'Signing in' });
    fireEvent.click(within(signingIn).getByRole('button', { name: 'Connect Google' }));
    fireEvent.click(await within(signingIn).findByRole('button', { name: "Google's button" }));
    await waitFor(() =>
      expect(sentTo(connecting, '/auth/google').at(-1)?.variables).toEqual({
        idToken: 'google-again',
        language: 'en',
      }),
    );
    expect(await screen.findByText(/Google is connected/)).toBeTruthy();
  });
});
