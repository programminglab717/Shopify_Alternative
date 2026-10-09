import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';

const ACCOUNT = {
  user: {
    email: 'sana@zari.pk',
    emailVerified: true,
    phone: '+923001234567',
    phoneVerified: false,
    mfaEnabled: true,
  },
  google: { email: 'sana.zari@gmail.com', connectedAt: LATER },
};

function core(account: object = ACCOUNT) {
  return fakeCore(
    'packer',
    () => ({}),
    (path, _body, method) => {
      if (path === '/auth/sessions' && method === 'GET') {
        return {
          sessions: [
            {
              id: 'ses_1',
              current: true,
              device: 'Chrome on Android',
              ip: '39.32.1.1',
              createdAt: LATER,
              lastUsedAt: LATER,
            },
            {
              id: 'ses_2',
              current: false,
              device: 'Safari on iPhone',
              ip: null,
              createdAt: LATER,
              lastUsedAt: LATER,
            },
          ],
        };
      }
      if (path === '/auth/passkeys' && method === 'GET') {
        return {
          passkeys: [
            {
              id: 'psk_1',
              name: 'Pixel 8',
              multiDevice: true,
              createdAt: LATER,
              lastUsedAt: null,
            },
          ],
        };
      }
      if (path === '/auth/passkeys/options') {
        return {
          options: {
            challenge: 'AAAA',
            rp: { name: 'Hatti', id: 'localhost' },
            user: { id: 'dXNy', name: 'sana@zari.pk', displayName: 'Sana' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            excludeCredentials: [{ id: 'cHNr', type: 'public-key' }],
          },
        };
      }
      if (path === '/auth/email/change') {
        return { email: 'sana@zari.store', expiresAt: LATER, resendAfter: LATER };
      }
      if (path === '/auth/phone/code') return { phone: '+923211112233' };
      return {};
    },
    account,
  );
}

const sentTo = (fake: ReturnType<typeof core>, path: string, method = 'POST') =>
  fake.sent.filter((each) => each.operation === path && each.method === method).at(-1)?.variables;

describe('Your account', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows how you sign in, changes the language Hatti writes in, and signs another browser out', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1');
    fireEvent.click(await screen.findByRole('link', { name: 'Account' }));

    const contact = await screen.findByRole('region', { name: 'Email, number and language' });
    expect(within(contact).getByText('sana@zari.pk')).toBeTruthy();
    expect(within(contact).getByText('Proved')).toBeTruthy();
    expect(within(contact).getByText('Not proved')).toBeTruthy();
    expect(screen.getByText('sana.zari@gmail.com')).toBeTruthy();
    expect(await screen.findByText('Pixel 8')).toBeTruthy();
    expect(await screen.findByText('Chrome on Android · this browser')).toBeTruthy();

    fireEvent.click(within(contact).getByLabelText('اردو'));
    await waitFor(() => expect(sentTo(fake, '/auth/language')).toEqual({ language: 'ur' }));
    expect(await within(contact).findByText(/emails and messages to you are in it/)).toBeTruthy();

    expect(screen.queryByRole('button', { name: 'Sign out of Chrome on Android' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of Safari on iPhone' }));
    await waitFor(() => expect(sentTo(fake, '/auth/sessions/ses_2', 'DELETE')).toEqual({}));
    expect(await screen.findByText('Signed out of Safari on iPhone.')).toBeTruthy();
  });

  it('changes the email by a link to the new one, and proves a new number by a code', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/account');

    fireEvent.click(await screen.findByRole('button', { name: 'Change email' }));
    type('New email', 'sana@zari.store');
    fireEvent.click(screen.getByRole('button', { name: 'Send the link' }));
    await waitFor(() =>
      expect(sentTo(fake, '/auth/email/change')).toEqual({
        email: 'sana@zari.store',
        language: 'en',
      }),
    );
    expect(await screen.findByText(/Open the link we sent to sana@zari.store/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Change number' }));
    type('Mobile number', '0321 1112233');
    fireEvent.click(screen.getByRole('button', { name: 'Send a code on WhatsApp' }));
    await waitFor(() =>
      expect(sentTo(fake, '/auth/phone/code')).toEqual({
        phone: '0321 1112233',
        channel: 'whatsapp',
        language: 'en',
      }),
    );
    type('Code', '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Prove the number' }));
    await waitFor(() =>
      expect(sentTo(fake, '/auth/phone')).toEqual({
        phone: '0321 1112233',
        code: '123456',
        language: 'en',
      }),
    );
    expect(await screen.findByText(/It signs you in from now on/)).toBeTruthy();
  });

  it('adds a passkey made by the browser, and removes one', async () => {
    const create = vi.fn(async () => ({
      id: 'cred_1',
      rawId: new Uint8Array([1, 2, 3]).buffer,
      type: 'public-key',
      response: {
        clientDataJSON: new Uint8Array([4]).buffer,
        attestationObject: new Uint8Array([5]).buffer,
        getTransports: () => ['internal'],
      },
      getClientExtensionResults: () => ({}),
      authenticatorAttachment: 'platform',
    }));
    vi.stubGlobal('PublicKeyCredential', class {});
    Object.defineProperty(navigator, 'credentials', { value: { create }, configurable: true });
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/account');

    const passkeys = await screen.findByRole('region', { name: 'Passkeys' });
    type('Name it', 'Work phone');
    fireEvent.click(within(passkeys).getByRole('button', { name: 'Add a passkey' }));
    await waitFor(() =>
      expect(sentTo(fake, '/auth/passkeys')).toEqual({
        response: {
          id: 'cred_1',
          rawId: 'AQID',
          type: 'public-key',
          response: { clientDataJSON: 'BA', attestationObject: 'BQ', transports: ['internal'] },
          clientExtensionResults: {},
          authenticatorAttachment: 'platform',
        },
        name: 'Work phone',
      }),
    );
    const options = (create.mock.calls[0] as unknown as [{ publicKey: Record<string, unknown> }])[0]
      .publicKey;
    expect([...new Uint8Array(options.challenge as ArrayBuffer)]).toEqual([0, 0, 0]);
    expect(await within(passkeys).findByText(/Passkey added/)).toBeTruthy();

    fireEvent.click(within(passkeys).getByRole('button', { name: 'Remove Pixel 8' }));
    await waitFor(() => expect(sentTo(fake, '/auth/passkeys/psk_1', 'DELETE')).toEqual({}));
  });

  it('takes the number and Google off after asking, and offers to add what is missing', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/account');

    fireEvent.click(await screen.findByRole('button', { name: 'Take the number off' }));
    expect(screen.getByText(/It will not sign you in any more/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Take it off' }));
    await waitFor(() => expect(sentTo(fake, '/auth/phone', 'DELETE')).toEqual({}));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google' }));
    await waitFor(() => expect(sentTo(fake, '/auth/google', 'DELETE')).toEqual({}));
    cleanup();

    vi.stubGlobal(
      'fetch',
      core({ user: { email: null, phone: '+923001234567', phoneVerified: true }, google: null })
        .fetcher,
    );
    renderAdmin('/shop_1/account');
    expect(await screen.findByRole('button', { name: 'Add an email' })).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disconnect Google' })).toBeNull();
  });
});
