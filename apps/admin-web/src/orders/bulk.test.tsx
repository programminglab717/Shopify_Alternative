import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, press, renderAdmin, signedIn, type } from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const listed = (id: string, name: string, stage: string) => ({
  id,
  name,
  createdAt: LATER,
  stage,
  paymentMethod: 'CASH_ON_DELIVERY',
  overPlanLimit: false,
  totalPrice: rupees('2700'),
  customer: { displayName: 'Ayesha Khan' },
  shippingAddress: { name: 'Ayesha Khan', city: 'Lahore' },
  risk: { level: 'LOW' },
  lineItems: [{ quantity: 1 }],
});

function core(role: StaffRole) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Orders': {
        const stage = (variables.stage as string | null) ?? 'TO_PACK';
        return {
          orders: {
            nodes: [listed('ord_1', '#1011', stage), listed('ord_2', '#1012', stage)],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          orderStageCounts: [],
        };
      }
      case 'OrderBulkAddTags':
        return { orderBulkAddTags: { orders: [{ id: 'ord_1' }, { id: 'ord_2' }], userErrors: [] } };
      case 'OrderBulkRemoveTags':
        return { orderBulkRemoveTags: { orders: [{ id: 'ord_1' }], userErrors: [] } };
      case 'OrderBulkCancel':
        return {
          orderBulkCancel: {
            orders: [{ id: 'ord_1' }],
            userErrors: [
              {
                field: ['ids', '1'],
                code: 'INVALID',
                message: 'A fulfilled order can’t be cancelled',
              },
            ],
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Orders tagged and cancelled many at once', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('tags the orders chosen on any tab, and takes tags off them', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders');

    await screen.findByText('#1011');
    fireEvent.click(screen.getByLabelText('Select all shown'));
    // Nothing to cancel on every tab: the orders of all of them may have shipped.
    expect(screen.queryByRole('button', { name: 'Cancel 2' })).toBeNull();
    await press('Tag 2');
    expect(screen.getByRole('heading', { name: 'Tag 2 orders' })).toBeTruthy();
    type('Tags', ' eid, wholesale,, eid ');
    await press('Add the tags');
    await screen.findByText('2 orders updated.');
    expect(sentOf(fake, 'OrderBulkAddTags')).toEqual([
      { ids: ['ord_1', 'ord_2'], tags: ['eid', 'wholesale'] },
    ]);

    fireEvent.click(screen.getByLabelText('Select #1011'));
    await press('Tag 1');
    type('Tags', 'eid');
    await press('Take the tags off');
    await screen.findByText('1 order updated.');
    expect(sentOf(fake, 'OrderBulkRemoveTags')).toEqual([{ ids: ['ord_1'], tags: ['eid'] }]);
  });

  it('cancels the orders chosen for a reason, one refused named', async () => {
    const fake = core('confirmation_agent');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders?stage=TO_PACK');

    await screen.findByText('#1011');
    fireEvent.click(screen.getByLabelText('Select all shown'));
    await press('Cancel 2');
    expect(screen.getByRole('heading', { name: 'Cancel 2 orders?' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Out of stock'));
    type('Note', ' Lawn sold out ');
    await press('Cancel 2 orders');

    await screen.findByText('1 order updated.');
    expect(screen.getByText('#1012: A fulfilled order can’t be cancelled')).toBeTruthy();
    expect(sentOf(fake, 'OrderBulkCancel')).toEqual([
      { ids: ['ord_1', 'ord_2'], reason: 'INVENTORY', staffNote: 'Lawn sold out' },
    ]);
  });

  it('keeps tags and cancelling to those who change orders', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/orders?stage=TO_PACK');

    await screen.findByText('#1011');
    fireEvent.click(screen.getByLabelText('Select all shown'));
    expect(screen.getByRole('button', { name: 'Print 2' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tag 2' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel 2' })).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', core('accountant').fetcher);
    renderAdmin('/shop_1/orders');
    await screen.findByText('#1011');
    expect(screen.queryByLabelText('Select all shown')).toBeNull();
  });
});
