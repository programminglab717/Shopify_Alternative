import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AffiliateValue } from '../api/types';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';
import { affiliateLink } from './affiliates-page';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });

const AYESHA: AffiliateValue = {
  id: 'afl_1',
  name: 'Ayesha Khan',
  phone: '+923001234567',
  ref: 'ayesha',
  discountCode: 'AYESHA10',
  commission: '10',
  active: true,
  endedAt: null,
  createdAt: '2026-10-01T09:00:00Z',
  stats: {
    orders: 5,
    delivered: 3,
    sales: pkr('5800.00'),
    earned: pkr('580.00'),
    pending: pkr('200.00'),
    paid: pkr('500.00'),
    owed: pkr('80.00'),
  },
};

/** A fake core keeping the shop's affiliates as the core would, with Ayesha's orders. */
function affiliatesCore() {
  const affiliates: AffiliateValue[] = [JSON.parse(JSON.stringify(AYESHA)) as AffiliateValue];
  return fakeCore('marketer', (operation, variables) => {
    const input = (variables?.input ?? {}) as Record<string, unknown>;
    switch (operation) {
      case 'Affiliates':
        return { shop: { url: 'https://zari.hatti.pk' }, affiliates };
      case 'AffiliateCreate': {
        if (input.ref === 'ayesha') {
          return {
            affiliateCreate: {
              affiliate: null,
              userErrors: [
                {
                  field: ['input', 'ref'],
                  code: 'TAKEN',
                  message: 'Another affiliate has this link',
                },
              ],
            },
          };
        }
        const made = {
          ...(JSON.parse(JSON.stringify(AYESHA)) as AffiliateValue),
          id: 'afl_2',
          name: String(input.name),
          ref: String(input.ref),
          discountCode: null,
          commission: String(input.commission),
          stats: { ...AYESHA.stats, orders: 0, delivered: 0 },
        };
        affiliates.unshift(made);
        return { affiliateCreate: { affiliate: made, userErrors: [] } };
      }
      case 'AffiliateUpdate': {
        const found = affiliates.find((each) => each.id === input.id)!;
        if (input.active === false) Object.assign(found, { active: false });
        return { affiliateUpdate: { affiliate: found, userErrors: [] } };
      }
      case 'AffiliatePayoutRecord':
        return { affiliatePayoutRecord: { payout: { id: 'aflp_1' }, userErrors: [] } };
      case 'AffiliateActivity':
        return {
          affiliateOrders: [
            {
              orderId: 'ord_1',
              name: '#1004',
              placedAt: '2026-10-20T09:00:00Z',
              stage: 'delivered',
              source: 'CODE',
              base: pkr('1800.00'),
              commission: pkr('180.00'),
            },
          ],
          affiliatePayouts: [
            {
              id: 'aflp_0',
              amount: pkr('500.00'),
              note: 'JazzCash',
              paidAt: '2026-10-21T09:00:00Z',
            },
          ],
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (core: ReturnType<typeof affiliatesCore>, operation: string) =>
  core.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Affiliates in the admin (MKT-08, ADR-777)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("makes an affiliate's link from the store's address", () => {
    expect(affiliateLink('https://zari.hatti.pk/', 'ayesha')).toBe(
      'https://zari.hatti.pk/?ref=ayesha',
    );
  });

  it('shows each affiliate with their link, code and figures, and adds one', async () => {
    const core = affiliatesCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/marketing/affiliates');

    const card = (await screen.findByRole('heading', { name: 'Ayesha Khan' })).closest('li')!;
    expect(within(card).getByText('https://zari.hatti.pk/?ref=ayesha')).toBeTruthy();
    expect(within(card).getByText('AYESHA10')).toBeTruthy();
    expect(within(card).getByText('10% share')).toBeTruthy();
    expect(within(card).getByText('5 (3 delivered)')).toBeTruthy();
    expect(within(card).getByText('Owed').nextElementSibling?.textContent).toContain('80');

    // A link another affiliate has is refused beside its field.
    type('Name', 'Bilal');
    type('Link name', 'ayesha');
    await press('Add affiliate');
    await screen.findByText(/Another affiliate has this link/);
    type('Link name', 'bilal');
    type('Share (%)', '7.5');
    await press('Add affiliate');
    await screen.findByRole('heading', { name: 'Bilal' });
    expect(sentOf(core, 'AffiliateCreate').at(-1)).toEqual({
      input: { name: 'Bilal', phone: '', ref: 'bilal', discountCode: '', commission: '7.5' },
    });
  });

  it("records a payout, shows an affiliate's orders and payouts, and ends their part", async () => {
    const core = affiliatesCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/marketing/affiliates');

    const card = (await screen.findByRole('heading', { name: 'Ayesha Khan' })).closest('li')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Record a payout' }));
    fireEvent.change(within(card).getByLabelText('Amount paid'), { target: { value: '80' } });
    fireEvent.change(within(card).getByLabelText('Note'), { target: { value: 'Easypaisa' } });
    fireEvent.click(within(card).getAllByRole('button', { name: 'Record a payout' }).at(-1)!);
    await waitFor(() =>
      expect(sentOf(core, 'AffiliatePayoutRecord')).toEqual([
        { input: { affiliateId: 'afl_1', amount: '80', note: 'Easypaisa' } },
      ]),
    );

    fireEvent.click(within(card).getByRole('button', { name: 'Orders and payouts' }));
    expect(await within(card).findByRole('link', { name: '#1004' })).toBeTruthy();
    expect(within(card).getByText(/by code/)).toBeTruthy();
    expect(within(card).getByText(/JazzCash/)).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'End their part' }));
    await waitFor(() =>
      expect(sentOf(core, 'AffiliateUpdate')).toEqual([{ input: { id: 'afl_1', active: false } }]),
    );
    expect(await within(card).findByText('Ended')).toBeTruthy();
  });
});
