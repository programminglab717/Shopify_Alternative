import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

describe("Prices in shoppers' currencies (OS-21, ADR-865)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows prices in the currencies picked, at a fixed rate or the day's, rounded as asked", async () => {
    signedIn();
    let currencies: Record<string, unknown>[] = [
      { currencyCode: 'AED', fixedRate: null, rounding: 'ninety_nine' },
    ];
    const fake = fakeCore('manager', (operation, variables) => {
      switch (operation) {
        case 'Currencies':
          return {
            presentmentCurrencies: currencies,
            currencyRates: [
              { currencyCode: 'AED', rate: '76.4526', rateDate: '2026-10-27' },
              { currencyCode: 'GBP', rate: '372.0238', rateDate: '2026-10-27' },
            ],
          };
        case 'PresentmentCurrenciesSet': {
          currencies = (variables.input as Record<string, unknown>[]).map((each) => ({
            ...each,
          }));
          return {
            presentmentCurrenciesSet: { presentmentCurrencies: currencies, userErrors: [] },
          };
        }
        default:
          return undefined;
      }
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/currencies');
    const dirham = await screen.findByRole('checkbox', {
      name: 'Show prices in AED (UAE dirham)',
    });
    expect((dirham as HTMLInputElement).checked).toBe(true);
    expect(
      screen.getByText("Leave it blank to use the day's rate: 1 AED = Rs 76.4526 on 2026-10-27."),
    ).toBeTruthy();
    // Pounds, at a rate the shop fixes, to the cent.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show prices in GBP (British pound)' }));
    type('Rupees for 1 GBP', '372');
    fireEvent.click(screen.getByRole('button', { name: 'Save currencies' }));
    await waitFor(() =>
      expect(
        fake.sent.filter((each) => each.operation === 'PresentmentCurrenciesSet').at(-1)?.variables,
      ).toEqual({
        input: [
          { currencyCode: 'AED', fixedRate: null, rounding: 'ninety_nine' },
          { currencyCode: 'GBP', fixedRate: '372', rounding: 'exact' },
        ],
      }),
    );
    expect(await screen.findByText('Saved. Your store shows them in a minute.')).toBeTruthy();
  });
});
