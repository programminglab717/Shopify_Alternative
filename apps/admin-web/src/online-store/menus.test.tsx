import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';
import { handleOf } from './menus';

const link = (
  id: string,
  title: string,
  type: string,
  extra: Record<string, unknown> = {},
  items: unknown[] = [],
) => ({ id, title, type, resourceId: null, url: null, items, ...extra });

const MAIN = {
  id: 'menu_1',
  title: 'Main menu',
  handle: 'main-menu',
  isDefault: true,
  items: [
    link('mi_1', 'Home', 'FRONTPAGE', { url: '/' }),
    link('mi_2', 'Women', 'COLLECTION', { resourceId: 'col_1', url: '/collections/eid-edit' }, [
      link('mi_3', 'Lawn', 'PRODUCT', { resourceId: 'prod_1', url: '/products/lawn-suit' }),
    ]),
  ],
};

const HELP = {
  id: 'menu_3',
  title: 'Help',
  handle: 'help',
  isDefault: false,
  items: [link('mi_9', 'Sizes', 'PAGE', { resourceId: 'pag_2', url: '/pages/size-guide' })],
};

function core(role: StaffRole) {
  return fakeCore(role, (operation) => {
    switch (operation) {
      case 'Menus':
        return {
          menus: {
            nodes: [
              MAIN,
              { ...HELP, id: 'menu_2', title: 'Footer menu', handle: 'footer', isDefault: true },
              HELP,
            ],
          },
        };
      case 'Collections':
        return {
          collections: {
            nodes: [
              { id: 'col_1', title: 'Eid edit', productsCount: 3, ruleSet: null },
              { id: 'col_2', title: 'Footwear', productsCount: 2, ruleSet: null },
            ],
          },
        };
      case 'Pages':
        return {
          pages: {
            nodes: [
              {
                id: 'pag_1',
                title: 'Returns',
                handle: 'returns',
                isPublished: true,
                publishedAt: null,
              },
              {
                id: 'pag_2',
                title: 'Size guide',
                handle: 'size-guide',
                isPublished: true,
                publishedAt: null,
              },
            ],
          },
        };
      case 'CollectionProductSearch':
        return { products: { nodes: [{ id: 'prod_9', title: 'Chappal', status: 'ACTIVE' }] } };
      case 'MenuCreate':
        return { menuCreate: { menu: { id: 'menu_7' }, userErrors: [] } };
      case 'MenuUpdate':
        return { menuUpdate: { menu: { id: 'menu_1' }, userErrors: [] } };
      case 'MenuDelete':
        return { menuDelete: { deletedMenuId: 'menu_3', userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).at(-1)?.variables;

describe("The online store's menus", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('changes a menu three levels deep, keeping its links, and saves it whole', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=menus');

    const main = await screen.findByRole('link', { name: /Main menu/ });
    expect(main.textContent).toContain('3 links');
    fireEvent.click(main);

    expect(((await screen.findByLabelText('Link 2.1: title')) as HTMLInputElement).value).toBe(
      'Lawn',
    );
    expect(screen.getByText('Goes to /products/lawn-suit')).toBeTruthy();
    expect((screen.getByLabelText('Link 2: collection') as HTMLSelectElement).value).toBe('col_1');
    fireEvent.click(screen.getByRole('button', { name: 'Move link 2 up' }));
    type('Link 1: title', 'Women’s');

    fireEvent.click(screen.getByRole('button', { name: 'Add a link' }));
    type('Link 3: title', 'Size guide');
    fireEvent.change(screen.getByLabelText('Link 3: goes to'), { target: { value: 'PAGE' } });
    expect(
      (screen.getByRole('button', { name: 'Save the menu' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Link 3: page'), { target: { value: 'pag_2' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add a link under link 1' }));
    type('Link 1.2: title', 'Sale');
    fireEvent.change(screen.getByLabelText('Link 1.2: goes to'), { target: { value: 'HTTP' } });
    type('Link 1.2: address', '/collections/all?sort=price');
    fireEvent.click(screen.getByRole('button', { name: 'Remove link 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save the menu' }));

    await waitFor(() =>
      expect(sentOf(fake, 'MenuUpdate')).toEqual({
        id: 'menu_1',
        title: 'Main menu',
        items: [
          {
            id: 'mi_2',
            title: 'Women’s',
            type: 'COLLECTION',
            resourceId: 'col_1',
            items: [
              { id: 'mi_3', title: 'Lawn', type: 'PRODUCT', resourceId: 'prod_1', items: [] },
              { title: 'Sale', type: 'HTTP', url: '/collections/all?sort=price', items: [] },
            ],
          },
          { title: 'Size guide', type: 'PAGE', resourceId: 'pag_2', items: [] },
        ],
      }),
    );
    expect(await screen.findByText(/Saved\. The storefront shows it/)).toBeTruthy();
  });

  it('makes a menu with a handle from its title and a link to a product found by name', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/menus/new');

    await screen.findByLabelText('Title');
    type('Title', 'Eid Footer Links');
    expect((screen.getByLabelText('Handle') as HTMLInputElement).value).toBe('eid-footer-links');
    fireEvent.click(screen.getByRole('button', { name: 'Add a link' }));
    type('Link 1: title', 'Chappals');
    fireEvent.change(screen.getByLabelText('Link 1: goes to'), { target: { value: 'PRODUCT' } });
    fireEvent.change(screen.getByLabelText('Find a product by name'), { target: { value: 'ch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Link to Chappal' }));
    expect(screen.getByText('Goes to Chappal')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make the menu' }));

    await waitFor(() =>
      expect(sentOf(fake, 'MenuCreate')).toEqual({
        title: 'Eid Footer Links',
        handle: 'eid-footer-links',
        items: [{ title: 'Chappals', type: 'PRODUCT', resourceId: 'prod_9', items: [] }],
      }),
    );
    expect(handleOf('  Ramzan — Offers! ')).toBe('ramzan-offers');
  });

  it('deletes a menu of its own after asking, but never the main or footer menu', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/menus/menu_1');
    await screen.findByLabelText('Link 1: title');
    expect(screen.queryByRole('button', { name: 'Delete the menu' })).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/menus/menu_3');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete the menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(sentOf(fake, 'MenuDelete')).toEqual({ id: 'menu_3' }));
  });

  it('leaves menus to owners and managers: a marketer writes pages alone', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/online-store?tab=menus');
    expect(await screen.findByRole('link', { name: 'New page' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Menus' })).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/online-store/menus/menu_1');
    expect(
      await screen.findByText("Only owners and managers change the shop's menus."),
    ).toBeTruthy();
  });
});
