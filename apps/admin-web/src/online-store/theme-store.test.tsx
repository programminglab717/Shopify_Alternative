import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const AT = new Date(Date.now() - 3_600_000).toISOString();

const MAIN = {
  id: 'thm_1',
  name: 'Hatti Base',
  role: 'MAIN',
  base: 'hatti-base',
  previewUrl: 'https://zari.hatti.pk/?preview_theme_id=thm_1',
  publishAt: null,
  createdAt: AT,
  updatedAt: AT,
};

const LISTINGS = [
  {
    id: 'thls_1',
    name: 'Saada',
    description: 'Plain and quick',
    designer: 'Rang Studio',
    base: 'hatti-base',
    price: { amount: '0.00' },
    free: true,
    bought: false,
  },
  {
    id: 'thls_2',
    name: 'Basant',
    description: 'For spring lawn',
    designer: 'Rang Studio',
    base: 'hatti-base',
    price: { amount: '5000.00' },
    free: false,
    bought: false,
  },
];

function core(role: StaffRole) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Themes':
        return { themes: { nodes: [MAIN] }, platformThemes: [] };
      case 'ThemeStore':
        return { themeStore: LISTINGS };
      case 'ThemeStoreInstall':
        return {
          themeStoreInstall: {
            theme: { ...MAIN, id: 'thm_2', name: 'Saada', role: 'UNPUBLISHED' },
            userErrors: [],
          },
        };
      case 'ThemeStoreBuy':
        return {
          themeStoreBuy: { invoiceId: 'binv_9', amount: { amount: '5800.00' }, userErrors: [] },
        };
      case 'BillingInvoicePay':
        return {
          billingInvoicePay: {
            checkoutUrl: `https://pay.example.pk/checkout/${String(variables.id)}`,
            userErrors: [],
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('The theme store (OS-20, ADR-853)', () => {
  const assign = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
    assign.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('installs a free theme at once, and has the owner buy a paid one through Hatti', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=themes');
    vi.stubGlobal('location', { ...window.location, assign });

    const store = await screen.findByRole('list', { name: 'Theme store' });
    expect(within(store).getByText('Free')).toBeTruthy();
    expect(within(store).getAllByText('By Rang Studio')).toHaveLength(2);

    fireEvent.click(within(store).getByRole('button', { name: 'Install Saada' }));
    expect(await screen.findByText('Saada is installed: find it among your themes.')).toBeTruthy();
    expect(sentOf(fake, 'ThemeStoreInstall')).toEqual([{ id: 'thls_1' }]);

    fireEvent.click(within(store).getByRole('button', { name: 'Buy Basant for Rs 5,000' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://pay.example.pk/checkout/binv_9'),
    );
    expect(sentOf(fake, 'ThemeStoreBuy')).toEqual([{ id: 'thls_2' }]);
  });

  it('leaves buying to the owner', async () => {
    vi.stubGlobal('fetch', core('manager').fetcher);
    renderAdmin('/shop_1/online-store?tab=themes');
    const store = await screen.findByRole('list', { name: 'Theme store' });
    expect(within(store).queryByRole('button', { name: /^Buy/ })).toBeNull();
    expect(within(store).getByText("Only the shop's owner buys themes.")).toBeTruthy();
  });
});
