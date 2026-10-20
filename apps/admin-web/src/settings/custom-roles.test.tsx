import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import {
  confirmIdentity,
  fakeCore,
  press,
  REAUTHENTICATE,
  renderAdmin,
  signedIn,
  type,
} from '../test-support';

const EARLIER = new Date(Date.now() - 30 * 86_400_000).toISOString();
const LATER = new Date(Date.now() + 7 * 86_400_000).toISOString();

const CATALOG = ['read_products', 'read_inventory', 'read_locations'];
const ALL = [
  'SEE_CUSTOMER_NUMBERS',
  'REVEAL_CUSTOMER_NUMBERS',
  'EXPORT_ORDERS',
  'MANAGE_EXPORT_SCHEDULES',
  'REFUND_ORDERS',
  'ASSIGN_ORDERS',
  'MODERATE_COMMENTS',
  'SEE_STAFF_PERFORMANCE',
  'RECONCILE_PAYMENTS',
  'CLAIM_FROM_COURIERS',
  'MANAGE_STAFF',
  'MANAGE_APPS',
  'SEE_BILLING',
  'SEE_VERIFICATION',
  'MANAGE_SUPPORT_ACCESS',
  'GIVE_ANY_DISCOUNT',
];
const MANAGING = [
  'write_products',
  'write_inventory',
  'write_locations',
  'write_orders',
  'write_customers',
  'write_settings',
];

/** The presets as the core gives them (ADR-578), the scopes of the owner's and manager's cut. */
const PRESETS = [
  { role: 'OWNER', scopes: MANAGING, capabilities: ALL, customizable: false },
  { role: 'MANAGER', scopes: MANAGING, capabilities: ALL, customizable: true },
  {
    role: 'CONFIRMATION_AGENT',
    scopes: [
      ...CATALOG,
      'write_orders',
      'read_customers',
      'read_store_credit_accounts',
      'read_gift_cards',
      'write_conversations',
    ],
    capabilities: ['REVEAL_CUSTOMER_NUMBERS'],
    customizable: true,
  },
  { role: 'PACKER', scopes: [...CATALOG, 'write_orders'], capabilities: [], customizable: true },
  {
    role: 'MARKETER',
    scopes: [...CATALOG, 'read_orders', 'read_customers', 'write_discounts'],
    capabilities: [],
    customizable: true,
  },
  {
    role: 'ACCOUNTANT',
    scopes: [...CATALOG, 'read_orders'],
    capabilities: ['EXPORT_ORDERS', 'RECONCILE_PAYMENTS', 'CLAIM_FROM_COURIERS'],
    customizable: true,
  },
];

const DESK = {
  id: 'role_1',
  name: 'Desk without numbers',
  basedOn: 'CONFIRMATION_AGENT',
  scopes: [...CATALOG, 'read_orders', 'write_conversations'],
  capabilities: [],
  staffMemberCount: 2,
  createdAt: EARLIER,
  updatedAt: EARLIER,
};
const SENIOR = {
  id: 'role_2',
  name: 'Senior manager',
  basedOn: 'MANAGER',
  scopes: MANAGING,
  capabilities: ['SEE_CUSTOMER_NUMBERS'],
  staffMemberCount: 1,
  createdAt: EARLIER,
  updatedAt: EARLIER,
};
const SPARE = {
  id: 'role_3',
  name: 'Spare packer',
  basedOn: 'PACKER',
  scopes: CATALOG,
  capabilities: [],
  staffMemberCount: 0,
  createdAt: EARLIER,
  updatedAt: EARLIER,
};

const ref = ({ id, name, basedOn }: { id: string; name: string; basedOn: string }) => ({
  id,
  name,
  basedOn,
});

const member = (id: string, name: string, role: string, customRole: object | null = null) => ({
  id,
  name,
  email: null,
  role,
  customRole,
  joinedAt: EARLIER,
  expiresAt: null,
});

/**
 * A fake core with the shop's staff and roles, answering custom roles' mutations with `answers`,
 * and asking the member to confirm who they are once where `confirmFirst` names the operation.
 */
function core(
  role: StaffRole,
  answers: Record<string, (variables: Record<string, unknown>) => unknown> = {},
  confirmFirst: string | null = null,
) {
  let confirmed = false;
  return fakeCore(
    role,
    (operation, variables) => {
      if (operation === confirmFirst && !confirmed) return REAUTHENTICATE;
      const answer = answers[operation];
      if (answer) return answer(variables);
      switch (operation) {
        case 'Staff':
          return {
            staffMembers: [
              member('usr_1', 'Sana', role === 'owner' ? 'OWNER' : 'MANAGER'),
              member('usr_2', 'Imran', 'MANAGER', ref(SENIOR)),
              member('usr_3', 'Hina', 'CONFIRMATION_AGENT', ref(DESK)),
              member('usr_9', 'Bilal', 'PACKER'),
            ],
            staffInvitations: [
              {
                id: 'inv_1',
                role: 'CONFIRMATION_AGENT',
                customRole: ref(DESK),
                note: 'Asad, for the desk',
                email: null,
                invitedBy: 'Sana',
                expiresAt: LATER,
                accessDays: null,
              },
            ],
          };
        case 'CustomRoles':
          return { customRoles: [DESK, SENIOR, SPARE], rolePresets: PRESETS };
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

const checkbox = (name: string) => screen.getByRole<HTMLInputElement>('checkbox', { name });

async function openRoles() {
  fireEvent.click(await screen.findByRole('tab', { name: 'Roles' }));
  return screen.findByRole('region', { name: 'Your roles' });
}

describe("Staff: the shop's own roles (ADR-578)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the roles, and makes one narrowed from the preset it is based on', async () => {
    const fake = core('owner', {
      CustomRoleCreate: (variables) => ({
        customRoleCreate: {
          customRole: {
            ...DESK,
            id: 'role_4',
            ...(variables.input as object),
            staffMemberCount: 0,
          },
          userErrors: [],
        },
      }),
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/staff');

    const roles = await openRoles();
    expect(within(roles).getByText('Desk without numbers')).toBeTruthy();
    expect(within(roles).getByText('Based on Confirmation agent · 2 members')).toBeTruthy();
    expect(within(roles).getByText('Based on Packer · 0 members')).toBeTruthy();
    expect(within(roles).getByText('Based on Manager · 1 member')).toBeTruthy();

    await press('New role');
    const basedOn = screen.getByLabelText<HTMLSelectElement>('Based on');
    // The owner's preset makes no role; the rest do.
    expect([...basedOn.options].map((option) => option.value)).toEqual([
      'MANAGER',
      'CONFIRMATION_AGENT',
      'PACKER',
      'MARKETER',
      'ACCOUNTANT',
    ]);
    // Everything a manager has, ticked to begin with.
    expect(checkbox('Refund orders').checked).toBe(true);
    expect(checkbox('Settings: Edit').checked).toBe(true);
    fireEvent.click(checkbox('Refund orders'));

    // Another preset starts again from all it has, and offers nothing beyond it.
    fireEvent.change(basedOn, { target: { value: 'CONFIRMATION_AGENT' } });
    expect(screen.queryByRole('checkbox', { name: 'Refund orders' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Customers: Edit' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Settings: View' })).toBeNull();
    expect(checkbox('Reveal one number at a time, noted in the activity log').checked).toBe(true);
    expect(checkbox('Orders: Edit').checked).toBe(true);
    expect(checkbox('Orders: View').checked).toBe(true);
    expect(checkbox('Customers: View').checked).toBe(true);

    type('Name', ' Desk, no numbers ');
    fireEvent.click(checkbox('Reveal one number at a time, noted in the activity log'));
    // Unticking edit keeps the view of what the preset edits.
    fireEvent.click(checkbox('Orders: Edit'));
    expect(checkbox('Orders: View').checked).toBe(true);
    fireEvent.click(checkbox('Customers: View'));
    await press('Make the role');

    expect(await screen.findByText('The role Desk, no numbers is saved.')).toBeTruthy();
    expect(sentOf(fake, 'CustomRoleCreate')).toEqual([
      {
        input: {
          name: 'Desk, no numbers',
          basedOn: 'CONFIRMATION_AGENT',
          scopes: [
            'read_products',
            'read_inventory',
            'read_locations',
            'read_orders',
            'read_store_credit_accounts',
            'read_gift_cards',
            'write_conversations',
          ],
          capabilities: [],
        },
      },
    ]);
  });

  it("shows the core's refusals by the field they are about", async () => {
    const fake = core('owner', {
      CustomRoleCreate: () => ({
        customRoleCreate: {
          customRole: null,
          userErrors: [
            {
              field: ['input', 'name'],
              code: 'TAKEN',
              message: 'Another role of the shop is called Desk without numbers',
            },
            {
              field: ['input', 'scopes', '3'],
              code: 'INVALID',
              message: 'Not within the preset',
            },
          ],
        },
      }),
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/staff');

    await openRoles();
    await press('New role');
    fireEvent.change(screen.getByLabelText('Based on'), { target: { value: 'PACKER' } });
    // A packer's preset holds no capabilities to choose from.
    expect(
      screen.getByText('Packer has no permissions to choose from beyond the areas below.'),
    ).toBeTruthy();
    type('Name', 'Desk without numbers');
    await press('Make the role');

    expect(
      await screen.findByText('Another role of the shop is called Desk without numbers'),
    ).toBeTruthy();
    expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Orders: Edit: Not within the preset')).toBeTruthy();
    // Still open, to put right.
    expect(screen.getByRole('button', { name: 'Make the role' })).toBeTruthy();
  });

  it('changes a role once the member confirms who they are, its preset kept', async () => {
    const fake = core(
      'owner',
      {
        CustomRoleUpdate: (variables) => ({
          customRoleUpdate: {
            customRole: { ...DESK, ...(variables.input as object) },
            userErrors: [],
          },
        }),
      },
      'CustomRoleUpdate',
    );
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/staff');

    await openRoles();
    await press('Change Desk without numbers');
    expect(screen.getByLabelText<HTMLSelectElement>('Based on').disabled).toBe(true);
    expect(screen.getByText('A role stays based on the preset it was made from.')).toBeTruthy();
    // What the role holds, of all its preset offers.
    expect(checkbox('Orders: View').checked).toBe(true);
    expect(checkbox('Orders: Edit').checked).toBe(false);
    expect(checkbox('Customers: View').checked).toBe(false);
    expect(checkbox('Reveal one number at a time, noted in the activity log').checked).toBe(false);

    type('Name', 'Desk');
    fireEvent.click(checkbox('Orders: Edit'));
    fireEvent.click(checkbox('Reveal one number at a time, noted in the activity log'));
    await press('Save');
    await confirmIdentity('Code from your authenticator app', '123456');
    await press('Confirm');

    expect(await screen.findByText('The role Desk is saved.')).toBeTruthy();
    const updates = sentOf(fake, 'CustomRoleUpdate');
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual({
      id: 'role_1',
      input: {
        name: 'Desk',
        scopes: [...CATALOG, 'write_orders', 'write_conversations'],
        capabilities: ['REVEAL_CUSTOMER_NUMBERS'],
      },
    });
  });

  it('says why a role someone holds is not deleted, and deletes one nobody does', async () => {
    const fake = core('owner', {
      CustomRoleDelete: (variables) =>
        variables.id === 'role_1'
          ? {
              customRoleDelete: {
                deletedCustomRoleId: null,
                userErrors: [
                  {
                    field: ['id'],
                    code: 'IN_USE',
                    message:
                      '2 members of staff and 1 invitation have this role: give them another first',
                  },
                ],
              },
            }
          : { customRoleDelete: { deletedCustomRoleId: 'role_3', userErrors: [] } },
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/staff');

    const roles = await openRoles();
    await press('Delete Desk without numbers');
    expect(within(roles).getByText('Delete the role Desk without numbers?')).toBeTruthy();
    await press('Delete');
    expect(
      await screen.findByText(
        '2 members of staff and 1 invitation have this role: give them another first',
      ),
    ).toBeTruthy();

    await press('Delete Spare packer');
    await press('Delete');
    expect(await screen.findByText('The role Spare packer is deleted.')).toBeTruthy();
    expect(sentOf(fake, 'CustomRoleDelete')).toEqual([{ id: 'role_1' }, { id: 'role_3' }]);
  });

  it("invites someone in a role of the shop's own, by its ID alone", async () => {
    const fake = core('owner', {
      StaffInvitationCreate: () => ({
        staffInvitationCreate: {
          token: 'hsi_abc',
          emailed: false,
          invitation: { id: 'inv_2' },
          userErrors: [],
        },
      }),
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/staff');

    await screen.findByText('Bilal');
    const select = screen.getByLabelText<HTMLSelectElement>('Role');
    await within(select).findByRole('group', { name: 'Your roles' });
    expect(
      within(within(select).getByRole('group', { name: 'Presets' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Manager', 'Confirmation agent', 'Packer', 'Marketer', 'Accountant']);
    expect(
      within(within(select).getByRole('group', { name: 'Your roles' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Desk without numbers', 'Senior manager', 'Spare packer']);

    fireEvent.change(select, { target: { value: 'role_1' } });
    expect(screen.getByText('A role of your own, based on Confirmation agent.')).toBeTruthy();
    await press('Make the invitation');
    await screen.findByText('Send them this link. It works for 7 days, once.');
    expect(sentOf(fake, 'StaffInvitationCreate')).toEqual([
      { customRoleId: 'role_1', note: null, email: null, language: 'EN', accessDays: null },
    ]);
  });

  it("gives a member a role of the shop's own, and shows whose role is one", async () => {
    const fake = core('owner', {
      StaffMemberRoleUpdate: () => ({
        staffMemberRoleUpdate: {
          staffMember: { id: 'usr_9', role: 'PACKER', customRole: { id: 'role_3' } },
          userErrors: [],
        },
      }),
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/staff');

    await screen.findByText('Bilal');
    await within(screen.getByLabelText('Role of Bilal')).findByRole('group', {
      name: 'Your roles',
    });
    // A member in a custom role has it chosen.
    expect(screen.getByLabelText<HTMLSelectElement>('Role of Hina').value).toBe('role_1');
    // An invitation names its custom role, and the preset it is based on quietly.
    expect(screen.getByText('(based on Confirmation agent)')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Role of Bilal'), { target: { value: 'role_3' } });
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>('Role of Hina').disabled).toBe(false),
    );
    fireEvent.change(screen.getByLabelText('Role of Hina'), {
      target: { value: 'CONFIRMATION_AGENT' },
    });
    await waitFor(() => expect(sentOf(fake, 'StaffMemberRoleUpdate')).toHaveLength(2));
    expect(sentOf(fake, 'StaffMemberRoleUpdate')).toEqual([
      { id: 'usr_9', customRoleId: 'role_3' },
      { id: 'usr_3', role: 'CONFIRMATION_AGENT' },
    ]);
  });

  it("gives a manager the roles below theirs alone, and others' by name", async () => {
    vi.stubGlobal('fetch', core('manager').fetcher);
    renderAdmin('/shop_1/settings/staff');

    await screen.findByText('Bilal');
    // A fellow manager's custom role is shown, not changed.
    expect(screen.queryByLabelText('Role of Imran')).toBeNull();
    expect(screen.getByText('Senior manager')).toBeTruthy();
    expect(screen.getByText('(based on Manager)', { exact: false })).toBeTruthy();
    await within(screen.getByLabelText('Role')).findByRole('group', { name: 'Your roles' });
    expect(
      within(within(screen.getByLabelText('Role')).getByRole('group', { name: 'Your roles' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Desk without numbers', 'Spare packer']);

    const roles = await openRoles();
    expect(within(roles).getByText('Senior manager')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change Senior manager' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Senior manager' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Change Desk without numbers' })).toBeTruthy();
    await press('New role');
    expect(
      [...screen.getByLabelText<HTMLSelectElement>('Based on').options].map(
        (option) => option.value,
      ),
    ).toEqual(['CONFIRMATION_AGENT', 'PACKER', 'MARKETER', 'ACCOUNTANT']);
  });

  it('shows roles to those who manage staff alone', async () => {
    const fake = core('packer');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/staff');

    await screen.findByText('Bilal');
    expect(screen.queryByRole('tab', { name: 'Roles' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Invite someone' })).toBeNull();
    // Members still show their custom role by name.
    expect(screen.getAllByText('Desk without numbers').length).toBeGreaterThan(0);
    expect(fake.sent.some((each) => each.operation === 'CustomRoles')).toBe(false);
  });
});
