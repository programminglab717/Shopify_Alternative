import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalesTotalsValue } from '../api/types';
import { sectionsOf } from '../shell/shell';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { change } from './figures';
import { startOfDay } from './period';

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

const none = {
  sessions: 0,
  addedToCart: 0,
  reachedCheckout: 0,
  converted: 0,
  conversionRate: null,
};

const NO_STOCK = {
  days: 30,
  sold: 0,
  onHand: 0,
  sellThrough: null,
  ranOut: 0,
  outNow: 0,
  ageing: [],
  rows: [],
};

/**
 * The online store's visits and searches, couriers' parcels and stock, none: the page asks for
 * them beside its sales.
 */
const NO_VISITS: Record<string, unknown> = {
  CourierPerformance: { courierPerformance: [] },
  StoreSearches: {
    storeSearches: {
      days: 30,
      searches: 0,
      foundNothing: 0,
      foundNothingRate: null,
      top: [],
      nothingFound: [],
    },
  },
  InventoryReport: { inventoryReport: NO_STOCK },
  // Hatti's AI answering questions of the numbers (ADR-844): not set up.
  ReportQuestions: { reportQuestions: { available: false, usedToday: 0, limitPerDay: 50 } },
  StorefrontLiveView: { storefrontLiveView: { visitorsNow: 0, today: none } },
  StorefrontSessions: {
    storefrontSessions: { totals: none, periods: [] },
    previous: { totals: none },
  },
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

  it('shows gross profit on a plan without true profit, saying which plans give it (ADR-529)', async () => {
    const core = fakeCore('owner', (operation) => {
      if (operation in NO_VISITS) return NO_VISITS[operation];
      if (operation === 'CodHealth') return { codHealth: COD_HEALTH };
      if (operation !== 'Sales') return {};
      return {
        salesReport: {
          totals: { ...totals('60000', 20), grossProfit: rupees('21000'), profit: null },
          previous: {
            totals: { ...totals('48000', 25), grossProfit: rupees('16800'), profit: null },
          },
          periods: [],
          topProducts: [],
          rows: [],
          trueProfit: false,
        },
      };
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/analytics');

    await screen.findByText('Rs 21,000');
    expect(screen.getByText('Gross profit')).toBeTruthy();
    expect(
      screen.getByText('Profit after couriers and returns is on Growth and bigger plans'),
    ).toBeTruthy();
    expect(screen.queryByText('Profit')).toBeNull();
    expect(screen.queryByText('Ad spend')).toBeNull();
    expect(screen.queryByText('Return on ad spend')).toBeNull();
  });

  it("downloads the period's sales as Excel for the accountant, or says why not (ADR-798)", async () => {
    let refuse = true;
    const core = fakeCore('accountant', (operation) => {
      if (operation in NO_VISITS) return NO_VISITS[operation];
      if (operation === 'CodHealth') return { codHealth: COD_HEALTH };
      if (operation === 'SalesReportExport') {
        if (refuse) {
          refuse = false;
          return {
            salesReportExport: {
              file: null,
              userErrors: [
                {
                  field: ['placedBefore'],
                  code: 'INVALID',
                  message: 'A sales report covers at most 366 days at a time',
                },
              ],
            },
          };
        }
        return {
          salesReportExport: {
            file: {
              filename: 'sales-2026-10-27.xlsx',
              contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              content: btoa('PK'),
            },
            userErrors: [],
          },
        };
      }
      if (operation !== 'Sales') return {};
      return {
        salesReport: {
          totals: totals('60000', 20),
          previous: { totals: totals('48000', 25) },
          periods: [],
          topProducts: [],
          rows: [],
          trueProfit: true,
        },
      };
    });
    vi.stubGlobal('fetch', core.fetcher);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:sales');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderAdmin('/shop_1/analytics');

    fireEvent.click(await screen.findByRole('button', { name: 'Download as Excel' }));
    expect(
      await screen.findByText('A sales report covers at most 366 days at a time'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download as Excel' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const [sales] = core.sent.filter((each) => each.operation === 'Sales');
    const exports = core.sent.filter((each) => each.operation === 'SalesReportExport');
    // The period the page shows, as it shows it.
    expect(exports.map((each) => each.variables)).toEqual([
      {
        placedFrom: sales!.variables.placedFrom,
        placedBefore: sales!.variables.placedBefore,
        interval: 'DAY',
      },
      expect.objectContaining({ interval: 'DAY' }),
    ]);
    vi.restoreAllMocks();
  });

  it('shows what the ads cost and the net sales they brought in, beside profit (ADR-553)', async () => {
    const report = (adSpend: string | null, returnOnAdSpend: number | null) => ({
      salesReport: {
        totals: {
          ...totals('60000', 20),
          adSpend: adSpend === null ? null : rupees(adSpend),
          returnOnAdSpend,
        },
        previous: {
          totals: { ...totals('48000', 25), adSpend: rupees('15000'), returnOnAdSpend: 3.2 },
        },
        periods: [],
        topProducts: [],
        rows: [],
        trueProfit: true,
      },
    });
    let answer = report('18750', 3.2);
    const core = fakeCore('owner', (operation) => {
      if (operation in NO_VISITS) return NO_VISITS[operation];
      if (operation === 'CodHealth') return { codHealth: COD_HEALTH };
      if (operation !== 'Sales') return {};
      return answer;
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/analytics');

    const spend = (await screen.findByText('Ad spend')).parentElement!;
    expect(within(spend).getByText('Rs 18,750')).toBeTruthy();
    // A quarter more spent than the period before.
    expect(within(spend).getByText('25% more')).toBeTruthy();
    const roas = screen.getByText('Return on ad spend').parentElement!;
    expect(within(roas).getByText('3.20×')).toBeTruthy();
    expect(within(roas).getByText('Net sales for each rupee spent on ads')).toBeTruthy();
    expect(screen.getByText('Profit')).toBeTruthy();

    // No spend recorded for the period: neither is shown.
    answer = report('0', null);
    fireEvent.click(screen.getByRole('tab', { name: 'Last 7 days' }));
    await waitFor(() =>
      expect(core.sent.filter((each) => each.operation === 'Sales')).toHaveLength(2),
    );
    expect(await screen.findByText('Profit')).toBeTruthy();
    expect(screen.queryByText('Ad spend')).toBeNull();
    expect(screen.queryByText('Return on ad spend')).toBeNull();
  });

  it('shows sales against the period before, by day, with what sold most and from where', async () => {
    const core = fakeCore('marketer', (operation) => {
      if (operation in NO_VISITS) return NO_VISITS[operation];
      if (operation === 'CodHealth') return { codHealth: COD_HEALTH };
      if (operation !== 'Sales') throw new Error(`unexpected ${operation}`);
      return {
        salesReport: {
          // Rs 1,450 of couriers' charges no statement has said yet (ADR-383).
          totals: { ...totals('60000', 20), shippingCostsEstimated: rupees('1450') },
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
    expect(
      screen.getByText('Includes Rs 1,450 of courier charges estimated by rate cards'),
    ).toBeTruthy();
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

    expect(screen.queryByRole('link', { name: "Agents' performance" })).toBeNull();
    // Marketers do not export (ADR-798).
    expect(screen.queryByRole('button', { name: 'Download as Excel' })).toBeNull();
    // Without true profit said, no ad spend.
    expect(screen.queryByText('Ad spend')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Last 90 days' }));
    await waitFor(() =>
      expect(
        core.sent.filter((each) => each.operation === 'Sales').at(-1)?.variables.interval,
      ).toBe('WEEK'),
    );
  });

  it("shows how cash-on-delivery orders turned out, a city's high returns in red", async () => {
    const core = fakeCore('owner', (operation) => {
      if (operation in NO_VISITS) return NO_VISITS[operation];
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

    // The owner goes on from here to how each agent of the desk did.
    expect(screen.getByRole('link', { name: "Agents' performance" }).getAttribute('href')).toBe(
      '/shop_1/desk/agents',
    );

    fireEvent.change(screen.getByLabelText('By'), { target: { value: 'COURIER' } });
    await waitFor(() =>
      expect(core.sent.filter((each) => each.operation === 'CodHealth').at(-1)?.variables.by).toBe(
        'COURIER',
      ),
    );
  });

  it("shows how each courier did, its cities beneath it and a city's high returns in red", async () => {
    const tally = (
      delivered: number,
      returned: number,
      days: number | null,
      each: string | null,
    ) => ({
      shipped: delivered + returned + 1,
      delivered,
      returned,
      lost: 0,
      inTransit: 1,
      deliveryRate: delivered / (delivered + returned),
      returnRate: returned / (delivered + returned),
      daysToDeliver: days,
      chargePerParcel: each === null ? null : rupees(each),
    });
    const core = fakeCore('owner', (operation) => {
      if (operation === 'CourierPerformance') {
        return {
          courierPerformance: [
            {
              courier: 'PostEx',
              title: 'PostEx',
              ...tally(18, 2, 2.4, '265.5'),
              chargesEstimated: rupees('1450'),
              cities: [
                { city: 'Karachi', ...tally(15, 0, 1.6, '230') },
                { city: 'Quetta', ...tally(3, 2, 5, '410') },
              ],
            },
            {
              courier: null,
              title: 'No courier named',
              ...tally(4, 0, 0.5, null),
              chargesEstimated: rupees('0'),
              cities: [],
            },
          ],
        };
      }
      if (operation in NO_VISITS) return NO_VISITS[operation];
      if (operation === 'CodHealth' || operation === 'Sales') throw new Error('not this time');
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/analytics');

    const postEx = await screen.findByRole('button', { name: 'PostEx by city' });
    const row = postEx.closest('tr')!;
    // 21 parcels, 18 of 20 that arrived somewhere delivered, 2.4 days, Rs 265.50 each.
    expect([...row.querySelectorAll('td')].slice(1).map((cell) => cell.textContent)).toEqual([
      '21',
      '90%',
      '10%',
      '2.4',
      'Rs 265.50',
    ]);
    expect(screen.getByText('No courier named').closest('tr')!.lastElementChild?.textContent).toBe(
      '–',
    );
    expect(screen.getByText('The costs include Rs 1,450 estimated by rate cards')).toBeTruthy();
    expect(screen.queryByText('Quetta')).toBeNull();

    fireEvent.click(postEx);
    expect(postEx.getAttribute('aria-expanded')).toBe('true');
    const quetta = screen.getByText('Quetta').closest('tr')!;
    expect(quetta.children[3]!.textContent).toBe('40%');
    expect(quetta.children[3]!.className).toContain('text-danger');
    expect(screen.getByText('Karachi').closest('tr')!.children[3]!.className).not.toContain(
      'text-danger',
    );

    const asked = core.sent.find((each) => each.operation === 'CourierPerformance')!.variables;
    expect(Date.parse(String(asked.shippedBefore)) - Date.parse(String(asked.shippedFrom))).toBe(
      30 * 86_400_000,
    );
  });

  it('shows how the stock sold, how old it is and what ran out, its cost to owners', async () => {
    const bucket = (name: string, units: number, value: string) => ({
      bucket: name,
      variants: units ? 1 : 0,
      units,
      unitsWithoutCost: 0,
      value: rupees(value),
    });
    const row = (fields: Record<string, unknown>) => ({
      variantId: 'var_1',
      productId: 'prod_1',
      productTitle: 'Lawn suit',
      variantTitle: 'Small',
      sku: 'LS-S',
      sold: 12,
      available: 4,
      sellThrough: 75,
      daysSinceSale: 2,
      stockouts: 0,
      daysOut: 0,
      ...fields,
    });
    const report = (sortKey: unknown) => ({
      ...NO_STOCK,
      sold: 30,
      onHand: 50,
      sellThrough: 37.5,
      ranOut: 2,
      outNow: 1,
      ageing: [
        bucket('DAYS_0_30', 20, '20000'),
        bucket('DAYS_31_60', 0, '0'),
        bucket('DAYS_61_90', 0, '0'),
        bucket('OVER_90', 0, '0'),
        bucket('NEVER', 30, '45000'),
      ],
      rows:
        sortKey === 'STOCKOUTS'
          ? [
              row({
                productTitle: 'Chiffon dupatta',
                variantTitle: 'Default Title',
                available: 0,
                stockouts: 2,
                daysOut: 4.5,
              }),
            ]
          : sortKey === 'SLOWEST'
            ? [row({ productTitle: 'Khaddar shawl', daysSinceSale: null, sold: 0, sellThrough: 0 })]
            : [row({})],
    });
    const render = (role: 'owner' | 'marketer') => {
      const core = fakeCore(role, (operation, variables) => {
        if (operation === 'InventoryReport') return { inventoryReport: report(variables.sortKey) };
        if (operation in NO_VISITS) return NO_VISITS[operation];
        if (operation === 'CodHealth' || operation === 'Sales') throw new Error('not this time');
        throw new Error(`unexpected ${operation}`);
      });
      vi.stubGlobal('fetch', core.fetcher);
      renderAdmin('/shop_1/analytics');
      return core;
    };

    const core = render('owner');
    await screen.findByText('50 on hand now');
    expect(screen.getByText('38%')).toBeTruthy();
    expect(screen.getByText('Out of stock now').nextElementSibling?.textContent).toBe('1');
    // Stock that never sold, and what it cost the shop.
    const never = screen.getAllByText('Never')[0]!.closest('tr')!;
    expect([...never.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual([
      'Never',
      '30',
      'Rs 45,000',
    ]);
    const suit = screen.getByRole('link', { name: 'Lawn suit' });
    expect(suit.getAttribute('href')).toBe('/shop_1/products/prod_1');
    expect(suit.closest('tr')!.lastElementChild?.textContent).toBe('75%');
    expect(core.sent.find((each) => each.operation === 'InventoryReport')!.variables).toEqual({
      days: 30,
      sortKey: 'SELL_THROUGH',
    });

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'STOCKOUTS' } });
    const dupatta = await screen.findByRole('link', { name: 'Chiffon dupatta' });
    expect(dupatta.closest('tr')!.lastElementChild?.textContent).toBe('4.5 days · 2 times');
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'SLOWEST' } });
    const shawl = await screen.findByRole('link', { name: 'Khaddar shawl' });
    expect(shawl.closest('tr')!.lastElementChild?.textContent).toBe('Never');

    fireEvent.click(screen.getByRole('tab', { name: 'Last 7 days' }));
    await waitFor(() =>
      expect(
        core.sent.filter((each) => each.operation === 'InventoryReport').at(-1)?.variables.days,
      ).toBe(7),
    );

    // A marketer sees how the stock sold, not what it cost.
    cleanup();
    render('marketer');
    await screen.findByText('50 on hand now');
    expect(screen.queryByText('At cost')).toBeNull();
    expect(screen.queryByText('Rs 45,000')).toBeNull();
  });

  it('answers a question of the numbers with the report Hatti ran, and says why it can’t (ADR-844)', async () => {
    const core = fakeCore('owner', (operation, variables) => {
      if (operation === 'ReportQuestions') {
        return { reportQuestions: { available: true, usedToday: 0, limitPerDay: 50 } };
      }
      if (operation in NO_VISITS) return NO_VISITS[operation];
      if (operation === 'CodHealth') return { codHealth: COD_HEALTH };
      if (operation === 'Sales') throw new Error('not this test');
      if (operation !== 'ReportQuestionAsk') throw new Error(`unexpected ${operation}`);
      if (variables.question === 'kal mausam?') {
        return {
          reportQuestionAsk: {
            answer: null,
            userErrors: [
              { field: ['question'], code: 'INVALID', message: 'Ye numbers ka sawal nahi' },
            ],
          },
        };
      }
      return {
        reportQuestionAsk: {
          answer: {
            breakdown: 'DAY',
            columns: ['orders', 'total_sales'],
            period: 'LAST_7_DAYS',
            report: {
              placedFrom: '2026-10-19T19:00:00Z',
              placedBefore: '2026-10-26T19:00:00Z',
              columns: [
                { key: 'orders', title: 'Orders', kind: 'NUMBER' },
                { key: 'total_sales', title: 'Total sales', kind: 'AMOUNT' },
              ],
              rows: [{ key: null, label: '2026-10-20', values: ['3', '9000.00'] }],
              totals: ['3', '9000.00'],
            },
          },
          userErrors: [],
        },
      };
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/analytics');

    fireEvent.change(await screen.findByLabelText('Your question'), {
      target: { value: ' Pichle hafte kitni sale hui? ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('Read as: Each day, Last 7 days')).toBeTruthy();
    // The day's row, and the period's total.
    expect(screen.getAllByRole('cell', { name: 'Rs 9,000' })).toHaveLength(2);
    expect(
      core.sent
        .filter((each) => each.operation === 'ReportQuestionAsk')
        .map((each) => each.variables),
    ).toEqual([{ question: 'Pichle hafte kitni sale hui?' }]);

    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'kal mausam?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('Ye numbers ka sawal nahi')).toBeTruthy();
    expect(screen.queryByText('Read as: Each day, Last 7 days')).toBeNull();
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
