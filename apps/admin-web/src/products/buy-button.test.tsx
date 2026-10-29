import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

function product(status: string) {
  return {
    id: 'prod_1',
    title: 'Khussa',
    description: '',
    handle: 'khussa',
    status,
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: false,
    isGiftCard: false,
    seo: { title: null, description: null },
    options: [],
    media: [],
    variants: [
      {
        id: 'var_1',
        title: 'Default Title',
        price: { amount: '2500.00', currencyCode: 'PKR' },
        compareAtPrice: null,
        sku: null,
        taxCode: null,
        selectedOptions: [],
        inventoryQuantity: 0,
        soldLast30Days: 0,
        daysOfStockLeft: null,
        inventoryItem: {
          id: 'item_1',
          tracked: false,
          inventoryPolicy: 'DENY',
          inventoryLevels: [],
        },
      },
    ],
  };
}

function core(status = 'ACTIVE') {
  return fakeCore('owner', (operation) => {
    switch (operation) {
      case 'Product':
        return {
          location: { id: 'loc_1', name: 'Main location' },
          shop: { url: 'https://zari.hatti.pk/' },
          product: product(status),
        };
      case 'ProductCategories':
        return { productCategories: [] };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe("A product's buy button for other websites (CH-08, ADR-860)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('gives the code to paste, in the language chosen', async () => {
    vi.stubGlobal('fetch', core().fetcher);
    renderAdmin('/shop_1/products/prod_1');
    const heading = await screen.findByRole('heading', { name: 'Buy button' });
    const card = heading.closest('section') ?? heading.parentElement!.parentElement!;
    expect(
      within(card).getByText(
        (_text, node) =>
          node?.tagName === 'PRE' &&
          node.textContent ===
            '<div data-hatti-buy-button="khussa"></div>\n<script src="https://zari.hatti.pk/buy-button.js" async></script>',
      ),
    ).toBeTruthy();
    fireEvent.change(within(card).getByLabelText('Language of the button'), {
      target: { value: 'ur' },
    });
    expect(within(card).getByText(/data-language="ur"/)).toBeTruthy();
  });

  it("puts the buttons in the shop's own colour where it picks one (ADR-925)", async () => {
    vi.stubGlobal('fetch', core().fetcher);
    renderAdmin('/shop_1/products/prod_1');
    const heading = await screen.findByRole('heading', { name: 'Buy button' });
    const card = heading.closest('section') ?? heading.parentElement!.parentElement!;
    fireEvent.click(within(card).getByRole('checkbox', { name: /Buttons in your own colour/ }));
    fireEvent.change(within(card).getByLabelText('Colour of the buttons'), {
      target: { value: '#7c2d12' },
    });
    expect(
      within(card).getByText(/data-hatti-buy-button="khussa" data-color="#7c2d12"/),
    ).toBeTruthy();
    fireEvent.click(within(card).getByRole('checkbox', { name: /Buttons in your own colour/ }));
    expect(within(card).queryByText(/data-color/)).toBeNull();
  });

  it('lays the product out as the shop picks, the default said in nothing (ADR-949)', async () => {
    vi.stubGlobal('fetch', core().fetcher);
    renderAdmin('/shop_1/products/prod_1');
    const heading = await screen.findByRole('heading', { name: 'Buy button' });
    const card = heading.closest('section') ?? heading.parentElement!.parentElement!;
    const layout = within(card).getByLabelText('Layout') as HTMLSelectElement;
    expect([...layout.options].map((option) => option.textContent)).toEqual([
      'A card',
      'Across, its photo beside it',
    ]);
    expect(within(card).queryByText(/data-layout/)).toBeNull();
    fireEvent.change(layout, { target: { value: 'horizontal' } });
    expect(
      within(card).getByText(/data-hatti-buy-button="khussa" data-layout="horizontal"/),
    ).toBeTruthy();
  });

  it('is offered for products the storefront shows alone', async () => {
    vi.stubGlobal('fetch', core('DRAFT').fetcher);
    renderAdmin('/shop_1/products/prod_1');
    await screen.findByRole('heading', { name: 'Khussa' });
    expect(screen.queryByRole('heading', { name: 'Buy button' })).toBeNull();
  });
});
