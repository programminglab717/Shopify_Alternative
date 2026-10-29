import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const SUBSCRIPTION = {
  id: 'osub_1',
  status: 'ACTIVE',
  planName: 'Every month',
  interval: 'Every month',
  discountPercent: 10,
  nextOrderOn: '2026-11-28',
  ordersPlaced: 2,
  name: 'Ayesha Khan',
  city: 'Lahore',
  lastError: 'Kashmiri chai is sold out',
  lastOrderId: 'order_2',
};

function core(role: StaffRole = 'owner') {
  let plans: Record<string, unknown>[] = [];
  let subscription = SUBSCRIPTION;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Subscriptions':
        return { sellingPlans: plans, orderSubscriptions: [subscription] };
      case 'SellingPlanCreate': {
        const input = variables.input as Record<string, unknown>;
        if (Number(input.discountPercent) > 50) {
          return {
            sellingPlanCreate: {
              sellingPlan: null,
              userErrors: [
                {
                  field: ['input', 'discountPercent'],
                  code: 'INVALID',
                  message: 'Discount percent must be a whole number from 0 to 50',
                },
              ],
            },
          };
        }
        const made = { ...input, id: 'slpl_1' };
        plans = [made];
        return { sellingPlanCreate: { sellingPlan: made, userErrors: [] } };
      }
      case 'SellingPlanDelete':
        plans = [];
        return { sellingPlanDelete: { deletedSellingPlanId: variables.id, userErrors: [] } };
      case 'OrderSubscriptionChange':
        subscription = {
          ...subscription,
          status: variables.change === 'PAUSE' ? 'PAUSED' : 'ACTIVE',
        };
        return { orderSubscriptionChange: { subscription, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Subscriptions (CAT-16, ADR-862)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('adds a selling plan for a tag, and pauses and resumes a customer’s subscription', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Subscriptions/ }));
    expect(await screen.findByText(/No selling plans yet/)).toBeTruthy();
    type('Discount (%)', '60');
    fireEvent.click(screen.getByRole('button', { name: 'Add plan' }));
    expect(await screen.findByText(/must be a whole number from 0 to 50/)).toBeTruthy();
    type('Discount (%)', '10');
    type('Product tag', 'chai');
    // At least three orders before customers can cancel (ADR-928).
    type('Orders before customers can cancel', '3');
    fireEvent.click(screen.getByRole('button', { name: 'Add plan' }));
    expect(await screen.findByText('Every month, 10% off')).toBeTruthy();
    expect(screen.getByText('For products tagged chai · at least 3 orders')).toBeTruthy();
    expect(sentOf(fake, 'SellingPlanCreate').at(-1)).toEqual({
      input: {
        name: 'Every month',
        intervalUnit: 'MONTH',
        intervalCount: 1,
        discountPercent: 10,
        productTag: 'chai',
        minimumOrders: 3,
      },
    });

    expect(screen.getByText('Ayesha Khan, Lahore')).toBeTruthy();
    expect(screen.getByText(/Every month, 10% off · 2 orders · next on 2026-11-28/)).toBeTruthy();
    expect(
      screen.getByText("Its last order couldn't be placed: Kashmiri chai is sold out"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(sentOf(fake, 'OrderSubscriptionChange')).toEqual([
        { id: 'osub_1', change: 'PAUSE' },
        { id: 'osub_1', change: 'RESUME' },
      ]),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Every month' }));
    expect(await screen.findByText(/No selling plans yet/)).toBeTruthy();
  });

  it('shows an accountant no plans to add and no subscriptions to change', async () => {
    vi.stubGlobal('fetch', core('accountant').fetcher);
    renderAdmin('/shop_1/settings/subscriptions');
    expect(await screen.findByText('Ayesha Khan, Lahore')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });
});
