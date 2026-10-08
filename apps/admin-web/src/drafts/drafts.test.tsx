import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftOrderDetail } from '../api/types';
import { fakeCore, LATER, press, renderAdmin, signedIn, type } from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const LAWN = {
  id: 'prod_1',
  title: 'Lawn suit',
  variants: [
    {
      id: 'var_s',
      title: 'Small',
      availableForSale: true,
      inventoryQuantity: 4,
      price: rupees('3500.00'),
    },
    {
      id: 'var_m',
      title: 'Medium',
      availableForSale: false,
      inventoryQuantity: 0,
      price: rupees('3500.00'),
    },
  ],
};

const DRAFT: DraftOrderDetail = {
  id: 'dft_1',
  name: '#D7',
  status: 'OPEN',
  source: 'WHATSAPP',
  paymentMethod: 'CASH_ON_DELIVERY',
  note: '',
  createdAt: LATER,
  linkExpiresAt: null,
  phone: null,
  lineItems: [
    {
      variantId: 'var_s',
      title: 'Lawn suit',
      variantTitle: 'Small',
      quantity: 2,
      unitPrice: rupees('3200.00'),
      totalPrice: rupees('6400.00'),
    },
  ],
  shippingAddress: null,
  subtotalPrice: rupees('6400.00'),
  totalShippingPrice: rupees('250.00'),
  totalDiscounts: rupees('0.00'),
  totalPrice: rupees('6650.00'),
  codAmount: rupees('6650.00'),
  order: null,
};

describe('Draft orders in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('takes an order from a chat as a draft, at the price agreed', async () => {
    const core = fakeCore('confirmation_agent', (operation) => {
      switch (operation) {
        case 'DraftVariants':
          return { products: { nodes: [LAWN] } };
        case 'DraftOrderCreate':
          return { draftOrderCreate: { draftOrder: { id: 'dft_1' }, userErrors: [] } };
        case 'DraftOrder':
          return { draftOrder: DRAFT };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', core.fetcher);
    const { router } = renderAdmin('/shop_1/drafts/new');

    await screen.findByRole('button', { name: 'Make the draft' });
    await press('Make the draft');
    await screen.findByText('Add at least one item.');
    type('Find products by name or SKU', 'lawn');
    await press('Find');
    await screen.findByText('Lawn suit · Small');
    expect(screen.getByText(/Out of stock/)).toBeTruthy();
    await press('Add Lawn suit · Small');
    await press('Add Lawn suit · Small');
    expect(screen.getByText('2')).toBeTruthy();
    type('Price of Lawn suit · Small', '3,200');
    type('Delivery charge', '250');
    await press('Make the draft');

    await waitFor(() => expect(router.state.location.pathname).toBe('/shop_1/drafts/dft_1'));
    await screen.findByText('#D7');
    expect(core.sent.find((each) => each.operation === 'DraftVariants')?.variables).toEqual({
      query: 'lawn',
    });
    expect(core.sent.find((each) => each.operation === 'DraftOrderCreate')?.variables).toEqual({
      input: {
        lineItems: [{ variantId: 'var_s', quantity: 2, price: '3,200' }],
        source: 'WHATSAPP',
        paymentMethod: 'CASH_ON_DELIVERY',
        shippingPrice: '250',
      },
    });
  });

  it("sends a draft's link to the customer, and says why it cannot be placed yet", async () => {
    const core = fakeCore('owner', (operation) => {
      switch (operation) {
        case 'DraftOrder':
          return { draftOrder: DRAFT };
        case 'DraftOrderLinkCreate':
          return {
            draftOrderLinkCreate: {
              url: 'https://zari.hatti.test/d/hdl_abc',
              whatsappUrl: 'https://wa.me/?text=hdl_abc',
              draftOrder: { id: 'dft_1', linkExpiresAt: LATER },
              userErrors: [],
            },
          };
        case 'DraftOrderComplete':
          return {
            draftOrderComplete: {
              draftOrder: null,
              userErrors: [
                {
                  field: ['shippingAddress'],
                  code: 'REQUIRED',
                  message: 'Placing the draft needs the address',
                },
              ],
            },
          };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/drafts/dft_1');

    await screen.findByText('No address yet: the customer gives it through the link.');
    expect(screen.getByText('Rs 6,650')).toBeTruthy();
    await press('Send the customer a link');
    await screen.findByText('https://zari.hatti.test/d/hdl_abc');
    expect(screen.getByRole('link', { name: 'Send on WhatsApp' }).getAttribute('href')).toBe(
      'https://wa.me/?text=hdl_abc',
    );

    await press('Place the order now');
    await screen.findByText('Placing the draft needs the address');
  });

  it('lists open drafts, and those placed, and deletes one', async () => {
    const core = fakeCore('manager', (operation, variables) => {
      switch (operation) {
        case 'DraftOrders':
          return {
            draftOrders: {
              nodes:
                variables.status === 'OPEN'
                  ? [
                      {
                        id: 'dft_1',
                        name: '#D7',
                        status: 'OPEN',
                        source: 'WHATSAPP',
                        createdAt: LATER,
                        totalPrice: rupees('6650.00'),
                        shippingAddress: { name: 'Ayesha', city: 'Lahore' },
                        lineItems: [{ quantity: 2 }],
                      },
                    ]
                  : [],
            },
          };
        case 'DraftOrder':
          return { draftOrder: DRAFT };
        case 'DraftOrderDelete':
          return { draftOrderDelete: { deletedId: 'dft_1', userErrors: [] } };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', core.fetcher);
    const { router } = renderAdmin('/shop_1/drafts');

    await screen.findByText('Ayesha, Lahore');
    expect(screen.getByText(/2 items/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Placed' }));
    await screen.findByText('No drafts placed yet.');
    fireEvent.click(screen.getByRole('tab', { name: 'Open' }));
    fireEvent.click(await screen.findByText('#D7'));

    await screen.findByText('No address yet: the customer gives it through the link.');
    await press('Delete');
    await press('Delete it');
    await waitFor(() => expect(router.state.location.pathname).toBe('/shop_1/drafts'));
    expect(core.sent.find((each) => each.operation === 'DraftOrderDelete')?.variables).toEqual({
      id: 'dft_1',
    });
  });
});
