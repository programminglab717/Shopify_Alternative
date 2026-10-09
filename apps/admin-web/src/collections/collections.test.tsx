import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const product = (id: string, title: string, status = 'ACTIVE') => ({ id, title, status });

const HAND = {
  id: 'col_1',
  title: 'Eid edit',
  handle: 'eid-edit',
  description: 'Picked for Eid',
  sortOrder: 'MANUAL',
  productsCount: 3,
  ruleSet: null,
  products: {
    nodes: [
      product('prod_1', 'Lawn suit'),
      product('prod_2', 'Dupatta'),
      product('prod_3', 'Khussa', 'DRAFT'),
    ],
  },
};

const RULES = {
  ...HAND,
  id: 'col_2',
  title: 'On sale',
  handle: 'on-sale',
  description: '',
  sortOrder: 'CREATED_DESC',
  productsCount: 1,
  ruleSet: {
    appliedDisjunctively: false,
    rules: [{ column: 'IS_PRICE_REDUCED', relation: 'IS_SET', condition: '' }],
  },
  products: { nodes: [product('prod_1', 'Lawn suit')] },
};

const done = (field: string) => ({ [field]: { collection: { id: 'col_1' }, userErrors: [] } });

function core(role: StaffRole) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Collections':
        return {
          collections: {
            nodes: [
              { id: 'col_1', title: 'Eid edit', productsCount: 3, ruleSet: null },
              {
                id: 'col_2',
                title: 'On sale',
                productsCount: 1,
                ruleSet: { appliedDisjunctively: false },
              },
            ],
          },
        };
      case 'Collection':
        return { collection: variables.id === 'col_2' ? RULES : HAND };
      case 'CollectionProductSearch':
        return {
          products: { nodes: [product('prod_1', 'Lawn suit'), product('prod_9', 'Chappal')] },
        };
      case 'CollectionCreate':
        return { collectionCreate: { collection: { id: 'col_7' }, userErrors: [] } };
      case 'CollectionUpdate':
        return done('collectionUpdate');
      case 'CollectionAddProducts':
        return done('collectionAddProducts');
      case 'CollectionRemoveProducts':
        return done('collectionRemoveProducts');
      case 'CollectionReorderProducts':
        return done('collectionReorderProducts');
      case 'CollectionDelete':
        return { collectionDelete: { deletedCollectionId: 'col_1', userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).at(-1)?.variables;

describe('Collections', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists collections made by hand and by rules, and makes one by rules', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/collections');

    const eid = await screen.findByRole('link', { name: /Eid edit/ });
    expect(eid.textContent).toContain('Made by hand');
    expect(eid.textContent).toContain('3 products');
    expect(screen.getByRole('link', { name: /On sale/ }).textContent).toContain('Made by rules');
    fireEvent.click(screen.getByRole('link', { name: 'New collection' }));

    await screen.findByLabelText('Title');
    type('Title', 'Lawn under 5,000');
    fireEvent.click(screen.getByLabelText(/By rules/));
    fireEvent.change(screen.getByLabelText('Rule 1: value'), { target: { value: 'lawn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule' }));
    fireEvent.change(screen.getByLabelText('Rule 2: what'), {
      target: { value: 'IS_PRICE_REDUCED' },
    });
    // On sale takes no value.
    expect(screen.queryByLabelText('Rule 2: value')).toBeNull();
    fireEvent.change(screen.getByLabelText('Rule 2: what'), { target: { value: 'VARIANT_PRICE' } });
    fireEvent.change(screen.getByLabelText('Rule 2: how'), { target: { value: 'LESS_THAN' } });
    expect(
      (screen.getByRole('button', { name: 'Make the collection' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Rule 2: value'), { target: { value: '5000' } });
    fireEvent.click(screen.getByLabelText('any rule'));
    fireEvent.click(screen.getByRole('button', { name: 'Make the collection' }));

    await waitFor(() =>
      expect(sentOf(fake, 'CollectionCreate')).toEqual({
        input: {
          title: 'Lawn under 5,000',
          sortOrder: 'CREATED_DESC',
          ruleSet: {
            appliedDisjunctively: true,
            rules: [
              { column: 'TAG', relation: 'EQUALS', condition: 'lawn' },
              { column: 'VARIANT_PRICE', relation: 'LESS_THAN', condition: '5000' },
            ],
          },
        },
      }),
    );
    await waitFor(() => expect(sentOf(fake, 'Collection')).toEqual({ id: 'col_7' }));
  });

  it('puts a collection made by hand in order, takes a product out and adds another', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/collections/col_1');

    const products = await screen.findByRole('region', { name: 'Products (3)' });
    expect(within(products).getByText('Draft')).toBeTruthy();
    expect(
      (within(products).getByRole('button', { name: 'Move Lawn suit up' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(within(products).getByRole('button', { name: 'Move Dupatta up' }));
    await waitFor(() =>
      expect(sentOf(fake, 'CollectionReorderProducts')).toEqual({
        id: 'col_1',
        moves: [{ id: 'prod_2', newPosition: 1 }],
      }),
    );
    fireEvent.click(within(products).getByRole('button', { name: 'Move Dupatta down' }));
    await waitFor(() =>
      expect(sentOf(fake, 'CollectionReorderProducts')).toEqual({
        id: 'col_1',
        moves: [{ id: 'prod_2', newPosition: 3 }],
      }),
    );
    fireEvent.click(within(products).getByRole('button', { name: 'Take Khussa out' }));
    await waitFor(() =>
      expect(sentOf(fake, 'CollectionRemoveProducts')).toEqual({
        id: 'col_1',
        productIds: ['prod_3'],
      }),
    );

    fireEvent.change(within(products).getByLabelText('Find products to add'), {
      target: { value: 'ch' },
    });
    fireEvent.click(within(products).getByRole('button', { name: 'Find' }));
    expect(await within(products).findByText('In it')).toBeTruthy();
    fireEvent.click(within(products).getByRole('button', { name: 'Add Chappal' }));
    await waitFor(() =>
      expect(sentOf(fake, 'CollectionAddProducts')).toEqual({
        id: 'col_1',
        productIds: ['prod_9'],
      }),
    );
  });

  it("changes a collection's title and order, and deletes it after asking", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/collections/col_1');

    const details = await screen.findByRole('region', { name: 'Details' });
    fireEvent.change(within(details).getByLabelText('Title'), { target: { value: 'Eid 2026' } });
    fireEvent.change(within(details).getByLabelText('Show its products'), {
      target: { value: 'PRICE_ASC' },
    });
    fireEvent.click(within(details).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sentOf(fake, 'CollectionUpdate')).toEqual({
        input: { id: 'col_1', title: 'Eid 2026', sortOrder: 'PRICE_ASC' },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete the collection' }));
    expect(screen.getByText('Delete Eid edit? Its products stay in the shop.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await waitFor(() =>
      expect(sentOf(fake, 'CollectionDelete')).toEqual({ input: { id: 'col_1' } }),
    );
    await waitFor(() => expect(sentOf(fake, 'Collections')).toEqual({ query: null }));
  });

  it('shows a collection made by rules to a packer as it is, with nothing to change', async () => {
    vi.stubGlobal('fetch', core('packer').fetcher);
    renderAdmin('/shop_1/collections/col_2');

    const products = await screen.findByRole('region', { name: 'Products (1)' });
    expect(within(products).getByText(/join and leave as they match its rules/)).toBeTruthy();
    expect(screen.getByText('Newest first')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Take .* out$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete the collection' })).toBeNull();
    expect(screen.queryByLabelText('Find products to add')).toBeNull();
  });
});
