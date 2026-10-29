import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });

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
        // The core says its chosen variants' titles (ADR-930).
        const titles: Record<string, string> = { var_2: 'Lawn suit · Large' };
        const { variantIds, ...rest } = input as { variantIds: string[] | null };
        const made = {
          ...rest,
          id: 'slpl_1',
          variants: variantIds && variantIds.map((id) => ({ id, title: titles[id] })),
        };
        plans = [made];
        return { sellingPlanCreate: { sellingPlan: made, userErrors: [] } };
      }
      case 'DraftVariants':
        return {
          products: {
            nodes: [
              {
                id: 'prod_1',
                title: 'Lawn suit',
                variants: [
                  {
                    id: 'var_1',
                    title: 'Small',
                    availableForSale: true,
                    inventoryQuantity: 8,
                    price: pkr('4500.00'),
                  },
                  {
                    id: 'var_2',
                    title: 'Large',
                    availableForSale: true,
                    inventoryQuantity: 3,
                    price: pkr('4800.00'),
                  },
                ],
              },
            ],
          },
        };
      case 'SellingPlanUpdate': {
        const titles: Record<string, string> = { var_1: 'Lawn suit · Small' };
        const { variantIds, ...rest } = variables.input as { variantIds: string[] | null };
        const changed = {
          ...rest,
          id: variables.id,
          variants: variantIds && variantIds.map((id) => ({ id, title: titles[id] })),
        };
        plans = plans.map((each) => (each.id === variables.id ? changed : each));
        return { sellingPlanUpdate: { sellingPlan: changed, userErrors: [] } };
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
        variantIds: null,
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

  it('adds a selling plan for chosen variants alone (ADR-930)', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/subscriptions');
    expect(await screen.findByText(/No selling plans yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose variants' }));
    type('Find products by name or SKU', 'lawn');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Lawn suit · Large' }));
    // Chosen variants, the plan is for no tag.
    expect(screen.getByRole('button', { name: 'Remove Lawn suit · Large' })).toBeTruthy();
    expect(screen.queryByLabelText('Product tag')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add plan' }));
    expect(await screen.findByText('For Lawn suit · Large')).toBeTruthy();
    expect(sentOf(fake, 'SellingPlanCreate')).toEqual([
      {
        input: {
          name: 'Every month',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          discountPercent: 10,
          productTag: null,
          minimumOrders: 0,
          variantIds: ['var_2'],
        },
      },
    ]);
    // The form is cleared for the next plan.
    expect(screen.getByLabelText('Product tag')).toBeTruthy();
  });

  it('shows an accountant no plans to add and no subscriptions to change', async () => {
    vi.stubGlobal('fetch', core('accountant').fetcher);
    renderAdmin('/shop_1/settings/subscriptions');
    expect(await screen.findByText('Ayesha Khan, Lahore')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it("changes a plan, its variants among the rest, from the plan's own form (ADR-936)", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/subscriptions');
    expect(await screen.findByText(/No selling plans yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose variants' }));
    type('Find products by name or SKU', 'lawn');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Lawn suit · Large' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add plan' }));
    expect(await screen.findByText('For Lawn suit · Large')).toBeTruthy();

    // Changed: the form takes the plan as it is, and saves it with another variant.
    fireEvent.click(screen.getByRole('button', { name: 'Change Every month' }));
    expect((screen.getByLabelText('Discount (%)') as HTMLInputElement).value).toBe('10');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Lawn suit · Large' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose variants' }));
    type('Find products by name or SKU', 'lawn');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Lawn suit · Small' }));
    type('Discount (%)', '15');
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
    expect(await screen.findByText('For Lawn suit · Small')).toBeTruthy();
    expect(sentOf(fake, 'SellingPlanUpdate')).toEqual([
      {
        id: 'slpl_1',
        input: {
          name: 'Every month',
          intervalUnit: 'MONTH',
          intervalCount: 1,
          discountPercent: 15,
          productTag: null,
          minimumOrders: 0,
          variantIds: ['var_1'],
        },
      },
    ]);
    // The form adds a new plan again.
    expect(screen.getByRole('button', { name: 'Add plan' })).toBeTruthy();
  });
});
