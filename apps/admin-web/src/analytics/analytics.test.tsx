import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalesTotalsValue } from '../api/types';
import { sectionsOf } from '../shell/shell';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { change, startOfDay } from './analytics-page';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const totals = (net: string, orders: number): SalesTotalsValue => ({
  orders,
  netSales: rupees(net),
  totalSales: rupees(net),
  averageOrderValue: orders ? rupees(String(Number(net) / orders)) : null,
  returns: rupees('0'),
  profit: rupees(String(Number(net) / 4)),
});

const delivery = (delivered: number, returned: number) => ({
  shipped: delivered + returned,
  delivered,
  returned,
  inTransit: 0,
  successRate: delivered / (delivered + returned),
  returnRate: returned / (delivered + returned),
  returnCharges: rupees(String(returned * 180)),
});

const COD_HEALTH = {
  confirmation: { placed: 42, confirmed: 32, cancelled: 8, awaiting: 2, rate: 0.8 },
  delivery: { ...delivery(24, 6), inTransit: 2 },
  rows: [
    {
      key: 'Karachi',
      title: 'Karachi',
      confirmation: { placed: 25, rate: 0.88 },
      delivery: delivery(18, 2),
    },
    {
      key: 'Quetta',
      title: 'Quetta',
      confirmation: { placed: 6, rate: 0.5 },
      delivery: delivery(2, 2),
    },
  ],
};

describe('Analytics in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows sales against the period before, by day, with what sold most and from where', async () => {
    const core = fakeCore('marketer', (operation) => {
      if (operation === 'CodHealth') return { codHealth: COD_HEALTH };
      if (operation !== 'Sales') throw new Error(`unexpected ${operation}`);
      return {
        salesReport: {
          totals: totals('60000', 20),
          previous: { totals: totals('48000', 25) },
          periods: [
            { start: '2026-10-07T19:00:00Z', sales: { orders: 0, netSales: rupees('0') } },
            { start: '2026-10-08T19:00:00Z', sales: { orders: 1, netSales: rupees('3000') } },
          ],
          topProducts: [
            { productId: 'prod_1', title: 'Lawn suit', unitsSold: 12, grossSales: rupees('42000') },
          ],
          rows: [
            {
              key: 'WHATSAPP',
              title: 'WhatsApp',
              sales: { orders: 14, netSales: rupees('41000') },
            },
          ],
        },
      };
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/analytics');

    await screen.findByText('Rs 60,000');
    // Net sales and profit both grew a quarter; orders fell a fifth.
    expect(screen.getAllByText('25% more')).toHaveLength(2);
    expect(screen.getByText('20% less')).toBeTruthy();
    expect(screen.getByLabelText('9 Oct 2026: Rs 3,000 from 1 order')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Lawn suit' }).getAttribute('href')).toBe(
      '/shop_1/products/prod_1',
    );
    expect(screen.getByText('WhatsApp')).toBeTruthy();
    const month = core.sent.find((each) => each.operation === 'Sales')!.variables;
    expect(month.interval).toBe('DAY');
    expect(Date.parse(String(month.placedBefore)) - Date.parse(String(month.placedFrom))).toBe(
      30 * 86_400_000,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Last 90 days' }));
    await waitFor(() =>
      expect(
        core.sent.filter((each) => each.operation === 'Sales').at(-1)?.variables.interval,
      ).toBe('WEEK'),
    );
  });

  it("shows how cash-on-delivery orders turned out, a city's high returns in red", async () => {
    const core = fakeCore('owner', (operation) => {
      if (operation === 'CodHealth') return { codHealth: COD_HEALTH };
      if (operation === 'Sales') throw new Error('not this time');
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/analytics');

    await screen.findByText('32 of 40 decided');
    // 32 of 40 decided confirmed (the 2 awaiting count once decided), and 24 of 30 parcels delivered.
    expect(screen.getAllByText('80%')).toHaveLength(2);
    expect(screen.getByText('6 of 30 parcels')).toBeTruthy();
    expect(screen.getByText('2 parcels on their way')).toBeTruthy();
    const quetta = screen.getByText('Quetta').closest('tr')!;
    expect(quetta.lastElementChild?.textContent).toBe('50%');
    expect(quetta.lastElementChild?.className).toContain('text-danger');
    expect(screen.getByText('Karachi').closest('tr')!.lastElementChild?.className).not.toContain(
      'text-danger',
    );

    fireEvent.change(screen.getByLabelText('By'), { target: { value: 'COURIER' } });
    await waitFor(() =>
      expect(core.sent.filter((each) => each.operation === 'CodHealth').at(-1)?.variables.by).toBe(
        'COURIER',
      ),
    );
  });

  it('works out whole days in the shop’s time zone and the change from before', () => {
    // 1:30 am on 9 October in Karachi is still 8 October in UTC.
    const now = new Date('2026-10-08T20:30:00Z');
    expect(startOfDay('Asia/Karachi', 0, now).toISOString()).toBe('2026-10-08T19:00:00.000Z');
    expect(startOfDay('Asia/Karachi', 6, now).toISOString()).toBe('2026-10-02T19:00:00.000Z');
    expect(change(120, 100)).toBe(20);
    expect(change(50, 0)).toBeNull();
    expect(sectionsOf('accountant').some((item) => item.to === '/$shopId/analytics')).toBe(true);
    expect(sectionsOf('packer').some((item) => item.to === '/$shopId/analytics')).toBe(false);
  });
});
