import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDetail } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn } from '../test-support';
import { changeable } from './edit-order';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const line = (
  id: string,
  title: string,
  variantTitle: string,
  quantity: number,
  price: string,
) => ({
  id,
  productId: `prod_${id}`,
  variantId: `var_${id}`,
  title,
  variantTitle,
  sku: null,
  quantity,
  unitPrice: rupees(price),
  totalPrice: rupees(String(Number(price) * quantity)),
});

function order(extra: Record<string, unknown> = {}) {
  return {
    shop: { timezone: 'Asia/Karachi' },
    order: {
      id: 'ord_7',
      name: '#1007',
      createdAt: LATER,
      stage: 'NEEDS_CONFIRMATION',
      status: 'OPEN',
      paymentMethod: 'CASH_ON_DELIVERY',
      financialStatus: 'PENDING',
      confirmationStatus: 'PENDING',
      cancelReason: null,
      overPlanLimit: false,
      note: '',
      tags: [],
      phone: '+923001234567',
      email: null,
      source: 'WEB',
      lineItems: [
        line('li_1', 'Lawn suit', 'M', 1, '2500'),
        line('li_2', 'Dupatta', 'Default Title', 1, '1200'),
      ],
      subtotalPrice: rupees('3700'),
      totalShippingPrice: rupees('250'),
      totalDiscounts: rupees('0'),
      transferDiscount: rupees('0'),
      codFee: rupees('0'),
      totalPrice: rupees('3950'),
      amountPaid: rupees('0'),
      codAmount: rupees('3950'),
      customer: null,
      shippingAddress: { name: 'Ayesha', phone: '+923001234567', city: 'Lahore', formatted: [] },
      risk: null,
      assignee: null,
      amountRefunded: rupees('0'),
      refunds: [],
      fulfillments: [],
      returns: [],
      events: { nodes: [] },
      ...extra,
    },
  };
}

const edited = (field: string, total: string, cash: string, stage = 'NEEDS_CONFIRMATION') => ({
  [field]: {
    order: { id: 'ord_7', stage, totalPrice: rupees(total), codAmount: rupees(cash) },
    userErrors: [],
  },
});

function core(role: StaffRole, answer = order(), stage = 'NEEDS_CONFIRMATION') {
  return fakeCore(role, (operation) => {
    switch (operation) {
      case 'Order':
        return answer;
      case 'DraftVariants':
        return {
          products: {
            nodes: [
              {
                id: 'prod_9',
                title: 'Khussa',
                variants: [
                  {
                    id: 'var_k8',
                    title: '8',
                    availableForSale: true,
                    inventoryQuantity: 5,
                    price: rupees('1800'),
                  },
                  {
                    id: 'var_k9',
                    title: '9',
                    availableForSale: true,
                    inventoryQuantity: 2,
                    price: rupees('1800'),
                  },
                ],
              },
            ],
          },
        };
      case 'OrderEditLineItems':
        return edited('orderEditLineItems', '8550', '8550');
      case 'OrderEditCharges':
        return edited('orderEditCharges', '3200', '3200', stage);
      case 'OrderMarkUnpacked':
        return { orderMarkUnpacked: { order: { id: 'ord_7', stage: 'TO_PACK' }, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).at(-1)?.variables;

describe("Changing an order's items and charges, on its page", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('changes quantities, takes a line off and adds a variant at a price agreed on the call', async () => {
    const fake = core('confirmation_agent');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const items = await screen.findByRole('region', { name: 'Items' });
    fireEvent.click(within(items).getByRole('button', { name: 'Change the items' }));
    fireEvent.click(within(items).getByRole('button', { name: 'One more Lawn suit · M' }));
    fireEvent.click(within(items).getByRole('button', { name: 'Take Dupatta off' }));
    expect(within(items).getByText('Comes off')).toBeTruthy();

    fireEvent.change(within(items).getByLabelText('Find products by name or SKU'), {
      target: { value: 'khussa' },
    });
    fireEvent.click(within(items).getByRole('button', { name: 'Find' }));
    fireEvent.click(await within(items).findByRole('button', { name: 'Add Khussa · 9' }));
    fireEvent.change(within(items).getByLabelText('Price of Khussa · 9'), {
      target: { value: '1,600' },
    });
    // 2 × 2,500 kept at their price, and the khussa at the price agreed.
    expect(within(items).getByText('Items: Rs 6,600 instead of Rs 3,700')).toBeTruthy();
    fireEvent.click(within(items).getByRole('button', { name: 'Save the items' }));

    await within(items).findByText(
      'Saved. Its total is now Rs 8,550, with Rs 8,550 to collect at the door.',
    );
    expect(sentOf(fake, 'OrderEditLineItems')).toEqual({
      id: 'ord_7',
      input: {
        setQuantities: [
          { lineItemId: 'li_1', quantity: 2 },
          { lineItemId: 'li_2', quantity: 0 },
        ],
        addVariants: [{ variantId: 'var_k9', quantity: 1, price: '1600' }],
      },
    });
  });

  it('refuses taking every item off, and adds to the line a variant already has', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const items = await screen.findByRole('region', { name: 'Items' });
    fireEvent.click(within(items).getByRole('button', { name: 'Change the items' }));
    fireEvent.click(within(items).getByRole('button', { name: 'Take Lawn suit · M off' }));
    fireEvent.click(within(items).getByRole('button', { name: 'Take Dupatta off' }));
    fireEvent.click(within(items).getByRole('button', { name: 'Save the items' }));
    expect(within(items).getByText(/To take everything off, cancel it/)).toBeTruthy();
    expect(sentOf(fake, 'OrderEditLineItems')).toBeUndefined();

    fireEvent.click(within(items).getByRole('button', { name: 'Put Lawn suit · M back' }));
    fireEvent.click(within(items).getByRole('button', { name: 'Put Dupatta back' }));
    expect(
      (within(items).getByRole('button', { name: 'Save the items' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(items).getByRole('button', { name: 'Cancel' }));
    expect(within(items).getByRole('button', { name: 'Change the items' })).toBeTruthy();
  });

  it('waives the delivery charge and gives a discount, never below the one for paying by transfer', async () => {
    const fake = core(
      'owner',
      order({ totalDiscounts: rupees('185'), transferDiscount: rupees('185') }),
      'NEEDS_REVIEW',
    );
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const items = await screen.findByRole('region', { name: 'Items' });
    fireEvent.click(within(items).getByRole('button', { name: 'Change delivery or discount' }));
    fireEvent.click(within(items).getByRole('button', { name: 'Waive it' }));
    expect((within(items).getByLabelText('Delivery charge') as HTMLInputElement).value).toBe('0');
    const discount = within(items).getByLabelText('Discount on the items') as HTMLInputElement;
    expect(discount.value).toBe('185');
    fireEvent.change(discount, { target: { value: '100' } });
    expect(
      (within(items).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(discount, { target: { value: '500' } });
    fireEvent.click(within(items).getByRole('button', { name: 'Save' }));

    await within(items).findByText(
      'Saved. Its total is now Rs 3,200, with Rs 3,200 to collect at the door. The change makes it risky, so it waits for review.',
    );
    expect(sentOf(fake, 'OrderEditCharges')).toEqual({
      id: 'ord_7',
      input: { shippingPrice: '0', discount: '500' },
    });
  });

  it('asks for a packed order to be unpacked first, and shows no changes to those who only see it', async () => {
    const fake = core('packer', order({ stage: 'TO_BOOK', confirmationStatus: 'CONFIRMED' }));
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const items = await screen.findByRole('region', { name: 'Items' });
    expect(within(items).queryByRole('button', { name: 'Change the items' })).toBeNull();
    expect(within(items).getByText(/unpack it to change/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unpack' }));
    await waitFor(() => expect(sentOf(fake, 'OrderMarkUnpacked')).toEqual({ id: 'ord_7' }));
    cleanup();

    vi.stubGlobal('fetch', core('accountant').fetcher);
    renderAdmin('/shop_1/orders/ord_7');
    await screen.findByRole('region', { name: 'Items' });
    expect(screen.queryByRole('button', { name: 'Change the items' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm order' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();

    const waiting = order().order as unknown as OrderDetail;
    expect(changeable(waiting)).toBe(true);
    expect(changeable({ ...waiting, stage: 'TO_BOOK' })).toBe(false);
    expect(changeable({ ...waiting, overPlanLimit: true })).toBe(false);
    expect(changeable({ ...waiting, refunds: [{} as OrderDetail['refunds'][number]] })).toBe(false);
  });
});
