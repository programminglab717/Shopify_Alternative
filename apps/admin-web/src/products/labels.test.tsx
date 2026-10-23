import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });

function product(id: string, title: string, variants: string[]) {
  return {
    id,
    title,
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    totalInventory: 4,
    tracksInventory: true,
    priceRange: { minVariantPrice: pkr('3200.00'), maxVariantPrice: pkr('3200.00') },
    media: [],
    variants: variants.map((variant) => ({ id: variant })),
  };
}

/** A fake core with a chappal in two sizes and a shawl in one, which lays out labels. */
function labelsCore() {
  return fakeCore('manager', (operation, variables) => {
    switch (operation) {
      case 'Products':
        return {
          products: {
            nodes: [
              product('prod_1', 'Peshawari Chappal', ['var_9', 'var_10']),
              product('prod_2', 'Ajrak Shawl', ['var_ajrak']),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      case 'ProductVariantsBarcodesGive':
        return { productVariantsBarcodesGive: { given: 2, had: 1, userErrors: [] } };
      case 'ProductLabels': {
        const items = variables.items as { copies: number }[];
        const labels = items.reduce((sum, item) => sum + item.copies, 0);
        return {
          productLabels: { title: `${labels} labels`, html: '<html>labels</html>', labels },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

/** A browser tab the page writes its labels into and prints. */
function printTab() {
  const written: string[] = [];
  const tab = {
    document: {
      open: vi.fn(),
      write: (html: string) => written.push(html),
      close: vi.fn(),
      fonts: { ready: Promise.resolve() },
    },
    focus: vi.fn(),
    print: vi.fn(),
    close: vi.fn(),
  };
  vi.stubGlobal(
    'open',
    vi.fn(() => tab),
  );
  return { tab, written };
}

describe('Price labels printed for the products chosen, in the admin (CAT-22)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('gives barcodes to the variants without, and prints as many labels of each as asked on the paper kept', async () => {
    const core = labelsCore();
    vi.stubGlobal('fetch', core.fetcher);
    const { tab, written } = printTab();
    renderAdmin('/shop_1/products');

    await screen.findByText('Peshawari Chappal');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    await press('Print labels for 2');
    expect(screen.getByRole('heading', { name: 'Price labels for 2 products' })).toBeTruthy();
    // A label for each of the three variants until the merchant asks for more.
    expect(screen.getByText('3 labels in all')).toBeTruthy();

    await press('Give barcodes to those without');
    await screen.findByText('Barcodes given: 2. Had one already: 1.');
    expect(
      core.sent.filter((each) => each.operation === 'ProductVariantsBarcodesGive')[0]?.variables,
    ).toEqual({ productIds: ['prod_1', 'prod_2'] });

    type('Labels of each variant', '0');
    expect(screen.getByText('A whole number, from 1.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Print labels' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    type('Labels of each variant', '400');
    expect(
      screen.getByText('At most 1,000 labels at once: choose fewer products or fewer of each.'),
    ).toBeTruthy();
    type('Labels of each variant', '2');
    expect(screen.getByText('6 labels in all')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Paper'), { target: { value: 'ROLL_50X25' } });
    await press('Print labels');

    await waitFor(() => expect(tab.print).toHaveBeenCalled());
    expect(written).toEqual(['<html>labels</html>']);
    expect(core.sent.filter((each) => each.operation === 'ProductLabels')[0]?.variables).toEqual({
      items: [
        { variantId: 'var_9', copies: 2 },
        { variantId: 'var_10', copies: 2 },
        { variantId: 'var_ajrak', copies: 2 },
      ],
      paper: 'ROLL_50X25',
    });
    expect(screen.queryByRole('heading', { name: 'Price labels for 2 products' })).toBeNull();

    // The roll is kept for the next print in this browser.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ajrak Shawl' }));
    await press('Print labels for 1');
    expect((screen.getByLabelText('Paper') as HTMLSelectElement).value).toBe('ROLL_50X25');
  });
});
