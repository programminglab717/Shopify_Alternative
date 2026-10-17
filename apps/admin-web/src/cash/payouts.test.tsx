import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../i18n/messages';
import type { PayoutWithholdingValue } from '../api/types';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { payoutPeriod, withholdingsCsv } from './payouts-page';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const english = (key: string, values?: Record<string, string | number>) =>
  (messages.en as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values?.[name] ?? ''),
  );

const totals = (statements: number, net: string, tax: string) => ({
  statements,
  gross: rupees('13000.00'),
  fees: rupees('500.00'),
  tax: rupees(tax),
  net: rupees(net),
});

const WITHHELD: PayoutWithholdingValue = {
  id: 'rmt_1',
  kind: 'COURIER',
  name: 'PostEx',
  reference: 'PX-1, part 2',
  importedAt: '2026-09-30T20:00:00Z',
  gross: rupees('6000.00'),
  fees: rupees('300.00'),
  tax: rupees('60.00'),
  net: rupees('5640.00'),
};

const REPORT = {
  payoutsReport: {
    totals: totals(4, '12400.00', '100.00'),
    sources: [
      { kind: 'COURIER', name: 'PostEx', ...totals(2, '6590.00', '60.00') },
      { kind: 'GATEWAY', name: 'Safepay', ...totals(2, '5810.00', '40.00') },
    ],
    months: [
      { month: '2026-09', ...totals(1, '3860.00', '40.00') },
      { month: '2026-10', ...totals(3, '8540.00', '60.00') },
    ],
    withholdings: [WITHHELD],
    truncated: false,
  },
};

describe('Payouts and tax withheld, in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads months and Pakistan's tax year in the shop's time zone, and writes the tax withheld as CSV", () => {
    const now = new Date('2026-10-17T10:00:00Z');
    expect(payoutPeriod('thisMonth', 'Asia/Karachi', now)).toEqual({
      from: '2026-09-30T19:00:00.000Z',
      before: '2026-10-31T19:00:00.000Z',
    });
    expect(payoutPeriod('lastMonth', 'Asia/Karachi', now).from).toBe('2026-08-31T19:00:00.000Z');
    expect(payoutPeriod('thisTaxYear', 'Asia/Karachi', now)).toEqual({
      from: '2026-06-30T19:00:00.000Z',
      before: '2027-06-30T19:00:00.000Z',
    });
    expect(payoutPeriod('lastTaxYear', 'Asia/Karachi', now).from).toBe('2025-06-30T19:00:00.000Z');
    // January's last month is December, and its tax year began the July before.
    const january = new Date('2027-01-10T10:00:00Z');
    expect(payoutPeriod('lastMonth', 'Asia/Karachi', january)).toEqual({
      from: '2026-11-30T19:00:00.000Z',
      before: '2026-12-31T19:00:00.000Z',
    });
    expect(payoutPeriod('thisTaxYear', 'UTC', january).from).toBe('2026-07-01T00:00:00.000Z');

    expect(withholdingsCsv([WITHHELD], 'Asia/Karachi', english)).toBe(
      'Date,Paid by,Kind,Reference,Customers paid,Fees,Tax withheld,Paid over\r\n' +
        '2026-10-01,PostEx,Courier,"PX-1, part 2",6000.00,300.00,60.00,5640.00\r\n',
    );
  });

  it('shows who paid, by month, and the statements that withheld tax, for the period chosen', async () => {
    const core = fakeCore('accountant', (operation) => {
      if (operation === 'PayoutsReport') return REPORT;
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:tax');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue();
    renderAdmin('/shop_1/payouts');

    await screen.findByRole('heading', { name: 'Payouts and tax withheld' });
    expect(await screen.findByText('Rs 12,400')).toBeTruthy();
    expect(screen.getByText('Rs 6,590')).toBeTruthy();
    expect(screen.getByText('October 2026')).toBeTruthy();
    expect(screen.getByText('September 2026')).toBeTruthy();
    expect(screen.getByText('PX-1, part 2')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'This month' }).getAttribute('aria-selected')).toBe(
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download as CSV' }));
    expect(created).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: 'This tax year' }));
    await waitFor(() =>
      expect(core.sent.filter((each) => each.operation === 'PayoutsReport')).toHaveLength(2),
    );
    const asked = core.sent.filter((each) => each.operation === 'PayoutsReport');
    expect(
      new Date(asked[1]!.variables.before as string).getTime() -
        new Date(asked[1]!.variables.from as string).getTime(),
    ).toBeGreaterThan(300 * 86_400_000);
  });
});
