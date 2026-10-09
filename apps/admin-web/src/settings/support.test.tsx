import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, REAUTHENTICATE, renderAdmin, signedIn, type } from '../test-support';

const EARLIER = new Date(Date.now() - 3 * 86_400_000).toISOString();

const PAST = {
  id: 'sag_1',
  open: false,
  note: 'Courier booking failed',
  grantedBy: 'Sana Malik',
  createdAt: EARLIER,
  expiresAt: EARLIER,
  endedAt: EARLIER,
  endedBy: 'Bilal Ahmed',
};

function core(role: StaffRole, openAtFirst = false) {
  let confirmed = false;
  let open: Record<string, unknown> | null = openAtFirst
    ? { ...PAST, id: 'sag_2', open: true, endedAt: null, endedBy: null, expiresAt: LATER }
    : null;
  return fakeCore(
    role,
    (operation, variables) => {
      switch (operation) {
        case 'SupportAccess':
          return { supportAccess: open, supportAccessGrants: open ? [open, PAST] : [PAST] };
        case 'SupportAccessGrant':
          if (!confirmed) return REAUTHENTICATE;
          open = {
            id: 'sag_3',
            open: true,
            note: variables.note,
            grantedBy: 'Sana Malik',
            createdAt: new Date().toISOString(),
            expiresAt: LATER,
            endedAt: null,
            endedBy: null,
          };
          return { supportAccessGrant: { grant: open, userErrors: [] } };
        case 'SupportAccessEnd':
          open = null;
          return { supportAccessEnd: { grant: { id: 'sag_3' }, userErrors: [] } };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    },
    (path) => {
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

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("Hatti's support's access to the shop", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lets support look for a while once the owner confirms who they are, and ends it', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Support access/ }));
    expect(await screen.findByText('Support cannot look at the shop now.')).toBeTruthy();
    const history = screen.getByRole('region', { name: 'Each time support was let in' });
    expect(within(history).getByText('Courier booking failed')).toBeTruthy();
    expect(within(history).getByText(/^Ended by Bilal Ahmed, /)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('How long'), { target: { value: '240' } });
    type('What it is for', "Order #1043 won't ship");
    fireEvent.click(screen.getByRole('button', { name: 'Let support look' }));
    await screen.findByText('Confirm it is you');
    type('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    expect(
      await screen.findByText(/^Support may look at the shop until .*, as Sana Malik allowed\./),
    ).toBeTruthy();
    expect(sentOf(fake, 'SupportAccessGrant')).toEqual([
      { minutes: 240, note: "Order #1043 won't ship" },
      { minutes: 240, note: "Order #1043 won't ship" },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'End it now' }));
    expect(await screen.findByText('Support cannot look at the shop now.')).toBeTruthy();
    expect(sentOf(fake, 'SupportAccessEnd')).toEqual([{}]);
  });

  it('leaves letting support in to the owner, while a manager may end it', async () => {
    const fake = core('manager', true);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/support');

    fireEvent.click(await screen.findByRole('button', { name: 'End it now' }));
    expect(await screen.findByText('Only the owner lets support in.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Let support look' })).toBeNull();
    await waitFor(() => expect(sentOf(fake, 'SupportAccessEnd')).toEqual([{}]));
  });
});
