import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, LATER, press, renderAdmin, signedIn } from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

/** An order to pack, as its page reads it. */
const ORDER = {
  shop: { timezone: 'Asia/Karachi' },
  order: {
    id: 'ord_7',
    name: '#1007',
    createdAt: LATER,
    stage: 'TO_PACK',
    status: 'OPEN',
    paymentMethod: 'CASH_ON_DELIVERY',
    financialStatus: 'PENDING',
    confirmationStatus: 'CONFIRMED',
    cancelReason: null,
    overPlanLimit: false,
    note: null,
    tags: [],
    phone: '+923001234567',
    email: null,
    source: 'WEB',
    lineItems: [
      {
        id: 'li_1',
        title: 'Lawn suit',
        variantTitle: 'M',
        sku: null,
        quantity: 1,
        unitPrice: rupees('2500'),
        totalPrice: rupees('2500'),
      },
    ],
    subtotalPrice: rupees('2500'),
    totalShippingPrice: rupees('200'),
    totalDiscounts: rupees('0'),
    codFee: rupees('0'),
    totalPrice: rupees('2700'),
    amountPaid: rupees('0'),
    codAmount: rupees('2700'),
    customer: null,
    shippingAddress: {
      name: 'Ayesha',
      phone: '+923001234567',
      city: 'Lahore',
      formatted: ['House 4', 'Lahore'],
    },
    risk: null,
    assignee: null,
    amountRefunded: rupees('0'),
    advanceDue: rupees('0'),
    transferReceipts: [],
    customerLink: null,
    refunds: [],
    fulfillments: [],
    returns: [],
    events: { nodes: [] },
  },
};

/** An order in a list, waiting to be packed. */
const listed = (id: string, name: string) => ({
  id,
  name,
  createdAt: LATER,
  stage: 'TO_PACK',
  paymentMethod: 'CASH_ON_DELIVERY',
  overPlanLimit: false,
  totalPrice: rupees('2700'),
  customer: { displayName: 'Ayesha Khan' },
  shippingAddress: { name: 'Ayesha Khan', city: 'Lahore' },
  risk: { level: 'LOW' },
  lineItems: [{ quantity: 1 }],
});

function core() {
  return fakeCore('packer', (operation) => {
    switch (operation) {
      case 'Order':
        return ORDER;
      case 'Orders':
        return {
          orders: {
            nodes: [listed('ord_1', '#1011'), listed('ord_2', '#1012')],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          orderStageCounts: [],
        };
      case 'OrderDocument':
        return { orderDocument: { title: 'Packing slip #1007', html: '<html>slips</html>' } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

/** A browser tab the page writes its document into and prints. */
function printTab() {
  const written: string[] = [];
  const tab = {
    document: {
      open: vi.fn(),
      write: (html: string) => written.push(html),
      close: vi.fn(),
      fonts: { ready: Promise.resolve() },
    },
    focus: vi.fn(),
    print: vi.fn(),
    close: vi.fn(),
  };
  vi.stubGlobal(
    'open',
    vi.fn(() => tab),
  );
  return { tab, written };
}

const asked = (fake: ReturnType<typeof core>) =>
  fake.sent.filter((each) => each.operation === 'OrderDocument').map((each) => each.variables);

describe('Packing slips and invoices in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("prints an order's invoice from its page, the paper and language kept for next time", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    const { tab, written } = printTab();
    renderAdmin('/shop_1/orders/ord_7');

    fireEvent.click(await screen.findByRole('button', { name: 'Print' }));
    expect(screen.getByRole('heading', { name: 'Print #1007' })).toBeTruthy();
    // A packing slip on A4 in both languages, until the merchant chooses otherwise.
    expect((screen.getByLabelText(/^Packing slip/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Paper') as HTMLSelectElement).value).toBe('A4');
    fireEvent.click(screen.getByLabelText(/^Invoice/));
    fireEvent.change(screen.getByLabelText('Paper'), { target: { value: 'THERMAL_80MM' } });
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'URDU' } });
    await press('Print');

    await waitFor(() => expect(tab.print).toHaveBeenCalled());
    expect(written).toEqual(['<html>slips</html>']);
    expect(asked(fake)).toEqual([
      { ids: ['ord_7'], kind: 'INVOICE', paper: 'THERMAL_80MM', language: 'URDU' },
    ]);
    expect(screen.queryByRole('heading', { name: 'Print #1007' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect((screen.getByLabelText(/^Invoice/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Paper') as HTMLSelectElement).value).toBe('THERMAL_80MM');
    expect((screen.getByLabelText('Language') as HTMLSelectElement).value).toBe('URDU');
  });

  it('prints the packing slips of the orders chosen to pack, at once', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    const { tab } = printTab();
    renderAdmin('/shop_1/orders?stage=TO_PACK');

    await screen.findByText('#1011');
    fireEvent.click(screen.getByLabelText('Select all shown'));
    // Packed or printed, from the same bar.
    expect(screen.getByRole('button', { name: 'Mark 2 packed' })).toBeTruthy();
    await press('Print 2');
    expect(screen.getByRole('heading', { name: 'Print 2 orders' })).toBeTruthy();
    await press('Print');
    await waitFor(() => expect(tab.print).toHaveBeenCalled());
    expect(asked(fake)).toEqual([
      { ids: ['ord_1', 'ord_2'], kind: 'PACKING_SLIP', paper: 'A4', language: 'BILINGUAL' },
    ]);
  });

  it('says so when the browser blocks the page to print, and asks for nothing', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    vi.stubGlobal(
      'open',
      vi.fn(() => null),
    );
    renderAdmin('/shop_1/orders/ord_7');

    fireEvent.click(await screen.findByRole('button', { name: 'Print' }));
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'Print' })[0]!));
    expect(
      await screen.findByText(
        'Your browser blocked the page to print. Allow pop-ups for Hatti and try again.',
      ),
    ).toBeTruthy();
    expect(asked(fake)).toEqual([]);
  });
});
