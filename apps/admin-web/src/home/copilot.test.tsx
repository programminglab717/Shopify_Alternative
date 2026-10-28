import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, press, renderAdmin, signedIn, type } from '../test-support';

const tally = (count: number) => ({ count, total: { amount: '0', currencyCode: 'PKR' } });

const DISCOUNT = {
  kind: 'DISCOUNT',
  discount: {
    code: 'EID15',
    title: 'Eid sale',
    percentage: 15,
    amount: null,
    freeShipping: false,
    minimumSubtotal: '3000',
    startsOn: null,
    endsOn: '2026-11-30',
    oncePerCustomer: true,
    usageLimit: null,
  },
  segment: null,
  report: null,
};

const SEGMENT = {
  kind: 'SEGMENT',
  discount: null,
  segment: {
    name: 'Lahore repeat buyers',
    query: "number_of_orders >= 2 AND city = 'Lahore'",
    customers: 14,
  },
  report: null,
};

/** Home with nothing to do, the copilot set up, drafting each request as `drafts` says. */
function core(role: StaffRole, drafts: Record<string, object>, available = true) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'SetupChecklist':
        return { setupChecklist: { done: 8, total: 8, steps: [] } };
      case 'HomeStock':
        return { home: { lowStock: { low: 0, out: 0, threshold: 5 }, transfersToReceive: 0 } };
      case 'Copilot':
        return { copilot: { available, usedToday: 0, limitPerDay: 50 } };
      case 'CopilotDraft': {
        const draft = drafts[variables.request as string];
        return {
          copilotDraft: draft
            ? { draft, userErrors: [] }
            : {
                draft: null,
                userErrors: [
                  { field: ['request'], code: 'INVALID', message: 'Copilot messages nahi bhejta' },
                ],
              },
        };
      }
      case 'DiscountCodeCreate':
        return { discountCodeCreate: { discountCode: { id: 'disc_1' }, userErrors: [] } };
      case 'SegmentCreate':
        return { segmentCreate: { segment: { id: 'seg_1' }, userErrors: [] } };
      case 'Home':
        return {
          shop: { timezone: 'Asia/Karachi' },
          home: {
            ...Object.fromEntries(
              [
                'toConfirm',
                'toReview',
                'awaitingPayment',
                'transfersToCheck',
                'toPack',
                'toBook',
                'readyForPickup',
                'returning',
                'returnsToReceive',
                'cashToCollect',
                'lostToClaim',
                'claimsOpen',
              ].map((key) => [key, tally(0)]),
            ),
            parcelsUnseen: 0,
            today: {
              since: LATER,
              sales: tally(0),
              salesYesterday: tally(0),
              delivered: tally(0),
              returnedToOrigin: tally(0),
            },
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('The merchant copilot on Home (AI-01, ADR-894)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('drafts a code and a segment, made only once confirmed, or says why it has none', async () => {
    const fake = core('marketer', {
      'Eid ke liye 15% off': DISCOUNT,
      'Lahore ke repeat customers': SEGMENT,
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1');

    await screen.findByLabelText('What should Hatti draft?');
    type('What should Hatti draft?', 'Eid ke liye 15% off');
    await press('Draft it');
    expect(await screen.findByText('Discount code EID15')).toBeTruthy();
    for (const line of [
      '15% off the items',
      'On orders of Rs 3,000 or more',
      /^Until 30 Nov 2026$/,
      'Once per customer',
    ]) {
      expect(screen.getByText(line)).toBeTruthy();
    }
    expect(sentOf(fake, 'DiscountCodeCreate')).toEqual([]);
    await press('Create the code');
    expect(await screen.findByText('EID15 is made.')).toBeTruthy();
    expect(sentOf(fake, 'DiscountCodeCreate')).toEqual([
      {
        discountCode: {
          code: 'EID15',
          title: 'Eid sale',
          percentage: 15,
          minimumSubtotal: '3000',
          usageLimit: null,
          oncePerCustomer: true,
          endsAt: '2026-11-30T18:59:59.000Z',
        },
      },
    ]);

    type('What should Hatti draft?', 'Lahore ke repeat customers');
    await press('Draft it');
    expect(await screen.findByText('A group of customers: 14 match now')).toBeTruthy();
    expect(screen.getByText("number_of_orders >= 2 AND city = 'Lahore'")).toBeTruthy();
    type('Name of the group', 'Lahore regulars');
    await press('Save the segment');
    await waitFor(() =>
      expect(sentOf(fake, 'SegmentCreate')).toEqual([
        { name: 'Lahore regulars', query: "number_of_orders >= 2 AND city = 'Lahore'" },
      ]),
    );
    expect(
      (await screen.findByRole('link', { name: 'See its customers' })).getAttribute('href'),
    ).toBe('/shop_1/customers/segments/seg_1');

    type('What should Hatti draft?', 'sab ko message bhejo');
    await press('Draft it');
    expect(await screen.findByText('Copilot messages nahi bhejta')).toBeTruthy();
  });

  it('lets a packer see a draft but not make it, and stays away where it is not set up', async () => {
    vi.stubGlobal('fetch', core('packer', { 'Eid ke liye 15% off': DISCOUNT }).fetcher);
    renderAdmin('/shop_1');
    await screen.findByLabelText('What should Hatti draft?');
    type('What should Hatti draft?', 'Eid ke liye 15% off');
    await press('Draft it');
    expect(await screen.findByRole('button', { name: 'Create the code' })).toHaveProperty(
      'disabled',
      true,
    );
    cleanup();

    vi.stubGlobal('fetch', core('owner', {}, false).fetcher);
    renderAdmin('/shop_1');
    await screen.findByText('All caught up. New orders will show here.');
    expect(screen.queryByRole('heading', { name: 'Copilot' })).toBeNull();
  });
});
