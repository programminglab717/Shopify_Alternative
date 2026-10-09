import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const ENTRIES = [
  {
    id: 'blk_1',
    phone: '+923001234567',
    reason: 'FAKE_ORDERS',
    note: 'Three orders refused in a week',
    createdAt: '2026-10-08T20:00:00Z',
    customer: { id: 'cus_1', displayName: 'Bilal Ahmed' },
  },
  {
    id: 'blk_2',
    phone: '+923217654321',
    reason: 'FRAUD',
    note: '',
    createdAt: '2026-10-01T09:00:00Z',
    customer: null,
  },
];

function core(role: StaffRole = 'owner') {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Blocklist': {
        const query = variables.query as string | null;
        return {
          blocklist: {
            nodes: query ? ENTRIES.filter((entry) => entry.phone.endsWith(query)) : ENTRIES,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      case 'BlocklistRemove':
        return { blocklistRemove: { deletedBlocklistEntryId: 'blk_1', userErrors: [] } };
      case 'BlocklistAdd': {
        const { phone } = variables.input as { phone: string };
        return {
          blocklistAdd:
            phone.replace(/\D/g, '').length < 11
              ? {
                  blocklistEntry: null,
                  userErrors: [
                    {
                      field: ['input', 'phone'],
                      code: 'INVALID',
                      message: 'is not a mobile number',
                    },
                  ],
                }
              : { blocklistEntry: { id: 'blk_3' }, userErrors: [] },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("The shop's blocked numbers", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists each number with why and since when, its customer linked, and unblocks one', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/customers/blocked');

    await screen.findByText('0300 1234567');
    // Blocked at 1 am on 9 October in Karachi.
    expect(screen.getByText('Fake orders, since 9 Oct 2026')).toBeTruthy();
    expect(screen.getByText('“Three orders refused in a week”')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Bilal Ahmed' }).getAttribute('href')).toBe(
      '/shop_1/customers/cus_1',
    );
    expect(screen.getByText('Fraud, since 1 Oct 2026')).toBeTruthy();

    await press('Unblock 0300 1234567');
    await screen.findByText('0300 1234567 is no longer blocked. Orders already held stay held.');
    expect(sentOf(fake, 'BlocklistRemove')).toEqual([{ phone: '+923001234567' }]);
  });

  it('blocks a number before it ever orders, a refusal said', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/customers/blocked');

    await screen.findByText('0300 1234567');
    await press('Block a number');
    type('Mobile number', '0321 76');
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'FRAUD' } });
    type('Note', ' Sent a fake receipt ');
    await press('Block');
    expect(await screen.findByText('is not a mobile number')).toBeTruthy();

    type('Mobile number', '0321 7650000');
    await press('Block');
    await screen.findByText('0321 7650000 is blocked. Its new orders wait for your review.');
    expect(sentOf(fake, 'BlocklistAdd').at(-1)).toEqual({
      input: { phone: '0321 7650000', reason: 'FRAUD', note: 'Sent a fake receipt' },
    });
    expect(screen.queryByLabelText('Mobile number')).toBeNull();
  });

  it('finds a number by its last digits, and says when none matches', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/customers/blocked');

    await screen.findByText('0300 1234567');
    const search = screen.getByRole('searchbox', { name: 'Find a number' });
    fireEvent.change(search, { target: { value: '4321' } });
    fireEvent.submit(search);
    await screen.findByText('0321 7654321');
    expect(screen.queryByText('0300 1234567')).toBeNull();
    expect(sentOf(fake, 'Blocklist').at(-1)).toMatchObject({ query: '4321' });

    fireEvent.change(search, { target: { value: '9999' } });
    fireEvent.submit(search);
    expect(await screen.findByText('No blocked number matches.')).toBeTruthy();
  });

  it('keeps the blocked numbers to owners and managers', async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/customers/blocked');

    expect(
      await screen.findByText("Only owners and managers keep the shop's blocked numbers."),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Block a number' })).toBeNull();
    expect(sentOf(fake, 'Blocklist')).toEqual([]);
  });
});
