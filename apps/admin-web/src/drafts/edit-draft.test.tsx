import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftOrderDetail, UserError } from '../api/types';
import { fakeCore, LATER, press, renderAdmin, signedIn, type } from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const line = (variantId: string, variantTitle: string, quantity: number, price: string) => ({
  variantId,
  title: 'Lawn suit',
  variantTitle,
  quantity,
  unitPrice: rupees(price),
  totalPrice: rupees(String(Number(price) * quantity)),
});

const ADDRESS = {
  formatted: ['Ayesha', 'House 4, Street 9', 'Lahore'],
  name: 'Ayesha',
  phone: '+923001234567',
  city: 'Lahore',
  address1: 'House 4, Street 9',
  address2: 'Johar Town',
  landmark: 'near Jamia Masjid',
  province: 'Punjab',
  zip: null,
  latitude: 31.47,
  longitude: 74.27,
};

const DRAFT: DraftOrderDetail = {
  id: 'dft_1',
  name: '#D7',
  status: 'OPEN',
  source: 'WHATSAPP',
  paymentMethod: 'CASH_ON_DELIVERY',
  paymentTermsDays: null,
  note: '',
  createdAt: LATER,
  linkExpiresAt: null,
  phone: '+923001234567',
  lineItems: [line('var_s', 'Small', 1, '3200.00'), line('var_m', 'Medium', 1, '3500.00')],
  shippingAddress: ADDRESS,
  subtotalPrice: rupees('6700.00'),
  totalShippingPrice: rupees('250.00'),
  totalDiscounts: rupees('0.00'),
  discountCode: null,
  totalPrice: rupees('6950.00'),
  codAmount: rupees('6950.00'),
  deliveryMethod: 'SHIPPING',
  location: null,
  order: null,
};

function core(draft: DraftOrderDetail, refusal: UserError[] = []) {
  return fakeCore('confirmation_agent', (operation) => {
    switch (operation) {
      case 'DraftOrder':
        return { draftOrder: draft };
      case 'DraftOrderUpdate':
        return {
          draftOrderUpdate: {
            draftOrder: refusal.length ? null : { id: 'dft_1' },
            userErrors: refusal,
          },
        };
      case 'Locations':
        return { locations: { nodes: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sent = (fake: ReturnType<typeof core>) =>
  fake.sent.filter((each) => each.operation === 'DraftOrderUpdate').map((each) => each.variables);

describe('A draft changed while it is open', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('changes its items and charges, every line sent at its price, the address left alone', async () => {
    const fake = core(DRAFT);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/drafts/dft_1');

    fireEvent.click(await screen.findByRole('link', { name: 'Change the draft' }));
    expect(await screen.findByRole('heading', { name: 'Change #D7' })).toBeTruthy();
    // Each line at the price agreed, and the charges as the draft has them.
    expect((screen.getByLabelText('Price of Lawn suit · Small') as HTMLInputElement).value).toBe(
      '3200',
    );
    expect((screen.getByLabelText('Delivery charge') as HTMLInputElement).value).toBe('250');
    await press('One more Lawn suit · Small');
    await press('Remove Lawn suit · Medium');
    type('Delivery charge', '');
    type('Discount', '300');
    type('Note (optional)', ' Small instead of Medium ');
    await press('Save the draft');

    expect(await screen.findByRole('heading', { name: '#D7' })).toBeTruthy();
    expect(sent(fake)).toEqual([
      {
        id: 'dft_1',
        input: {
          lineItems: [{ variantId: 'var_s', quantity: 2, price: '3200' }],
          source: 'WHATSAPP',
          paymentMethod: 'CASH_ON_DELIVERY',
          shippingPrice: '0',
          discount: '300',
          note: 'Small instead of Medium',
        },
      },
    ]);
  });

  it("keeps a wholesale draft's payment terms, or changes them (ADR-888)", async () => {
    const fake = core({ ...DRAFT, paymentMethod: 'BANK_TRANSFER', paymentTermsDays: 45 });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/drafts/dft_1/edit');

    await screen.findByRole('heading', { name: 'Change #D7' });
    const terms = screen.getByLabelText('Payment terms') as HTMLSelectElement;
    expect(terms.value).toBe('45');
    expect([...terms.options].map((each) => each.text)).toEqual([
      'As their price list gives',
      'None: paid before it ships',
      'Pay within 7 days',
      'Pay within 15 days',
      'Pay within 30 days',
      'Pay within 45 days',
      'Pay within 60 days',
      'Pay within 90 days',
    ]);
    fireEvent.change(terms, { target: { value: '30' } });
    await press('Save the draft');
    await screen.findByRole('heading', { name: '#D7' });
    expect(sent(fake).at(-1)!.input).toMatchObject({
      paymentMethod: 'BANK_TRANSFER',
      paymentTermsDays: 30,
    });
    cleanup();

    // Paid on delivery, it has no terms to choose.
    vi.stubGlobal('fetch', core(DRAFT).fetcher);
    renderAdmin('/shop_1/drafts/dft_1/edit');
    await screen.findByRole('heading', { name: 'Change #D7' });
    expect(screen.queryByLabelText('Payment terms')).toBeNull();
  });

  it('changes the address keeping its area, landmark and pin, or takes it away', async () => {
    const fake = core(DRAFT);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/drafts/dft_1/edit');

    await screen.findByRole('heading', { name: 'Change #D7' });
    expect((screen.getByLabelText('City') as HTMLInputElement).value).toBe('Lahore');
    type('City', 'Lahore Cantt');
    await press('Save the draft');
    await screen.findByRole('heading', { name: '#D7' });
    expect(sent(fake).at(-1)!.input).toMatchObject({
      shippingAddress: {
        name: 'Ayesha',
        phone: '0300 1234567',
        city: 'Lahore Cantt',
        address1: 'House 4, Street 9',
        address2: 'Johar Town',
        landmark: 'near Jamia Masjid',
        province: 'Punjab',
        latitude: 31.47,
        longitude: 74.27,
      },
    });

    fireEvent.click(screen.getByRole('link', { name: 'Change the draft' }));
    await screen.findByRole('heading', { name: 'Change #D7' });
    fireEvent.click(screen.getByLabelText('I have their address'));
    await press('Save the draft');
    await screen.findByRole('heading', { name: '#D7' });
    expect(sent(fake).at(-1)!.input).toMatchObject({ shippingAddress: null });
  });

  it("says the core's refusal by the form's field, and stays", async () => {
    vi.stubGlobal(
      'fetch',
      core(DRAFT, [
        {
          field: ['input', 'discount'],
          code: 'INVALID',
          message: "The discount can't be more than the items cost",
        },
      ]).fetcher,
    );
    renderAdmin('/shop_1/drafts/dft_1/edit');

    await screen.findByRole('heading', { name: 'Change #D7' });
    type('Discount', '9000');
    await press('Save the draft');
    expect(
      await screen.findByText("Discount: The discount can't be more than the items cost"),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Change #D7' })).toBeTruthy();
  });

  it('leaves a draft that became an order as it is', async () => {
    const placed = {
      ...DRAFT,
      status: 'COMPLETED' as const,
      order: { id: 'ord_9', name: '#1009' },
    };
    vi.stubGlobal('fetch', core(placed).fetcher);
    renderAdmin('/shop_1/drafts/dft_1');

    await screen.findByRole('heading', { name: '#D7' });
    expect(screen.queryByRole('link', { name: 'Change the draft' })).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', core(placed).fetcher);
    renderAdmin('/shop_1/drafts/dft_1/edit');
    expect(
      await screen.findByText('This draft is an order now: change the order instead.'),
    ).toBeTruthy();
  });
  it("shows a code's discount by it, and takes the code off for an amount typed (ADR-522)", async () => {
    const fake = core({ ...DRAFT, discountCode: 'EID10', totalDiscounts: rupees('670.00') });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/drafts/dft_1');

    expect(await screen.findByText('Discount (EID10)')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Change the draft' }));
    await screen.findByRole('heading', { name: 'Change #D7' });
    // The code sets the discount, so there is no amount to type beside it.
    expect((screen.getByLabelText('Discount code') as HTMLInputElement).value).toBe('EID10');
    expect(screen.queryByLabelText('Discount')).toBeNull();
    await press('Save the draft');
    await screen.findByRole('heading', { name: '#D7' });
    expect(sent(fake).at(-1)!.input).toMatchObject({ discountCode: 'EID10' });
    expect(sent(fake).at(-1)!.input).not.toHaveProperty('discount');

    fireEvent.click(screen.getByRole('link', { name: 'Change the draft' }));
    await screen.findByRole('heading', { name: 'Change #D7' });
    type('Discount code', '');
    type('Discount', '300');
    await press('Save the draft');
    await screen.findByRole('heading', { name: '#D7' });
    expect(sent(fake).at(-1)!.input).toMatchObject({ discount: '300', discountCode: null });
  });
});
