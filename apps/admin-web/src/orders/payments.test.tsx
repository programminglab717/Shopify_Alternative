import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, press, renderAdmin, signedIn } from '../test-support';
import { transferOwed } from './money';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

function order(extra: Record<string, unknown> = {}) {
  return {
    id: 'ord_7',
    name: '#1007',
    createdAt: LATER,
    stage: 'AWAITING_PAYMENT',
    status: 'OPEN',
    paymentMethod: 'CASH_ON_DELIVERY',
    financialStatus: 'PENDING',
    confirmationStatus: 'CONFIRMED',
    cancelReason: null,
    overPlanLimit: false,
    location: { id: 'loc_1', name: 'Main location' },
    note: null,
    tags: [],
    phone: '+923001234567',
    email: null,
    source: 'WEB',
    lineItems: [],
    subtotalPrice: rupees('5400'),
    totalShippingPrice: rupees('199'),
    totalDiscounts: rupees('0'),
    codFee: rupees('0'),
    totalPrice: rupees('5599'),
    amountPaid: rupees('0'),
    codAmount: rupees('5599'),
    customer: null,
    shippingAddress: { name: 'Ayesha', phone: '+923001234567', city: 'Lahore', formatted: [] },
    risk: null,
    assignee: null,
    amountRefunded: rupees('0'),
    advanceDue: rupees('500'),
    transferReceipts: [
      { id: 'rcp_1', createdAt: LATER, mimeType: 'image/jpeg', url: 'https://files.test/r1.jpg' },
      {
        id: 'rcp_2',
        createdAt: LATER,
        mimeType: 'application/pdf',
        url: 'https://files.test/r2.pdf',
      },
    ],
    customerLink: null as { expiresAt: string | null } | null,
    refunds: [],
    fulfillments: [],
    returns: [],
    events: { nodes: [] },
    ...extra,
  };
}

/** A fake core with one order, paid as the payments recorded say; and its customer's links. */
function core(role: StaffRole, first: ReturnType<typeof order>) {
  let current = first;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Order':
        return { shop: { timezone: 'Asia/Karachi' }, order: current, paymentSessions: [] };
      case 'OrderCreateManualPayment': {
        const paid = Number(current.amountPaid.amount) + Number(variables.amount);
        current = {
          ...current,
          amountPaid: rupees(String(paid)),
          stage: paid >= Number(current.advanceDue.amount) ? 'TO_PACK' : current.stage,
        };
        return {
          orderCreateManualPayment: {
            order: { id: current.id, stage: current.stage, amountPaid: current.amountPaid },
            userErrors: [],
          },
        };
      }
      case 'OrderWaiveAdvance': {
        const owed = Number(current.advanceDue.amount) - Number(current.amountPaid.amount);
        current = {
          ...current,
          advanceDue: current.amountPaid,
          codAmount: rupees(String(Number(current.codAmount.amount) + owed)),
          stage: 'NEEDS_CONFIRMATION',
        };
        return {
          orderWaiveAdvance: {
            order: {
              id: current.id,
              stage: current.stage,
              advanceDue: current.advanceDue,
              codAmount: current.codAmount,
            },
            userErrors: [],
          },
        };
      }
      case 'TransferReceiptRead': {
        const reading = {
          outcome: 'READ',
          readAt: LATER,
          amount: rupees('500'),
          paidOn: '2026-10-20',
          reference: 'TID 0012 3456',
          senderName: 'Ayesha Khan',
          senderBank: 'Meezan Bank',
          recipientName: null,
          recipientAccount: 'PK36****9911',
          owed: rupees('500'),
          amountCheck: 'MATCHES',
          accountCheck: 'DIFFERS',
          sameReferenceOrders: ['#1003'],
          beforeOrder: false,
        };
        current = {
          ...current,
          transferReceipts: current.transferReceipts.map((receipt) =>
            receipt.id === variables.id ? { ...receipt, reading } : receipt,
          ),
        };
        return { transferReceiptRead: { reading, userErrors: [] } };
      }
      case 'OrderLinkCreate':
        current = { ...current, customerLink: { expiresAt: null } };
        return {
          orderLinkCreate: {
            url: 'https://zari.hatti.pk/o/k3Jd9',
            whatsappUrl: 'https://wa.me/923001234567?text=Your%20order',
            order: { id: current.id, customerLink: current.customerLink },
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

describe("An order's payment received by hand, and its customer's link", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows what an order waits for and its receipts, and records its advance, moving it on', async () => {
    const fake = core('owner', order());
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const money = await screen.findByRole('region', { name: 'Payments and refunds' });
    expect(within(money).getByText('Waiting for its advance of Rs 500, by transfer.')).toBeTruthy();
    expect(within(money).getByAltText('Receipt 1').getAttribute('src')).toBe(
      'https://files.test/r1.jpg',
    );
    expect(within(money).getByRole('link', { name: 'Receipt 2 (PDF)' }).getAttribute('href')).toBe(
      'https://files.test/r2.pdf',
    );
    // Paid in full, the courier would collect nothing: not while it waits for its advance.
    expect(within(money).queryByRole('button', { name: 'Mark as paid' })).toBeNull();

    fireEvent.click(within(money).getByRole('button', { name: 'Record a payment' }));
    const amount = within(money).getByLabelText('Amount, at most Rs 5,599') as HTMLInputElement;
    expect(amount.value).toBe('500');
    expect(
      within(money).getByText(
        'Once its advance is in, the order moves on to be packed, and the courier collects the rest.',
      ),
    ).toBeTruthy();
    await press('Record the payment');
    await within(money).findByText('Rs 500 recorded as received.');
    expect(sentOf(fake, 'OrderCreateManualPayment')).toEqual([{ id: 'ord_7', amount: '500' }]);
    expect(within(money).queryByText(/Waiting for its advance/)).toBeNull();
  });

  it("reads a receipt with the AI, saying what doesn't fit, for those who handle money (PAY-08)", async () => {
    const readable = (id: string, mimeType: string, url: string) => ({
      id,
      createdAt: LATER,
      mimeType,
      url,
      readable: true,
      reading: null as Record<string, unknown> | null,
    });
    const receipts = [
      readable('rcp_1', 'image/jpeg', 'https://files.test/r1.jpg'),
      {
        ...readable('rcp_2', 'image/png', 'https://files.test/r2.png'),
        reading: { outcome: 'NOT_A_RECEIPT', readAt: LATER },
      },
    ];
    const fake = core('manager', order({ transferReceipts: receipts }));
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const money = await screen.findByRole('region', { name: 'Payments and refunds' });
    expect(within(money).getByText("The AI says this isn't a receipt for a payment")).toBeTruthy();
    expect(within(money).getByText('Uses one AI credit')).toBeTruthy();
    await press('Read with AI');
    await within(money).findByText('What the AI read');
    expect(sentOf(fake, 'TransferReceiptRead')).toEqual([{ id: 'rcp_1' }]);
    expect(within(money).getByText(/what the order waited for/)).toBeTruthy();
    expect(within(money).getByText('TID 0012 3456')).toBeTruthy();
    expect(within(money).getByText(/also sent for #1003/)).toBeTruthy();
    expect(within(money).getByText(/not the account the customer was told/)).toBeTruthy();
    expect(
      within(money).getByText('Check it in your bank before you mark the order paid.'),
    ).toBeTruthy();
    expect(within(money).queryByRole('button', { name: 'Read with AI' })).toBeNull();
    cleanup();

    // Those who don't handle its money never see the button.
    vi.stubGlobal('fetch', core('packer', order({ transferReceipts: receipts })).fetcher);
    renderAdmin('/shop_1/orders/ord_7');
    await screen.findByRole('heading', { name: '#1007' });
    expect(screen.queryByRole('button', { name: 'Read with AI' })).toBeNull();
  });

  it('lets an order go without its advance, after saying what the courier collects (ADR-653)', async () => {
    const fake = core('owner', order({ amountPaid: rupees('200'), codAmount: rupees('5099') }));
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const money = await screen.findByRole('region', { name: 'Payments and refunds' });
    fireEvent.click(within(money).getByRole('button', { name: 'Go without the advance' }));
    expect(within(money).getByText(/collects the Rs 300 still owed with the rest/)).toBeTruthy();
    await press('Go without it');
    await within(money).findByText('Advance waived: the courier collects it at the door.');
    expect(sentOf(fake, 'OrderWaiveAdvance')).toEqual([{ id: 'ord_7' }]);
    expect(within(money).queryByText(/Waiting for its advance/)).toBeNull();
    expect(within(money).queryByRole('button', { name: 'Go without the advance' })).toBeNull();
  });

  it('records part of a transfer, never more than it owes, and still offers to mark it paid', async () => {
    const fake = core(
      'manager',
      order({ paymentMethod: 'BANK_TRANSFER', advanceDue: rupees('0'), transferReceipts: [] }),
    );
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const money = await screen.findByRole('region', { name: 'Payments and refunds' });
    expect(within(money).getByText('Waiting for Rs 5,599 by transfer.')).toBeTruthy();
    expect(within(money).getByRole('button', { name: 'Mark as paid' })).toBeTruthy();

    fireEvent.click(within(money).getByRole('button', { name: 'Record a payment' }));
    const amount = within(money).getByLabelText('Amount, at most Rs 5,599') as HTMLInputElement;
    expect(amount.value).toBe('5599');
    fireEvent.change(amount, { target: { value: '6000' } });
    expect(within(money).getByText('More than the Rs 5,599 it owes.')).toBeTruthy();
    expect(within(money).getByRole('button', { name: 'Record the payment' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.change(amount, { target: { value: '2,000' } });
    await press('Record the payment');
    await within(money).findByText('Rs 2,000 recorded as received.');
    expect(sentOf(fake, 'OrderCreateManualPayment')).toEqual([{ id: 'ord_7', amount: '2000' }]);
  });

  it('makes the customer a new link, the one before stopping, shown once to copy or send', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const fake = core('confirmation_agent', order({ customerLink: { expiresAt: null } }));
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    await screen.findByText('It works until 30 days after the order ends.');
    await press('New link');
    expect(screen.getByText('The link sent before stops working.')).toBeTruthy();
    expect(sentOf(fake, 'OrderLinkCreate')).toHaveLength(0);
    await press('Make a new link');
    const link = (await screen.findByLabelText('The link')) as HTMLInputElement;
    expect(link.value).toBe('https://zari.hatti.pk/o/k3Jd9');
    expect(screen.getByRole('link', { name: 'Send on WhatsApp' }).getAttribute('href')).toBe(
      'https://wa.me/923001234567?text=Your%20order',
    );
    await press('Copy link');
    expect(writeText).toHaveBeenCalledWith('https://zari.hatti.pk/o/k3Jd9');
    expect(sentOf(fake, 'OrderLinkCreate')).toEqual([{ id: 'ord_7' }]);
  });

  it('keeps links to those who speak with customers, and works out what a transfer waits for', async () => {
    vi.stubGlobal('fetch', core('packer', order()).fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    await screen.findByRole('heading', { name: '#1007' });
    expect(screen.queryByRole('button', { name: 'New link' })).toBeNull();

    const base = { totalPrice: rupees('5599'), advanceDue: rupees('500') };
    expect(
      transferOwed({ ...base, paymentMethod: 'CASH_ON_DELIVERY', amountPaid: rupees('200') }),
    ).toBe('300.00');
    expect(
      transferOwed({ ...base, paymentMethod: 'BANK_TRANSFER', amountPaid: rupees('599') }),
    ).toBe('5000.00');
    expect(transferOwed({ ...base, paymentMethod: 'PREPAID', amountPaid: rupees('0') })).toBe('0');
  });
});
