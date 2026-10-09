import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });

const OPEN = {
  id: 'pl_1',
  title: 'Eid lawn',
  url: 'https://zari.hatti.pk/pay/eid-lawn-7f3k',
  active: true,
  open: true,
  ordersPlaced: 3,
  usageLimit: 10,
  prepaidOnly: true,
  discountCode: 'EID10',
  expiresAt: LATER,
  lastOrderAt: LATER,
  createdAt: LATER,
  items: [
    { variantId: 'var_2', title: 'Lawn suit · Large', quantity: 2 },
    { variantId: 'var_9', title: null, quantity: 1 },
  ],
};

const CLOSED = {
  ...OPEN,
  id: 'pl_2',
  title: 'Summer sale',
  url: 'https://zari.hatti.pk/pay/summer-9q2m',
  active: false,
  open: false,
  ordersPlaced: 12,
  usageLimit: null,
  prepaidOnly: false,
  discountCode: null,
  expiresAt: null,
  items: [{ variantId: 'var_3', title: 'Chikankari kurta', quantity: 1 }],
};

function core(role: StaffRole) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'PaymentLinks':
        return { paymentLinks: [OPEN, CLOSED] };
      case 'DraftVariants':
        return {
          products: {
            nodes: [
              {
                id: 'prod_1',
                title: 'Lawn suit',
                variants: [
                  {
                    id: 'var_1',
                    title: 'Small',
                    availableForSale: true,
                    inventoryQuantity: 8,
                    price: pkr('4500.00'),
                  },
                  {
                    id: 'var_2',
                    title: 'Large',
                    availableForSale: true,
                    inventoryQuantity: 3,
                    price: pkr('4800.00'),
                  },
                ],
              },
            ],
          },
        };
      case 'PaymentLinkCreate': {
        const input = variables.input as { title: string; discountCode?: string };
        if (input.discountCode === 'NOPE') {
          return {
            paymentLinkCreate: {
              paymentLink: null,
              userErrors: [
                {
                  field: ['input', 'discountCode'],
                  code: 'NOT_FOUND',
                  message: 'No discount code NOPE',
                },
              ],
            },
          };
        }
        return {
          paymentLinkCreate: {
            paymentLink: {
              ...OPEN,
              id: 'pl_3',
              title: input.title,
              url: 'https://zari.hatti.pk/pay/new-1a2b',
            },
            userErrors: [],
          },
        };
      }
      case 'PaymentLinkUpdate':
        return {
          paymentLinkUpdate: {
            paymentLink: { id: variables.id, active: false, open: false },
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

describe('Payment links', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists what each link sells and has taken, and closes one', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1');

    fireEvent.click((await screen.findAllByRole('link', { name: 'Payment links' }))[0]!);
    const [open, closed] = within(await screen.findByRole('list')).getAllByRole('listitem');
    expect(open!.textContent).toContain('Open');
    expect(open!.textContent).toContain('2 × Lawn suit · Large · 1 × an item since deleted');
    expect(open!.textContent).toContain('3 of 10 orders · code EID10 · paid before it ships');
    expect(open!.textContent).toContain('· closes ');
    expect(within(open!).getByRole('link', { name: 'Send on WhatsApp' }).getAttribute('href')).toBe(
      `https://wa.me/?text=${encodeURIComponent(`Eid lawn\n${OPEN.url}`)}`,
    );
    expect(closed!.textContent).toContain('Closed');
    expect(closed!.textContent).toContain('12 orders');
    expect(within(closed!).queryByRole('link', { name: 'Send on WhatsApp' })).toBeNull();
    expect(within(closed!).getByRole('button', { name: 'Open it again' })).toBeTruthy();

    fireEvent.click(within(open!).getByRole('button', { name: 'Close it' }));
    await waitFor(() =>
      expect(sentOf(fake, 'PaymentLinkUpdate')).toEqual([{ id: 'pl_1', input: { active: false } }]),
    );
  });

  it('makes a link of items found by name, closing at the day’s end in Pakistan, and says what the core turned down', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/payment-links');

    fireEvent.click(await screen.findByRole('button', { name: 'New payment link' }));
    type('Title', 'Eid lawn, last pieces');
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    expect(await screen.findByText('Add at least one item.')).toBeTruthy();

    type('Find products by name or SKU', 'lawn');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Lawn suit · Large' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Lawn suit · Large' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Lawn suit · Small' }));
    expect((screen.getByLabelText('How many of Lawn suit · Large') as HTMLInputElement).value).toBe(
      '2',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Take Lawn suit · Small off' }));
    type('Discount code', 'nope');
    type('Orders it takes', '50');
    fireEvent.change(screen.getByLabelText('Closes on'), { target: { value: '2026-12-31' } });
    fireEvent.click(screen.getByLabelText(/Paid before it ships/));

    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    expect(await screen.findByText('Discount code: No discount code NOPE')).toBeTruthy();
    type('Discount code', 'eid10');
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    expect(await screen.findByText('Eid lawn, last pieces is ready to share.')).toBeTruthy();
    expect(screen.getByText('https://zari.hatti.pk/pay/new-1a2b')).toBeTruthy();
    expect(sentOf(fake, 'PaymentLinkCreate').at(-1)).toEqual({
      input: {
        title: 'Eid lawn, last pieces',
        items: [{ variantId: 'var_2', quantity: 2 }],
        discountCode: 'EID10',
        prepaidOnly: true,
        expiresAt: '2026-12-31T18:59:59.000Z',
        usageLimit: 50,
      },
    });
  });

  it('leaves payment links to owners and managers', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/payment-links');
    expect(await screen.findByText('Owners and managers make payment links.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Payment links' })).toBeNull();
  });
});
