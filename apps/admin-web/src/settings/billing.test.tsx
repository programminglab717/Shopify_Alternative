import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingInvoiceValue, BillingPlanValue, BillingWalletEntryValue } from '../api/types';
import {
  confirmIdentity,
  fakeCore,
  LATER,
  press,
  REAUTHENTICATE,
  renderAdmin,
  signedIn,
  type,
} from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const plan = (
  code: BillingPlanValue['code'],
  name: string,
  monthly: string,
  orderLimit: number | null,
): BillingPlanValue => ({
  code,
  name,
  monthlyPrice: rupees(monthly),
  yearlyPrice: rupees(String(Number(monthly) * 10)),
  orderLimit,
  staffLimit: code === 'FREE' ? 1 : 5,
  locationLimit: 1,
  customDomains: code !== 'FREE',
  onlineGateways: code !== 'FREE',
});

const FREE = plan('FREE', 'Free', '0', 50);
const GROWTH = plan('GROWTH', 'Growth', '5000', null);

const invoice = (overrides: Partial<BillingInvoiceValue> = {}): BillingInvoiceValue => ({
  id: 'inv_1',
  name: 'HB-000123',
  reason: 'CHANGE',
  status: 'OPEN',
  interval: 'YEARLY',
  createdAt: LATER,
  paidAt: null,
  amount: rupees('50000.00'),
  plan: { name: 'Growth' },
  transfers: [],
  ...overrides,
});

const BANK = {
  bankName: 'Meezan Bank',
  title: 'Hatti Technologies',
  iban: 'PK36SCBL0000001123456702',
  raastId: null,
};

const entry = (
  id: string,
  kind: BillingWalletEntryValue['kind'],
  amount: string,
  balance: string,
  extra: Partial<BillingWalletEntryValue> = {},
): BillingWalletEntryValue => ({
  id,
  kind,
  amount: rupees(amount),
  balance: rupees(balance),
  channel: null,
  category: null,
  parts: null,
  note: null,
  createdAt: LATER,
  ...extra,
});

/** The core's billing for a shop on Free, as each mutation leaves it; and its credit's changes. */
function billingCore(
  role: 'owner' | 'manager',
  state: { open: BillingInvoiceValue | null; entries?: BillingWalletEntryValue[] },
  confirmed = { value: true },
) {
  return fakeCore(
    role,
    (operation, variables) => {
      switch (operation) {
        case 'Billing':
          return {
            billingSubscription: {
              plan: FREE,
              interval: null,
              periodEnd: null,
              pastDue: false,
              nextPlan: null,
              openInvoice: state.open,
            },
            billingPlans: [FREE, GROWTH],
            billingWallet: { balance: rupees('120.50'), openInvoice: null },
            billingInvoices: state.open ? [state.open] : [],
            billingBankAccount: BANK,
          };
        case 'BillingPlanChange':
          if (!confirmed.value) return REAUTHENTICATE;
          state.open = invoice();
          return { billingPlanChange: { invoice: { id: 'inv_1' }, userErrors: [] } };
        case 'BillingInvoicePay':
          return {
            billingInvoicePay: { checkoutUrl: 'https://pay.test/checkout/1', userErrors: [] },
          };
        case 'BillingInvoiceTransferReport':
          state.open = invoice({
            transfers: [
              {
                id: 'btr_1',
                reference: 'FT2410081234',
                status: 'WAITING',
                refusal: null,
                reportedAt: LATER,
              },
            ],
          });
          return {
            billingInvoiceTransferReport: {
              transfer: { id: 'btr_1', status: 'WAITING' },
              userErrors: [],
            },
          };
        case 'BillingCreditsBuy':
          return { billingCreditsBuy: { invoice: { id: 'inv_2' }, userErrors: [] } };
        case 'BillingWalletEntries':
          return {
            billingWalletEntries: (state.entries ?? []).slice(0, variables.first as number),
          };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    },
    (path) => {
      if (path === '/auth/reauthenticate/options') return { methods: ['password'], phone: null };
      if (path === '/auth/reauthenticate') {
        confirmed.value = true;
        return { authenticatedAt: LATER, sensitiveActionsUntil: LATER };
      }
      throw new Error(`unexpected ${path}`);
    },
  );
}

describe('Plan and billing in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('chooses a yearly plan once the owner confirms who they are, and pays it by card', async () => {
    signedIn();
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    const state = { open: null as BillingInvoiceValue | null };
    const core = billingCore('owner', state, { value: false });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/billing');

    await screen.findByText('Your plan: Free');
    expect(screen.getByText('50 orders a month')).toBeTruthy();
    expect(screen.getByText('Rs 120.50')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Pay'), { target: { value: 'YEARLY' } });
    expect(screen.getByText('Rs 50,000 a year')).toBeTruthy();
    await press('Choose Growth');
    await confirmIdentity('Password', 'owner-password');
    await press('Confirm');

    await screen.findByText('HB-000123: Rs 50,000 to pay');
    const changes = core.sent.filter((each) => each.operation === 'BillingPlanChange');
    expect(changes.at(-1)?.variables).toEqual({ input: { plan: 'GROWTH', interval: 'YEARLY' } });

    await press('Pay by card or wallet');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://pay.test/checkout/1'));
  });

  it("says a transfer was sent for an invoice, with Hatti's account to send it to", async () => {
    signedIn();
    const state = { open: invoice() as BillingInvoiceValue | null };
    const core = billingCore('owner', state);
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/billing');

    await screen.findByText('PK36 SCBL 0000 0011 2345 6702');
    expect(
      screen.getByText("Write HB-000123 as the transfer's purpose. Then give its reference here."),
    ).toBeTruthy();
    type("Transfer's reference", ' FT2410081234 ');
    await press('I have sent it');

    await screen.findByText(
      'Hatti is finding your transfer FT2410081234 in its account. The invoice is paid once it does.',
    );
    expect(
      core.sent.find((each) => each.operation === 'BillingInvoiceTransferReport')?.variables,
    ).toEqual({ id: 'inv_1', reference: 'FT2410081234' });
  });

  it('buys message credit for the owner', async () => {
    signedIn();
    const core = billingCore('owner', { open: null });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/billing');

    await screen.findByText('Message credit');
    type('Credit to buy, in rupees', '2,000');
    await press('Buy credit');
    await waitFor(() =>
      expect(core.sent.find((each) => each.operation === 'BillingCreditsBuy')?.variables).toEqual({
        input: { amount: '2000' },
      }),
    );
  });

  it('lists what changed the message credit, the newest first, and shows more of it', async () => {
    signedIn();
    const whatsapp = { channel: 'WHATSAPP', category: 'UTILITY' } as const;
    const entries = [
      entry('we_1', 'MESSAGE', '-4.50', '120.50', whatsapp),
      entry('we_2', 'MESSAGE_REFUND', '4.50', '125.00', whatsapp),
      entry('we_3', 'MESSAGE', '-3.00', '120.50', {
        channel: 'SMS',
        category: 'AUTHENTICATION',
        parts: 2,
      }),
      entry('we_4', 'TOP_UP', '100.00', '123.50'),
      entry('we_5', 'GRANT', '25.00', '23.50', { note: 'Welcome credit' }),
      ...Array.from({ length: 18 }, (_, index) =>
        entry(`we_${6 + index}`, 'MESSAGE', '-1.50', '0.00', {
          channel: 'WHATSAPP',
          category: 'MARKETING',
        }),
      ),
    ];
    const core = billingCore('manager', { open: null, entries });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/billing');

    const heading = await screen.findByText('What changed it');
    const rows = () => heading.parentElement!.querySelectorAll('li');
    expect(rows()).toHaveLength(20);
    expect([...rows()].slice(0, 5).map((row) => row.firstElementChild?.textContent)).toEqual([
      "WhatsApp: an order's news",
      'Given back: a WhatsApp message not delivered',
      'SMS in 2 parts: a code to prove a number',
      'Credit bought',
      'Given by Hatti: Welcome credit',
    ]);
    expect(rows()[0]!.textContent).toContain('-Rs 4.50');
    expect(rows()[0]!.textContent).toContain('Balance after: Rs 120.50');
    expect(rows()[3]!.textContent).toContain('+Rs 100');

    await press('Show more');
    await waitFor(() => expect(rows()).toHaveLength(23));
    expect(
      core.sent
        .filter((each) => each.operation === 'BillingWalletEntries')
        .map((each) => each.variables),
    ).toEqual([{ first: 20 }, { first: 100 }]);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('says nothing changed the credit yet', async () => {
    signedIn();
    vi.stubGlobal('fetch', billingCore('owner', { open: null }).fetcher);
    renderAdmin('/shop_1/settings/billing');

    await screen.findByText('Nothing yet: credit bought and the messages it pays for show here.');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('shows a manager the plan and invoices, which the owner alone changes and pays', async () => {
    signedIn();
    const core = billingCore('manager', { open: invoice() });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/billing');

    await screen.findByText("The shop's owner changes its plan and pays its invoices.");
    expect(screen.getByText("The shop's owner pays it.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose Growth' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pay by card or wallet' })).toBeNull();
    expect(screen.queryByLabelText('Credit to buy, in rupees')).toBeNull();
  });
});
