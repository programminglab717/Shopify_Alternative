import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const PAGE = {
  bio: 'Hand-printed lawn from Multan',
  links: [{ title: 'Sale', url: '/collections/sale' }],
  products: [{ productId: 'prod_1', variantId: null }],
};

const money = (amount: string) => ({ amount, currencyCode: 'PKR' });

const PRODUCTS: Record<string, unknown> = {
  prod_1: {
    id: 'prod_1',
    title: 'Lawn suit',
    status: 'ACTIVE',
    media: [],
    variants: [
      { id: 'var_1', title: 'Small', price: money('4500.00') },
      { id: 'var_2', title: 'Large', price: money('4800.00') },
    ],
  },
  prod_2: {
    id: 'prod_2',
    title: 'Chikankari kurta',
    status: 'DRAFT',
    media: [],
    variants: [{ id: 'var_3', title: 'Default Title', price: money('6200.00') }],
  },
};

function core(role: StaffRole, whatsappNumber: string | null = '+923001234567') {
  let page = PAGE;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'LinkPage':
        return {
          shop: { id: 'shop_1', url: 'https://zari.hatti.pk' },
          onlineStorePreferences: { whatsappNumber, linkPage: page },
        };
      case 'LinkPageProduct':
        return { product: PRODUCTS[variables.id as string] ?? null };
      case 'CollectionProductSearch':
        return {
          products: { nodes: [{ id: 'prod_2', title: 'Chikankari kurta', status: 'DRAFT' }] },
        };
      case 'LinkPageTaps':
        return {
          linkPageTaps: {
            total: 42,
            links: [
              { url: '/collections/sale', title: 'Sale', source: 'LINK', taps: 30 },
              { url: 'https://wa.me/923001234567', title: null, source: 'WHATSAPP', taps: 12 },
              { url: '/collections/eid', title: null, source: 'REMOVED', taps: 0 },
            ],
          },
        };
      case 'LinkPageUpdate': {
        const given = (variables.input as { linkPage: Record<string, unknown> }).linkPage;
        const links = given.links as { url: string }[] | undefined;
        if (links?.some((link) => !link.url.startsWith('/') && !link.url.startsWith('https://'))) {
          const index = links.findIndex((link) => !link.url.startsWith('/'));
          return {
            onlineStorePreferencesUpdate: {
              preferences: null,
              userErrors: [
                {
                  field: ['input', 'linkPage', 'links', String(index), 'url'],
                  code: 'INVALID',
                  message:
                    'Link must be a path on the store, like /collections/sale, or an https:// address',
                },
              ],
            },
          };
        }
        page = { ...page, ...given };
        return {
          onlineStorePreferencesUpdate: {
            preferences: { linkPage: page },
            userErrors: [],
          },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

/** How many days a taps report sent spans. */
const span = (sent: unknown) => {
  const { from, before } = sent as { from: string; before: string };
  return Math.round((Date.parse(before) - Date.parse(from)) / 86_400_000);
};

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("The shop's link page", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('says where the page is, and changes its bio, links and products, saved together', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store');

    fireEvent.click(await screen.findByRole('tab', { name: 'Link page' }));
    expect(await screen.findByText('https://zari.hatti.pk/links')).toBeTruthy();
    expect(screen.getByText('It links a chat on WhatsApp with +923001234567 too.')).toBeTruthy();
    expect((screen.getByLabelText('Bio') as HTMLTextAreaElement).value).toBe(PAGE.bio);
    expect(await screen.findByText('Lawn suit')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save the link page' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    type('Bio', 'Hand-printed lawn from Multan. Delivery across Pakistan.');
    fireEvent.click(screen.getByRole('button', { name: 'Add a link' }));
    type('Link 2: title', 'Our Daraz shop');
    type('Link 2: address', 'https://www.daraz.pk/shop/zari');
    fireEvent.click(screen.getByRole('button', { name: 'Move link 2 up' }));
    fireEvent.change(screen.getByLabelText('Product 1: which'), { target: { value: 'var_2' } });

    type('Find a product to add', 'kurta');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: /Chikankari kurta/ }));
    expect(await screen.findByText('Not shown while it is not active')).toBeTruthy();
    // A single variant leaves nothing to choose.
    expect(screen.queryByLabelText('Product 2: which')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Chikankari kurta/ }));
    expect(screen.getByText(/^Chikankari kurta is on the page already/)).toBeTruthy();

    fireEvent.click(save);
    expect(await screen.findByText(/^Saved\./)).toBeTruthy();
    expect(sentOf(fake, 'LinkPageUpdate')).toEqual([
      {
        input: {
          linkPage: {
            bio: 'Hand-printed lawn from Multan. Delivery across Pakistan.',
            links: [
              { title: 'Our Daraz shop', url: 'https://www.daraz.pk/shop/zari' },
              { title: 'Sale', url: '/collections/sale' },
            ],
            products: [
              { productId: 'prod_1', variantId: 'var_2' },
              { productId: 'prod_2', variantId: null },
            ],
          },
        },
      },
    ]);
  });

  it("names the link the core turns down, and counts each link's taps over a period", async () => {
    const fake = core('manager', null);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=links');

    expect(await screen.findByText(/Add the shop's WhatsApp number/)).toBeTruthy();
    type('Link 1: address', 'daraz.pk/shop/zari');
    fireEvent.click(screen.getByRole('button', { name: 'Save the link page' }));
    expect(
      await screen.findByText(
        'Link 1: Link must be a path on the store, like /collections/sale, or an https:// address',
      ),
    ).toBeTruthy();
    expect(sentOf(fake, 'LinkPageUpdate')).toEqual([
      { input: { linkPage: { links: [{ title: 'Sale', url: 'daraz.pk/shop/zari' }] } } },
    ]);

    expect(await screen.findByText('42 taps')).toBeTruthy();
    const taps = screen.getByRole('list', { name: 'Taps' });
    const rows = within(taps).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Sale/collections/sale30',
      'Chat on WhatsApphttps://wa.me/92300123456712',
      'A link since taken off/collections/eid0',
    ]);
    expect(span(sentOf(fake, 'LinkPageTaps')[0])).toBe(30);

    fireEvent.change(screen.getByLabelText('Over'), { target: { value: '7' } });
    await waitFor(() => expect(span(sentOf(fake, 'LinkPageTaps').at(-1))).toBe(7));
  });

  it('leaves the link page to owners and managers', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/online-store');
    expect(await screen.findByRole('tab', { name: 'Pages' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Link page' })).toBeNull();
  });
});
