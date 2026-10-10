import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  confirmIdentity,
  fakeCore,
  press,
  REAUTHENTICATE,
  renderAdmin,
  signedIn,
  type,
} from '../test-support';

const LATER = new Date(Date.now() + 7 * 86_400_000).toISOString();

const TEST_COURIER = {
  courier: 'test',
  name: 'Test courier',
  test: true,
  pickupCode: null,
  credentials: [{ key: 'key', label: 'Any key' }],
};
const POSTEX = {
  courier: 'postex',
  name: 'PostEx',
  test: false,
  pickupCode: 'Pickup address code',
  credentials: [{ key: 'token', label: 'API token' }],
};

describe('Settings in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('connects a courier account with the credentials its courier asks for', async () => {
    const accounts: unknown[] = [];
    const core = fakeCore('owner', (operation) => {
      if (operation === 'CourierAccounts') {
        return { couriers: [POSTEX, TEST_COURIER], courierAccounts: accounts };
      }
      if (operation === 'CourierAccountConnect') {
        accounts.push({
          id: 'cra_1',
          name: 'PostEx Lahore',
          courier: 'postex',
          courierName: 'PostEx',
          isDefault: true,
          credentialsHint: 'f00d',
          pickupCode: null,
          createdAt: LATER,
        });
        return {
          courierAccountConnect: {
            courierAccount: { id: 'cra_1', name: 'PostEx Lahore', isDefault: true },
            userErrors: [],
          },
        };
      }
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/couriers');

    await screen.findByText('No courier account yet.');
    type('API token', ' tok_123f00d ');
    type('Pickup address code', 'LHR-12');
    type('Name', 'PostEx Lahore');
    await press('Connect');
    await screen.findByText('Connected. Packed orders can be booked with it now.');
    expect(screen.getByText('ends in f00d')).toBeTruthy();
    expect(core.sent.find((each) => each.operation === 'CourierAccountConnect')?.variables).toEqual(
      {
        input: {
          courier: 'postex',
          name: 'PostEx Lahore',
          credentials: [{ key: 'token', value: 'tok_123f00d' }],
          pickupCode: 'LHR-12',
        },
      },
    );
  });

  it('invites a packer once the owner confirms who they are, and gives the link to send', async () => {
    let confirmed = false;
    const core = fakeCore(
      'owner',
      (operation) => {
        switch (operation) {
          case 'Staff':
            return {
              staffMembers: [
                {
                  id: 'usr_1',
                  name: 'Sana',
                  email: 'sana@zari.pk',
                  role: 'OWNER',
                  joinedAt: LATER,
                },
                { id: 'usr_2', name: 'Bilal', email: null, role: 'PACKER', joinedAt: LATER },
              ],
              staffInvitations: [],
            };
          case 'StaffInvitationCreate':
            if (!confirmed) return REAUTHENTICATE;
            return {
              staffInvitationCreate: {
                token: 'hsi_abc',
                emailed: false,
                invitation: { id: 'inv_1' },
                userErrors: [],
              },
            };
          default:
            throw new Error(`unexpected ${operation}`);
        }
      },
      (path) => {
        if (path === '/auth/reauthenticate/options') return { methods: ['totp'], phone: null };
        if (path === '/auth/reauthenticate') {
          confirmed = true;
          return { authenticatedAt: LATER, sensitiveActionsUntil: LATER };
        }
        throw new Error(`unexpected ${path}`);
      },
    );
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/staff');

    await screen.findByText('Bilal');
    // The owner's own role is not theirs to change; a packer's is.
    expect(screen.queryByLabelText('Role of Sana')).toBeNull();
    expect(screen.getByLabelText('Role of Bilal')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'PACKER' } });
    type('Who it is for', 'Ali, for packing');
    await press('Make the invitation');
    await confirmIdentity('Code from your authenticator app', '123456');
    await press('Confirm');

    await screen.findByText('Send them this link. It works for 7 days, once.');
    expect(screen.getByText(`${window.location.origin}/invitation#token=hsi_abc`)).toBeTruthy();
    expect(core.sent.find((each) => each.operation === '/auth/reauthenticate')?.variables).toEqual({
      code: '123456',
    });
    const invites = core.sent.filter((each) => each.operation === 'StaffInvitationCreate');
    expect(invites).toHaveLength(2);
    expect(invites[1]?.variables).toEqual({
      role: 'PACKER',
      note: 'Ali, for packing',
      email: null,
      language: 'EN',
    });
  });

  it("opens an invitation's link signed in, and joins its shop", async () => {
    const core = fakeCore(
      'owner',
      () => ({}),
      (path) => {
        if (path === '/auth/invitations/preview') {
          return {
            invitation: {
              shop: { name: 'Zari' },
              role: 'packer',
              invitedBy: 'Sana',
              expiresAt: LATER,
            },
          };
        }
        if (path === '/auth/invitations/accept') {
          return { shop: { id: 'shop_1', name: 'Zari', role: 'packer', mfaRequired: false } };
        }
        throw new Error(`unexpected ${path}`);
      },
    );
    vi.stubGlobal('fetch', core.fetcher);
    window.history.replaceState(null, '', '/invitation#token=hsi_abc');
    const { router } = renderAdmin('/invitation#token=hsi_abc');

    await screen.findByText('Sana invited you to work in Zari as Packer.');
    await press('Join Zari');
    await waitFor(() => expect(router.state.location.pathname).toBe('/shop_1'));
    expect(
      core.sent.find((each) => each.operation === '/auth/invitations/accept')?.variables,
    ).toEqual({
      token: 'hsi_abc',
    });
  });
});
