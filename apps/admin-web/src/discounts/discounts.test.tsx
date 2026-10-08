import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscountCodeValue } from '../api/types';
import { sectionsOf } from '../shell/shell';
import { fakeCore, LATER, press, renderAdmin, signedIn, type } from '../test-support';
import { newCode } from './discounts-page';

const code = (overrides: Partial<DiscountCodeValue>): DiscountCodeValue => ({
  id: 'dsc_1',
  code: 'EID25',
  title: 'EID25',
  kind: 'PERCENTAGE',
  summary: '25% off orders of Rs 3,000 or more',
  status: 'ACTIVE',
  usageCount: 12,
  usageLimit: 100,
  startsAt: LATER,
  endsAt: null,
  ...overrides,
});

describe('Discount codes in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('makes a code for a percentage off, limited and with an end, as a marketer', async () => {
    const codes: DiscountCodeValue[] = [];
    const core = fakeCore('marketer', (operation) => {
      if (operation === 'DiscountCodes') return { discountCodes: { nodes: codes } };
      if (operation === 'DiscountCodeCreate') {
        const made = code({});
        codes.push(made);
        return { discountCodeCreate: { discountCode: made, userErrors: [] } };
      }
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/discounts');

    await screen.findByText('No discount codes yet.');
    await press('New code');
    type('Code', 'eid25');
    expect((screen.getByLabelText('Code') as HTMLInputElement).value).toBe('EID25');
    type('Percentage off', '25');
    type('For orders from (optional)', '3,000');
    type('Uses in all (optional)', '100');
    fireEvent.click(screen.getByRole('checkbox', { name: /One order a customer/ }));
    type('Ends (optional)', '2026-12-31');
    await press('Make the code');

    await screen.findByText('EID25 is made. Share it: shoppers type it at checkout.');
    expect(screen.getByText('Used 12 of 100 times')).toBeTruthy();
    expect(core.sent.find((each) => each.operation === 'DiscountCodeCreate')?.variables).toEqual({
      discountCode: {
        code: 'EID25',
        percentage: 25,
        minimumSubtotal: '3,000',
        usageLimit: 100,
        oncePerCustomer: true,
        endsAt: new Date('2026-12-31T23:59:59').toISOString(),
      },
    });
  });

  it('ends a code at once, and deletes another', async () => {
    const core = fakeCore('manager', (operation) => {
      switch (operation) {
        case 'DiscountCodes':
          return {
            discountCodes: {
              nodes: [
                code({}),
                code({
                  id: 'dsc_2',
                  code: 'FREEDEL',
                  title: 'Free delivery week',
                  kind: 'FREE_SHIPPING',
                  summary: 'Free delivery',
                  status: 'EXPIRED',
                  usageCount: 1,
                  usageLimit: null,
                }),
              ],
            },
          };
        case 'DiscountCodeUpdate':
          return { discountCodeUpdate: { discountCode: { id: 'dsc_1' }, userErrors: [] } };
        case 'DiscountCodeDelete':
          return { discountCodeDelete: { deletedDiscountCodeId: 'dsc_2', userErrors: [] } };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/discounts');

    await screen.findByText('Free delivery week');
    expect(screen.getByText('Used once')).toBeTruthy();
    // An ended code is not ended again.
    expect(screen.getAllByRole('button', { name: 'End it now' })).toHaveLength(1);
    await press('End it now');
    await waitFor(() =>
      expect(core.sent.find((each) => each.operation === 'DiscountCodeUpdate')?.variables).toEqual({
        id: 'dsc_1',
        discountCode: { endsAt: expect.any(String) },
      }),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!);
    await press('Delete it');
    await waitFor(() =>
      expect(core.sent.find((each) => each.operation === 'DiscountCodeDelete')?.variables).toEqual({
        id: 'dsc_2',
      }),
    );
  });

  it('is a section for those who make codes, and makes codes easy to read out', () => {
    const has = (role: Parameters<typeof sectionsOf>[0]) =>
      sectionsOf(role).some((item) => item.to === '/$shopId/discounts');
    expect([has('owner'), has('manager'), has('marketer')]).toEqual([true, true, true]);
    expect([has('packer'), has('confirmation_agent'), has('accountant')]).toEqual([
      false,
      false,
      false,
    ]);
    const made = newCode();
    expect(made).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
});
