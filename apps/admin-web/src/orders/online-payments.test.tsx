import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentRefundStatus } from '../api/types';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, press, renderAdmin, signedIn, type } from '../test-support';
import { waitsForAnswer } from './online-payments';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const ORDER = {
  id: 'ord_8',
  name: '#1008',
  createdAt: LATER,
  stage: 'TO_PACK',
  status: 'OPEN',
  paymentMethod: 'ONLINE',
  financialStatus: 'PARTIALLY_REFUNDED',
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
  amountPaid: rupees('5599'),
  codAmount: rupees('0'),
  customer: null,
  shippingAddress: { name: 'Ayesha', phone: '+923001234567', city: 'Lahore', formatted: [] },
  risk: null,
  assignee: null,
  amountRefunded: rupees('500'),
  advanceDue: rupees('0'),
  transferReceipts: [],
  customerLink: null,
  refunds: [],
  fulfillments: [],
  returns: [],
  events: { nodes: [] },
};

function refund(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status,
    reference: null as string | null,
    error: null as string | null,
    createdAt: minutesAgo(30),
    amount: rupees('1000'),
    ...extra,
  };
}

function session(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    gatewayName: 'Safepay',
    environment: 'PRODUCTION',
    status: 'PAID',
    method: null,
    reference: null,
    error: null,
    createdAt: LATER,
    paidAt: LATER,
    amount: rupees('5599'),
    paidAmount: rupees('5599'),
    applied: rupees('5599'),
    refunds: [],
    ...extra,
  };
}

/**
 * The order's payments online, the latest first: a paid one with its refunds, through the gateway
 * whose answers came, never came, or are late; one paid twice over; a test one; one never paid;
 * one the gateway would not start. A refund settled takes its answer.
 */
function onlineCore(role: StaffRole) {
  let refunds = [
    refund('prf_1', 'REFUNDED', { reference: 'SP-RF-1', amount: rupees('500') }),
    refund('prf_2', 'REFUSED', { error: 'Refunds past 30 days are not allowed' }),
    refund('prf_3', 'UNKNOWN', { error: 'Safepay did not answer' }),
    refund('prf_4', 'PENDING', { createdAt: minutesAgo(9), amount: rupees('700') }),
    refund('prf_5', 'PENDING', { createdAt: minutesAgo(1), amount: rupees('300') }),
  ];
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Order':
        return {
          shop: { timezone: 'Asia/Karachi' },
          order: ORDER,
          paymentSessions: [
            session('ps_5', { method: 'CARD', reference: 'track_9f2', refunds }),
            session('ps_4', {
              gatewayName: 'JazzCash',
              method: 'MWALLET',
              paidAmount: rupees('5599'),
              applied: rupees('0'),
            }),
            session('ps_3', { environment: 'SANDBOX', applied: rupees('0') }),
            session('ps_2', {
              gatewayName: 'Easypaisa',
              status: 'OPEN',
              paidAt: null,
              paidAmount: null,
              applied: null,
            }),
            session('ps_1', {
              gatewayName: 'PayFast',
              status: 'FAILED',
              error: 'PayFast refused the merchant ID',
              paidAt: null,
              paidAmount: null,
              applied: null,
            }),
          ],
        };
      case 'PaymentRefundSettle': {
        const input = variables.input as { refunded: boolean; reference: string | null };
        refunds = refunds.map((each) =>
          each.id === variables.id
            ? {
                ...each,
                status: input.refunded ? 'REFUNDED' : 'REFUSED',
                reference: input.reference,
                error: input.refunded ? null : 'Settled as not given back',
              }
            : each,
        );
        return {
          paymentRefundSettle: {
            paymentRefund: { id: variables.id, status: 'REFUNDED', reference: input.reference },
            userErrors: [],
          },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (core: ReturnType<typeof onlineCore>, operation: string) =>
  core.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("An order's payments online, and refunds whose answer never came", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows each payment started online: paid and how, what of it the order took, or why not', async () => {
    vi.stubGlobal('fetch', onlineCore('owner').fetcher);
    renderAdmin('/shop_1/orders/ord_8');

    const money = await screen.findByRole('region', { name: 'Payments and refunds' });
    await within(money).findByText('Online payments');
    const rows = within(money)
      .getByText('Online payments')
      .parentElement!.querySelectorAll(':scope > ul > li');
    expect([...rows].map((row) => row.firstElementChild?.firstElementChild?.textContent)).toEqual([
      'Safepay',
      'JazzCash',
      'SafepayTest environment',
      'Easypaisa',
      'PayFast',
    ]);
    expect(rows[0]!.textContent).toContain('Rs 5,599 paid');
    expect(within(rows[0] as HTMLElement).getByText('track_9f2')).toBeTruthy();
    expect(rows[0]!.textContent).toContain('CARD');
    expect(
      within(rows[1] as HTMLElement).getByText(
        'The order owed none of it: it is on its timeline, to give back.',
      ),
    ).toBeTruthy();
    expect(
      within(rows[2] as HTMLElement).getByText('A test payment: none of it was paid on the order.'),
    ).toBeTruthy();
    expect(
      within(rows[3] as HTMLElement).getByText('Started: the gateway has not said it is paid.'),
    ).toBeTruthy();
    expect(
      within(rows[4] as HTMLElement).getByText(
        'The gateway would not start it. PayFast refused the merchant ID',
      ),
    ).toBeTruthy();

    const refunds = within(rows[0] as HTMLElement);
    expect(refunds.getByText('Rs 500 given back through Safepay.', { exact: false })).toBeTruthy();
    expect(refunds.getByText('SP-RF-1')).toBeTruthy();
    expect(
      refunds.getByText(
        'Safepay would not give Rs 1,000 back: Refunds past 30 days are not allowed',
      ),
    ).toBeTruthy();
    expect(refunds.getByText('Rs 700 asked back of Safepay, which has not answered.')).toBeTruthy();
    // A refund asked a minute ago waits for its answer: nothing to settle yet.
    expect(refunds.getByText('Rs 300 being asked back of Safepay.')).toBeTruthy();
    expect(refunds.getAllByRole('button', { name: 'It was given back' })).toHaveLength(2);
  });

  it("settles a refund whose answer never came as the gateway's dashboard shows it", async () => {
    const core = onlineCore('manager');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/orders/ord_8');

    const unknown = (
      await screen.findByText(
        'Safepay did not say whether it gave Rs 1,000 back. It is held meanwhile, so it is not refunded twice.',
      )
    ).closest('li')!;
    fireEvent.click(within(unknown).getByRole('button', { name: 'It was given back' }));
    type("Safepay's reference for it (optional)", ' SP-RF-3 ');
    await press('Record it given back');
    await screen.findByText('Rs 1,000 recorded as given back.');
    expect(sentOf(core, 'PaymentRefundSettle')).toEqual([
      { id: 'prf_3', input: { refunded: true, reference: 'SP-RF-3' } },
    ]);
    await screen.findByText('SP-RF-3');

    const late = screen
      .getByText('Rs 700 asked back of Safepay, which has not answered.')
      .closest('li')!;
    fireEvent.click(within(late).getByRole('button', { name: 'It was not given back' }));
    expect(
      within(late).getByText(
        "Only if Safepay's dashboard shows it was not given back: its amount can then be refunded again.",
      ),
    ).toBeTruthy();
    // Nothing is settled until they say they are sure.
    expect(sentOf(core, 'PaymentRefundSettle')).toHaveLength(1);
    await press('Record it not given back');
    await screen.findByText('Recorded as not given back: it can be refunded again.');
    expect(sentOf(core, 'PaymentRefundSettle').at(-1)).toEqual({
      id: 'prf_4',
      input: { refunded: false, reference: null },
    });
    expect(screen.queryAllByRole('button', { name: 'It was given back' })).toHaveLength(0);
  });

  it('keeps settling to owners and managers, and knows when an answer is late', async () => {
    vi.stubGlobal('fetch', onlineCore('packer').fetcher);
    renderAdmin('/shop_1/orders/ord_8');

    await screen.findByText('Online payments');
    expect(screen.getByText('Rs 700 asked back of Safepay, which has not answered.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'It was given back' })).toBeNull();

    const now = Date.parse('2026-10-10T12:00:00Z');
    const asked = (minutes: number, status: PaymentRefundStatus = 'PENDING') => ({
      id: 'prf',
      status,
      reference: null,
      error: null,
      createdAt: new Date(now - minutes * 60_000).toISOString(),
      amount: rupees('300'),
    });
    expect(waitsForAnswer(asked(4), now)).toBe(false);
    expect(waitsForAnswer(asked(6), now)).toBe(true);
    expect(waitsForAnswer(asked(0, 'UNKNOWN'), now)).toBe(true);
    expect(waitsForAnswer(asked(60, 'REFUNDED'), now)).toBe(false);
  });
});
