import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, REAUTHENTICATE, renderAdmin, signedIn } from '../test-support';

const EARLIER = new Date(Date.now() - 30 * 86_400_000).toISOString();
const LATER = new Date(Date.now() + 7 * 86_400_000).toISOString();

const member = (id: string, name: string, role: string) => ({
  id,
  name,
  email: null,
  role,
  joinedAt: EARLIER,
});

const invitation = (id: string, note: string, email: string | null) => ({
  id,
  note,
  email,
  role: 'PACKER',
  createdAt: EARLIER,
  expiresAt: LATER,
  invitedBy: 'Sana',
});

/** A fake core with the shop's staff, asking the member to confirm who they are once. */
function core(role: StaffRole, managers: { id: string; name: string }[]) {
  let confirmed = false;
  return fakeCore(
    role,
    (operation, variables) => {
      switch (operation) {
        case 'Staff':
          return {
            staffMembers: [
              member('usr_1', 'Sana', role === 'owner' ? 'OWNER' : 'MANAGER'),
              ...managers.map((each) => member(each.id, each.name, 'MANAGER')),
              member('usr_9', 'Bilal', 'PACKER'),
            ],
            staffInvitations: [
              invitation('inv_1', 'Hina, for the desk', 'hina@zari.pk'),
              invitation('inv_2', 'Asad, for packing', null),
            ],
          };
        case 'StaffInvitationResend':
          if (!confirmed) return REAUTHENTICATE;
          return {
            staffInvitationResend: {
              token: 'hsi_new',
              emailed: true,
              invitation: { id: 'inv_3' },
              userErrors: [],
            },
          };
        case 'ShopOwnershipTransfer':
          if (!confirmed) return REAUTHENTICATE;
          if (variables.staffMemberId === 'usr_3') {
            return {
              shopOwnershipTransfer: {
                owner: null,
                userErrors: [
                  {
                    field: ['staffMemberId'],
                    code: 'MFA_REQUIRED',
                    message: 'Asma needs a passkey or an authenticator app first',
                  },
                ],
              },
            };
          }
          return {
            shopOwnershipTransfer: { owner: { id: 'usr_2', name: 'Imran' }, userErrors: [] },
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
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Staff: invitations sent again, and the shop handed over', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends an emailed invitation again once the member confirms who they are', async () => {
    const fake = core('manager', []);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/staff');

    await screen.findByText('Hina, for the desk');
    // An invitation shared by its link alone has no address to send it to again.
    expect(screen.getAllByRole('button', { name: /^Send the invitation to/ })).toHaveLength(1);
    fireEvent.click(
      screen.getByRole('button', { name: 'Send the invitation to hina@zari.pk again' }),
    );
    fireEvent.change(await screen.findByLabelText('Code from your authenticator app'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText(/hina@zari\.pk/, { selector: 'p' })).toBeTruthy();
    expect(screen.getByText(/#token=hsi_new$/)).toBeTruthy();
    expect(sentOf(fake, 'StaffInvitationResend').at(-1)).toEqual({ id: 'inv_1', language: 'EN' });
    // Only the owner hands the shop over.
    expect(screen.queryByRole('heading', { name: 'Hand the shop over' })).toBeNull();
  });

  it('hands the shop to a manager once asked, after a refusal named', async () => {
    const fake = core('owner', [
      { id: 'usr_2', name: 'Imran' },
      { id: 'usr_3', name: 'Asma' },
    ]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/staff');

    const section = await screen.findByRole('region', { name: 'Hand the shop over' });
    fireEvent.change(within(section).getByLabelText('To'), { target: { value: 'usr_3' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Hand it to Asma' }));
    expect(
      within(section).getByText('Hand the shop to Asma? Only they can hand it back.'),
    ).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Hand it over' }));
    // Handing over is sensitive: confirmed like an invitation, it goes once asked.
    fireEvent.change(await screen.findByLabelText('Code from your authenticator app'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(
      await within(section).findByText('Asma needs a passkey or an authenticator app first'),
    ).toBeTruthy();

    fireEvent.change(within(section).getByLabelText('To'), { target: { value: 'usr_2' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Hand it to Imran' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Hand it over' }));
    expect(await screen.findByText('Imran owns the shop now. You are a manager.')).toBeTruthy();
    // The first, refused until the owner confirmed who they are, went again once they had.
    expect(sentOf(fake, 'ShopOwnershipTransfer')).toEqual([
      { staffMemberId: 'usr_3' },
      { staffMemberId: 'usr_3' },
      { staffMemberId: 'usr_2' },
    ]);
  });

  it('asks the owner to make someone a manager first', async () => {
    vi.stubGlobal('fetch', core('owner', []).fetcher);
    renderAdmin('/shop_1/settings/staff');
    expect(
      await screen.findByText('Make someone a manager first: the shop is handed to a manager.'),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Hand it to/ })).toBeNull());
  });
});
