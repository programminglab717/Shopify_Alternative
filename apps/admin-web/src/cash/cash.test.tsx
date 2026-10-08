import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../i18n/messages';
import { sectionsOf } from '../shell/shell';
import { fakeCore, LATER, renderAdmin, signedIn } from '../test-support';
import { ageLabel, statementOf } from './cash-page';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const english = (key: string, values?: Record<string, string | number>) =>
  (messages.en as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values?.[name] ?? ''),
  );

const age = (fromDays: number, toDays: number | null, count: number, amount: string) => ({
  fromDays,
  toDays,
  count,
  amount: rupees(amount),
});

const CASH = {
  codReceivables: {
    owed: { count: 9, amount: rupees('41500') },
    onTheWay: { count: 4, amount: rupees('12000') },
    ages: [
      age(0, 7, 6, '27000'),
      age(8, 14, 0, '0'),
      age(15, 30, 2, '9500'),
      age(31, null, 1, '5000'),
    ],
    couriers: [
      {
        courier: 'Leopards',
        oldestDeliveredAt: '2026-08-30T10:00:00Z',
        owed: { count: 5, amount: rupees('26000') },
        ages: [age(0, 7, 2, '11500'), age(15, 30, 2, '9500'), age(31, null, 1, '5000')],
      },
      {
        courier: 'PostEx',
        oldestDeliveredAt: '2026-10-05T10:00:00Z',
        owed: { count: 4, amount: rupees('15500') },
        ages: [age(0, 7, 4, '15500')],
      },
    ],
  },
  codRemittances: {
    nodes: [
      {
        id: 'rem_1',
        courier: 'PostEx',
        reference: 'PX-3381',
        createdAt: LATER,
        lineCount: 12,
        issueCount: 2,
        collected: rupees('48000'),
        paid: rupees('45600'),
        received: rupees('44000'),
      },
    ],
    pageInfo: { hasNextPage: false },
  },
};

const outcomes = {
  charged: 0,
  compensated: 0,
  notOwed: 0,
  over: 0,
  received: 10,
  repeated: 0,
  short: 1,
  unmatched: 1,
};

describe('The cash couriers hold, in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows what couriers owe and since when, and imports a statement once it is checked', async () => {
    const core = fakeCore('accountant', (operation, variables) => {
      if (operation === 'Cash') return CASH;
      if (operation === 'CashStatementImport') {
        return {
          codRemittanceImport: {
            dryRun: variables.dryRun,
            rows: 12,
            rowErrorCount: 1,
            rowErrors: [{ row: 9, column: 'COD Amount', message: 'is not an amount' }],
            outcomes,
            collected: rupees('48000'),
            received: rupees('44000'),
            paid: rupees('45600'),
            remittance: variables.dryRun ? null : { id: 'rem_2' },
            userErrors: [],
          },
        };
      }
      if (operation === 'CashStatement') return { codRemittance: null };
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    const { router } = renderAdmin('/shop_1/cash');

    await screen.findByText('Rs 41,500');
    expect(screen.getByText('For 9 parcels delivered')).toBeTruthy();
    // Cash held 15 days and more is late, in red; the courier holding it too.
    expect(screen.getByText('15 to 30 days').className).toContain('text-danger');
    expect(screen.getByText('Over 30 days').className).toContain('text-danger');
    expect(screen.getByText('8 to 14 days').className).not.toContain('text-danger');
    expect(screen.getByText(/^5 parcels, the first delivered/).className).toContain('text-danger');
    expect(screen.getByText(/^4 parcels, the first delivered/).className).not.toContain(
      'text-danger',
    );
    expect(screen.getByRole('link', { name: /PX-3381/ }).getAttribute('href')).toBe(
      '/shop_1/cash/rem_1',
    );
    expect(screen.getByText('2 lines to look into')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Courier'), { target: { value: 'Leopards' } });
    fireEvent.change(screen.getByLabelText('Statement or payment reference'), {
      target: { value: 'LP-0912' },
    });
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Statement file'), {
        target: {
          files: [new File(['CN,COD Amount\nLE1,3000\n'], 'leopards.csv', { type: 'text/csv' })],
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Check the statement' }));

    await screen.findByText(
      '12 rows: Rs 44,000 would be received on orders, of Rs 45,600 paid over.',
    );
    expect(screen.getByText('No such parcel')).toBeTruthy();
    expect(screen.getByText("1 row couldn't be read and would be left out")).toBeTruthy();
    expect(core.sent.find((each) => each.operation === 'CashStatementImport')?.variables).toEqual({
      courier: 'Leopards',
      reference: 'LP-0912',
      dryRun: true,
      csv: 'CN,COD Amount\nLE1,3000\n',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Import it' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/shop_1/cash/rem_2'));
    expect(
      core.sent.filter((each) => each.operation === 'CashStatementImport').at(-1)?.variables.dryRun,
    ).toBe(false);
  });

  it("lists a statement's lines to look into first, each with its order", async () => {
    const line = (row: number, outcome: string, orderName: string | null) => ({
      row,
      trackingNumber: `PX00${row}`,
      outcome,
      orderId: orderName ? `ord_${row}` : null,
      orderName,
      collected: rupees('3000'),
      received: rupees(outcome === 'UNMATCHED' ? '0' : '2500'),
      owed: orderName ? rupees('3000') : null,
    });
    const core = fakeCore('manager', (operation, variables) => {
      if (operation !== 'CashStatement') throw new Error(`unexpected ${operation}`);
      return {
        codRemittance: {
          ...CASH.codRemittances.nodes[0],
          charges: rupees('2400'),
          tax: rupees('0'),
          compensated: rupees('0'),
          lines: variables.issuesOnly
            ? [line(4, 'SHORT', '#1004'), line(7, 'UNMATCHED', null)]
            : [line(1, 'RECEIVED', '#1001'), line(4, 'SHORT', '#1004'), line(7, 'UNMATCHED', null)],
        },
      };
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/cash/rem_1');

    await screen.findByRole('heading', { name: 'Statement from PostEx' });
    expect(
      screen.getByRole('tab', { name: 'To look into (2)' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByText('Paid short')).toBeTruthy();
    expect(screen.getByText('No such parcel')).toBeTruthy();
    expect(screen.getByRole('link', { name: '#1004' }).getAttribute('href')).toBe(
      '/shop_1/orders/ord_4',
    );
    expect(screen.getByText('Row 7')).toBeTruthy();
    expect(screen.queryByText('PX001')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'All lines (12)' }));
    await screen.findByText('PX001');
    expect(screen.getByText('Received')).toBeTruthy();
  });

  it('names how long cash was owed, reads Excel as base64, and is for those who reconcile', async () => {
    expect(ageLabel({ fromDays: 0, toDays: 7 }, english)).toBe('0 to 7 days');
    expect(ageLabel({ fromDays: 31, toDays: null }, english)).toBe('Over 30 days');
    expect(await statementOf(new File(['a,b'], 'statement.CSV'))).toEqual({ csv: 'a,b' });
    expect(await statementOf(new File([new Uint8Array([80, 75, 3, 4])], 'statement.xlsx'))).toEqual(
      { xlsx: 'UEsDBA==' },
    );
    for (const role of ['owner', 'manager', 'accountant'] as const) {
      expect(sectionsOf(role).some((item) => item.to === '/$shopId/cash')).toBe(true);
    }
    for (const role of ['confirmation_agent', 'packer', 'marketer'] as const) {
      expect(sectionsOf(role).some((item) => item.to === '/$shopId/cash')).toBe(false);
    }
  });
});
