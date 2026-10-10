import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });

function product(id: string, title: string) {
  return {
    id,
    title,
    status: 'DRAFT',
    productType: null,
    vendor: null,
    totalInventory: 0,
    tracksInventory: false,
    priceRange: { minVariantPrice: pkr('1800.00'), maxVariantPrice: pkr('1800.00') },
    media: [],
    variants: [{ id: `${id}_var` }],
  };
}

/**
 * A fake core with a lawn suit, an ajrak and a khussa, which refuses the khussa as having too many
 * tags, and has a collection made by hand and one with rules.
 */
function bulkCore(role: StaffRole) {
  const products = [
    product('prod_1', 'Lawn Suit'),
    product('prod_2', 'Ajrak Shawl'),
    product('prod_3', 'Multani Khussa'),
  ];
  const done = (ids: string[]) => ids.filter((id) => id !== 'prod_3').map((id) => ({ id }));
  const refusedKhussa = (ids: string[]) =>
    ids.includes('prod_3')
      ? [
          {
            field: ['ids', String(ids.indexOf('prod_3'))],
            code: 'TOO_MANY',
            message: 'Tags can have at most 250',
          },
        ]
      : [];
  return fakeCore(role, (operation, variables) => {
    const ids = (variables.ids ?? variables.productIds) as string[];
    switch (operation) {
      case 'Products':
        return {
          products: { nodes: products, pageInfo: { hasNextPage: false, endCursor: null } },
        };
      case 'ProductBulkUpdateStatus':
        return { productBulkUpdateStatus: { products: ids.map((id) => ({ id })), userErrors: [] } };
      case 'ProductBulkAddTags':
        return { productBulkAddTags: { products: done(ids), userErrors: refusedKhussa(ids) } };
      case 'ProductBulkDelete':
        return { productBulkDelete: { deletedProductIds: ids, userErrors: [] } };
      case 'Collections':
        return {
          collections: {
            nodes: [
              {
                id: 'col_smart',
                title: 'Lawn',
                productsCount: 4,
                ruleSet: { appliedDisjunctively: false },
              },
              { id: 'col_eid', title: 'Eid Edit', productsCount: 2, ruleSet: null },
            ],
          },
        };
      case 'CollectionAddProducts':
        return { collectionAddProducts: { collection: { id: 'col_eid' }, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (core: ReturnType<typeof bulkCore>, operation: string) =>
  core.sent.filter((each) => each.operation === operation).map((each) => each.variables);

const choose = (title: string) =>
  fireEvent.click(screen.getByRole('checkbox', { name: `Select ${title}` }));

describe('Products acted on many at once, in the admin (CAT-04)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the products chosen in the store, and tags them, saying those refused by title', async () => {
    const core = bulkCore('manager');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/products');

    await screen.findByText('Lawn Suit');
    choose('Lawn Suit');
    choose('Ajrak Shawl');
    expect(screen.getByText('2 selected')).toBeTruthy();
    await press('Set status of 2');
    expect(screen.getByRole('heading', { name: 'Status of 2 products' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^Active/ }));
    await press('Save for 2 products');
    await screen.findByText('2 products updated.');
    expect(sentOf(core, 'ProductBulkUpdateStatus')).toEqual([
      { ids: ['prod_1', 'prod_2'], status: 'ACTIVE' },
    ]);
    // The choice is let go once done.
    expect(screen.getByText('0 selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    await press('Tag 3');
    expect(screen.getByRole('heading', { name: 'Tag 3 products' })).toBeTruthy();
    type('Tags', 'eid, Eid , lawn');
    await press('Add the tags');
    await screen.findByText('2 products updated.');
    expect(screen.getByText('1 could not be updated:')).toBeTruthy();
    expect(screen.getByText('Multani Khussa: Tags can have at most 250')).toBeTruthy();
    expect(sentOf(core, 'ProductBulkAddTags')).toEqual([
      { ids: ['prod_1', 'prod_2', 'prod_3'], tags: ['eid', 'Eid', 'lawn'] },
    ]);
  });

  it('puts the products chosen in a collection made by hand, deletes them once sure, and is for those who change products', async () => {
    const core = bulkCore('owner');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/products');

    await screen.findByText('Lawn Suit');
    choose('Ajrak Shawl');
    await press('Add 1 to a collection');
    expect(screen.getByRole('heading', { name: 'Add 1 product to a collection' })).toBeTruthy();
    const collection = (await screen.findByLabelText('Collection')) as HTMLSelectElement;
    // Those with rules take products by them, so only those made by hand are offered.
    expect([...collection.options].map((option) => option.text)).toEqual(['Eid Edit']);
    await press('Add to the collection');
    await screen.findByText('1 product updated.');
    expect(sentOf(core, 'CollectionAddProducts')).toEqual([
      { id: 'col_eid', productIds: ['prod_2'] },
    ]);

    choose('Lawn Suit');
    choose('Multani Khussa');
    await press('Delete 2');
    expect(screen.getByRole('heading', { name: 'Delete 2 products?' })).toBeTruthy();
    await press('Keep them');
    expect(sentOf(core, 'ProductBulkDelete')).toEqual([]);
    await press('Delete 2');
    await press('Delete 2 products');
    await screen.findByText('2 products updated.');
    expect(sentOf(core, 'ProductBulkDelete')).toEqual([{ ids: ['prod_1', 'prod_3'] }]);
    cleanup();

    vi.stubGlobal('fetch', bulkCore('packer').fetcher);
    renderAdmin('/shop_1/products');
    await screen.findByText('Lawn Suit');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
