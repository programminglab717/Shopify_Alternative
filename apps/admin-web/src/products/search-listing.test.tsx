import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { excerpt } from '../online-store/search-listing';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

function product(seo: { title: string | null; description: string | null }) {
  return {
    id: 'prod_1',
    title: 'Khussa',
    description: 'Hand-stitched leather khussa from Multan, with mirror work across the toe.',
    handle: 'khussa',
    status: 'ACTIVE',
    productType: null,
    vendor: null,
    tags: [],
    totalInventory: 0,
    tracksInventory: false,
    isGiftCard: false,
    seo,
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

function core(seo: { title: string | null; description: string | null }) {
  return fakeCore('owner', (operation) => {
    switch (operation) {
      case 'Product':
        return {
          location: { id: 'loc_1', name: 'Main location' },
          shop: { url: 'https://zari.pk' },
          product: product(seo),
        };
      case 'ProductUpdate':
        return { productUpdate: { product: { id: 'prod_1' }, userErrors: [] } };
      case 'ProductCategories':
        return { productCategories: [] };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>) =>
  fake.sent.filter((each) => each.operation === 'ProductUpdate').map((each) => each.variables);

describe("A product's search engine listing, on its page (OS-09, ADR-600)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('previews its own title and text until given its own, then saves them', async () => {
    const fake = core({ title: null, description: null });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/prod_1');

    const preview = await screen.findByRole('figure', { name: 'How a search engine lists it' });
    expect(within(preview).getByText('zari.pk › products › khussa')).toBeTruthy();
    expect(within(preview).getByText('Khussa')).toBeTruthy();
    expect(
      within(preview).getByText(
        'Hand-stitched leather khussa from Multan, with mirror work across the toe.',
      ),
    ).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save listing' });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Page title'), {
      target: { value: ' Multani khussa for Eid ' },
    });
    fireEvent.change(screen.getByLabelText('Meta description'), {
      target: { value: 'Leather khussa,\nstitched by hand in Multan.' },
    });
    expect(within(preview).getByText('Multani khussa for Eid')).toBeTruthy();
    expect(within(preview).getByText('Leather khussa, stitched by hand in Multan.')).toBeTruthy();
    expect(screen.getByText('22 letters; search engines show about 60.')).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() =>
      expect(sentOf(fake)).toEqual([
        {
          input: {
            id: 'prod_1',
            seo: {
              title: 'Multani khussa for Eid',
              description: 'Leather khussa, stitched by hand in Multan.',
            },
          },
        },
      ]),
    );
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);

    // Cleared, the product's own come back.
    fireEvent.change(screen.getByLabelText('Page title'), { target: { value: '' } });
    expect(within(preview).getByText('Khussa')).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() =>
      expect(sentOf(fake)[1]).toEqual({
        input: {
          id: 'prod_1',
          seo: { title: '', description: 'Leather khussa, stitched by hand in Multan.' },
        },
      }),
    );
  });

  it('shows the title and description it was given, and cuts long ones where engines do', () => {
    expect(excerpt('Short', 60)).toBe('Short');
    expect(excerpt('<p>Lawn   suit</p>', 60)).toBe('Lawn suit');
    expect(excerpt('a'.repeat(30) + ' ' + 'b'.repeat(40), 60)).toBe(`${'a'.repeat(30)}…`);
    expect(Array.from(excerpt('ب'.repeat(200), 160))).toHaveLength(160);
  });

  it('keeps what it was given', async () => {
    vi.stubGlobal(
      'fetch',
      core({ title: 'Khussa | Zari', description: 'Made in Multan.' }).fetcher,
    );
    renderAdmin('/shop_1/products/prod_1');
    expect(((await screen.findByLabelText('Page title')) as HTMLInputElement).value).toBe(
      'Khussa | Zari',
    );
    expect((screen.getByLabelText('Meta description') as HTMLTextAreaElement).value).toBe(
      'Made in Multan.',
    );
    const preview = screen.getByRole('figure', { name: 'How a search engine lists it' });
    expect(within(preview).getByText('Made in Multan.')).toBeTruthy();
  });
});
