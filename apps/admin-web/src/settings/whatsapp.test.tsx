import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn } from '../test-support';

const SIGNUP = { appId: '1234567890', configurationId: '987654321', graphVersion: 'v26.0' };

const ACCOUNT = {
  businessAccountId: '102290129340398',
  phoneNumberId: '106540352242922',
  displayPhoneNumber: '+92 300 1234567',
  verifiedName: 'Zari Fashions',
  qualityRating: 'GREEN',
  connectedAt: LATER,
};

function core(
  role: StaffRole,
  start: { account: object | null; signup: object | null } = { account: null, signup: SIGNUP },
) {
  let account = start.account;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'WhatsAppAccount':
        return { whatsAppAccount: account, whatsAppSignup: start.signup };
      case 'WhatsAppAccountConnect': {
        const input = variables.input as { code: string };
        if (input.code === 'expired') {
          return {
            whatsAppAccountConnect: {
              whatsAppAccount: null,
              userErrors: [
                { field: ['code'], code: 'INVALID', message: 'Meta did not accept the code' },
              ],
            },
          };
        }
        account = ACCOUNT;
        return { whatsAppAccountConnect: { whatsAppAccount: account, userErrors: [] } };
      }
      case 'WhatsAppAccountDisconnect':
        account = null;
        return {
          whatsAppAccountDisconnect: {
            disconnectedPhoneNumber: ACCOUNT.displayPhoneNumber,
            userErrors: [],
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

/**
 * Facebook's SDK as Embedded Signup answers: the number chosen posted from Facebook's window,
 * then the code given to the login's callback; or the window closed.
 */
function facebook(answer: { code: string } | 'closed') {
  const init = vi.fn();
  const login = vi.fn(
    (callback: (response: { authResponse?: { code?: string } | null }) => void) => {
      if (answer === 'closed') {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: 'https://www.facebook.com',
            data: JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: {} }),
          }),
        );
        callback({ authResponse: null });
        return;
      }
      // A page of another origin saying the same is not listened to.
      for (const origin of ['https://evil.example', 'https://www.facebook.com']) {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin,
            data: JSON.stringify({
              type: 'WA_EMBEDDED_SIGNUP',
              event: 'FINISH',
              data: {
                phone_number_id: origin.includes('evil') ? '1' : ACCOUNT.phoneNumberId,
                waba_id: origin.includes('evil') ? '2' : ACCOUNT.businessAccountId,
              },
            }),
          }),
        );
      }
      callback({ authResponse: { code: answer.code } });
    },
  );
  vi.stubGlobal('FB', { init, login });
  return { init, login };
}

describe("The shop's own WhatsApp number (MKT-01, ADR-419)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('connects a number through Embedded Signup, from the settings page', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    const sdk = facebook({ code: 'AQBx-code' });
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Your WhatsApp number/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect with Facebook' }));
    await waitFor(() =>
      expect(
        fake.sent.find((each) => each.operation === 'WhatsAppAccountConnect')?.variables,
      ).toEqual({
        input: {
          code: 'AQBx-code',
          businessAccountId: ACCOUNT.businessAccountId,
          phoneNumberId: ACCOUNT.phoneNumberId,
        },
      }),
    );
    expect(sdk.init).toHaveBeenCalledWith({
      appId: SIGNUP.appId,
      version: SIGNUP.graphVersion,
      xfbml: false,
      autoLogAppEvents: false,
    });
    // What Embedded Signup is opened with, after the callback.
    expect((sdk.login.mock.calls[0] as unknown[])[1]).toMatchObject({
      config_id: SIGNUP.configurationId,
      response_type: 'code',
    });
    expect(await screen.findByText('Zari Fashions')).toBeTruthy();
    expect(screen.getByText('+92 300 1234567')).toBeTruthy();
    expect(screen.getByText('High quality')).toBeTruthy();
  });

  it('says why a number was not connected, and when Facebook was closed first', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    facebook({ code: 'expired' });
    renderAdmin('/shop_1/settings/whatsapp');

    fireEvent.click(await screen.findByRole('button', { name: 'Connect with Facebook' }));
    expect(await screen.findByText(/Meta did not accept the code/)).toBeTruthy();

    facebook('closed');
    fireEvent.click(screen.getByRole('button', { name: 'Connect with Facebook' }));
    expect(
      await screen.findByText('Facebook closed before a number was chosen. Nothing was connected.'),
    ).toBeTruthy();
    expect(fake.sent.filter((each) => each.operation === 'WhatsAppAccountConnect')).toHaveLength(1);
  });

  it('disconnects the number once asked again', async () => {
    const fake = core('owner', {
      account: { ...ACCOUNT, qualityRating: 'YELLOW' },
      signup: SIGNUP,
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/whatsapp');

    expect(await screen.findByText('Medium quality')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(screen.getByText(/Disconnect \+92 300 1234567\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
    expect(await screen.findByRole('button', { name: 'Connect with Facebook' })).toBeTruthy();
    expect(fake.sent.some((each) => each.operation === 'WhatsAppAccountDisconnect')).toBe(true);
  });

  it('says so where the server is not set up for Embedded Signup', async () => {
    vi.stubGlobal('fetch', core('owner', { account: null, signup: null }).fetcher);
    renderAdmin('/shop_1/settings/whatsapp');

    expect(
      await screen.findByText("This Hatti server isn't set up to connect WhatsApp numbers yet."),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect with Facebook' })).toBeNull();
  });
});
