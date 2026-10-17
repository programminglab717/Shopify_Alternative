import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, LATER, renderAdmin, signedIn } from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const SETTLEMENT = {
  id: 'pst_1',
  accountId: 'pga_1',
  gateway: 'safepay',
  gatewayName: 'Safepay',
  reference: 'SP-2026-10-15',
  createdAt: LATER,
  lineCount: 3,
  issueCount: 2,
  gross: rupees('4400.00'),
  fees: rupees('110.00'),
  tax: rupees('44.00'),
  net: rupees('4246.00'),
};

describe("Gateways' settlements, in the admin", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists settlements and imports a statement once it is checked, for the account chosen', async () => {
    const core = fakeCore('accountant', (operation, variables) => {
      if (operation === 'PaymentSettlements') {
        return {
          paymentSettlementAccounts: [
            { id: 'pga_1', gateway: 'safepay', gatewayName: 'Safepay', sandbox: false },
            { id: 'pga_2', gateway: 'payfast', gatewayName: 'PayFast', sandbox: true },
          ],
          paymentSettlements: [SETTLEMENT],
        };
      }
      if (operation === 'PaymentSettlementImport') {
        return {
          paymentSettlementImport: {
            dryRun: variables.dryRun,
            rows: 4,
            rowErrorCount: 0,
            rowErrors: [],
            outcomes: { matched: 1, differs: 1, unmatched: 1, repeated: 0, refund: 0 },
            gross: rupees('4400.00'),
            fees: rupees('110.00'),
            tax: rupees('44.00'),
            net: rupees('4246.00'),
            settlement: variables.dryRun ? null : { id: 'pst_2' },
            userErrors: [],
          },
        };
      }
      if (operation === 'PaymentSettlement') return { paymentSettlement: null };
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    const { router } = renderAdmin('/shop_1/settlements');

    await screen.findByRole('heading', { name: "Gateways' settlements" });
    expect(screen.getByRole('link', { name: /SP-2026-10-15/ }).getAttribute('href')).toBe(
      '/shop_1/settlements/pst_1',
    );
    expect(screen.getByText('2 lines to look into')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'PayFast (sandbox)' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Gateway account'), { target: { value: 'pga_2' } });
    fireEvent.change(screen.getByLabelText('Settlement or payout reference'), {
      target: { value: 'PF-0912' },
    });
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Statement file'), {
        target: {
          files: [new File(['Txn Ref,Amount\nT1,3000\n'], 'payfast.csv', { type: 'text/csv' })],
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Check the statement' }));

    await screen.findByText('4 rows: Rs 4,246 paid over, after Rs 110 in fees and Rs 44 in tax.');
    expect(screen.getByText('Another amount')).toBeTruthy();
    expect(screen.getByText('No such payment')).toBeTruthy();
    expect(screen.queryByText('Settled before')).toBeNull();
    expect(
      core.sent.find((each) => each.operation === 'PaymentSettlementImport')?.variables,
    ).toEqual({
      accountId: 'pga_2',
      reference: 'PF-0912',
      dryRun: true,
      csv: 'Txn Ref,Amount\nT1,3000\n',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Import it' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/shop_1/settlements/pst_2'));
  });

  it("shows a settlement's lines to look into first, each with its payment's order", async () => {
    const line = (
      row: number,
      transactionRef: string,
      outcome: string,
      orderId: string | null,
    ) => ({
      row,
      transactionRef,
      orderId,
      outcome,
      gross: rupees(outcome === 'DIFFERS' ? '1500.00' : '2000.00'),
      fees: rupees('50.00'),
      tax: rupees('20.00'),
      paid: orderId ? rupees(outcome === 'DIFFERS' ? '1600.00' : '2000.00') : null,
    });
    const core = fakeCore('owner', (operation) => {
      if (operation !== 'PaymentSettlement') throw new Error(`unexpected ${operation}`);
      return {
        paymentSettlement: {
          ...SETTLEMENT,
          lines: [
            line(3, 'track_A1', 'MATCHED', 'ord_1'),
            line(4, 'track_B2', 'DIFFERS', 'ord_2'),
            line(5, 'track_zz', 'UNMATCHED', null),
          ],
        },
      };
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settlements/pst_1');

    await screen.findByRole('heading', { name: 'Settlement from Safepay' });
    expect(screen.getByText('Rs 4,246')).toBeTruthy();
    expect(
      screen.getByRole('tab', { name: 'To look into (2)' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByText('the payment was Rs 1,600')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Its order' }).getAttribute('href')).toBe(
      '/shop_1/orders/ord_2',
    );
    expect(screen.getByText('Row 5')).toBeTruthy();
    expect(screen.queryByText('track_A1')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'All lines (3)' }));
    await screen.findByText('track_A1');
    expect(screen.getByText('Matched')).toBeTruthy();
  });
});
