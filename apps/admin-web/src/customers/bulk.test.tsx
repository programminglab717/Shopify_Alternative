import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

function customer(id: string, displayName: string, phone: string) {
  return {
    id,
    displayName,
    phone,
    numberOfOrders: 2,
    lastOrderAt: null,
    tags: [],
    amountSpent: { amount: '5400.00', currencyCode: 'PKR' },
    blocklistEntry: null,
  };
}

/** A fake core with three customers, which refuses Sana as having too many tags. */
function customersCore(role: StaffRole) {
  const done = (ids: string[]) => ids.filter((id) => id !== 'cus_3').map((id) => ({ id }));
  const refused = (ids: string[]) =>
    ids.includes('cus_3')
      ? [
          {
            field: ['ids', String(ids.indexOf('cus_3'))],
            code: 'TOO_MANY',
            message: 'Tags can have at most 250',
          },
        ]
      : [];
  return fakeCore(role, (operation, variables) => {
    const ids = variables.ids as string[];
    switch (operation) {
      case 'Customers':
        return {
          customers: {
            nodes: [
              customer('cus_1', 'Ayesha Khan', '+923001234567'),
              customer('cus_2', 'Bilal Ahmed', '+923211234567'),
              customer('cus_3', 'Sana Malik', '+923331234567'),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      case 'CustomerBulkAddTags':
        return { customerBulkAddTags: { customers: done(ids), userErrors: refused(ids) } };
      case 'CustomerBulkRemoveTags':
        return { customerBulkRemoveTags: { customers: ids.map((id) => ({ id })), userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (core: ReturnType<typeof customersCore>, operation: string) =>
  core.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Customers tagged many at once, in the admin (CUS-01)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('tags the customers chosen and takes tags off, saying those refused by name', async () => {
    const core = customersCore('manager');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/customers');

    await screen.findByText('Ayesha Khan');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    await press('Tag 3');
    expect(screen.getByRole('heading', { name: 'Tag 3 customers' })).toBeTruthy();
    type('Tags', 'wholesale, VIP');
    await press('Add the tags');
    await screen.findByText('2 customers updated.');
    expect(screen.getByText('Sana Malik: Tags can have at most 250')).toBeTruthy();
    expect(sentOf(core, 'CustomerBulkAddTags')).toEqual([
      { ids: ['cus_1', 'cus_2', 'cus_3'], tags: ['wholesale', 'VIP'] },
    ]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Bilal Ahmed' }));
    await press('Tag 1');
    type('Tags', 'vip');
    await press('Take the tags off');
    await screen.findByText('1 customer updated.');
    expect(sentOf(core, 'CustomerBulkRemoveTags')).toEqual([{ ids: ['cus_2'], tags: ['vip'] }]);
  });

  it('is for owners and managers alone', async () => {
    vi.stubGlobal('fetch', customersCore('marketer').fetcher);
    renderAdmin('/shop_1/customers');
    await screen.findByText('Ayesha Khan');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
