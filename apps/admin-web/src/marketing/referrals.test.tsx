import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReferralProgramValue, ReferralValue } from '../api/types';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const rs = (amount: string) => ({ amount });

const OFF: ReferralProgramValue = {
  enabled: false,
  referrerCredit: rs('200.00'),
  friendCredit: rs('200.00'),
  creditDays: 90,
  minimumOrder: rs('0.00'),
  perMonth: 10,
  updatedAt: null,
};

const REFERRALS: ReferralValue[] = [
  {
    orderId: 'ord_2',
    referrerId: 'cus_1',
    friendId: 'cus_3',
    outcome: 'REFUSED',
    reason: 'SAME_DEVICE',
    referrerCredit: rs('0.00'),
    friendCredit: rs('0.00'),
    createdAt: '2026-10-22T09:00:00Z',
  },
  {
    orderId: 'ord_1',
    referrerId: 'cus_1',
    friendId: 'cus_2',
    outcome: 'REWARDED',
    reason: null,
    referrerCredit: rs('200.00'),
    friendCredit: rs('150.00'),
    createdAt: '2026-10-20T09:00:00Z',
  },
];

/** A fake core keeping the shop's programme as the core would. */
function referralsCore(referrals: ReferralValue[] = REFERRALS) {
  let program = { ...OFF };
  return fakeCore('marketer', (operation, variables) => {
    const input = (variables?.input ?? {}) as Record<string, string | number | boolean>;
    switch (operation) {
      case 'Referrals':
        return { referralProgram: program, referrals };
      case 'ReferralProgramUpdate': {
        if (input.referrerCredit === '5') {
          return {
            referralProgramUpdate: {
              referralProgram: null,
              userErrors: [
                {
                  field: ['input', 'referrerCredit'],
                  code: 'INVALID',
                  message: 'Give the referrer between Rs 10 and Rs 10,000 in store credit',
                },
              ],
            },
          };
        }
        const amount = (text: unknown) => rs(`${String(text).replace(/,/g, '')}.00`);
        program = {
          ...program,
          enabled: Boolean(input.enabled),
          referrerCredit: amount(input.referrerCredit),
          friendCredit: amount(input.friendCredit),
          creditDays: Number(input.creditDays),
          minimumOrder: amount(input.minimumOrder),
          updatedAt: '2026-10-27T09:00:00Z',
        };
        return { referralProgramUpdate: { referralProgram: program, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('Referrals in the admin (MKT-07, ADR-808)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('turns the programme on with its credit, checked first, and says what the checks refuse', async () => {
    const core = referralsCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/marketing/referrals');

    await screen.findByLabelText('Days the credit lasts');
    expect(screen.getByText(/or more than 10 in 30 days/, { exact: false }).textContent).toContain(
      "Refused: the customer's own order",
    );
    const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
    expect(field('Store credit for the customer who shared the link (Rs)').value).toBe('200');
    expect(field('Days the credit lasts').value).toBe('90');

    type('Days the credit lasts', '400');
    await press('Save');
    await screen.findByText(
      'Say the store credit and the order in rupees, and the days from 7 to 365.',
    );
    type('Days the credit lasts', '60');
    type('Store credit for the customer who shared the link (Rs)', '5');
    await press('Save');
    await screen.findByText(/Give the referrer between Rs 10 and Rs 10,000/);

    type('Store credit for the customer who shared the link (Rs)', '300');
    type('Store credit for the friend (Rs)', '0');
    type("The friend's order of at least (Rs)", '1,500');
    screen.getByLabelText('Reward referrals').click();
    await press('Save');
    await screen.findByText('Saved.');
    expect(
      core.sent.filter((each) => each.operation === 'ReferralProgramUpdate').at(-1)?.variables,
    ).toEqual({
      input: {
        enabled: true,
        referrerCredit: '300',
        friendCredit: '0',
        creditDays: 60,
        minimumOrder: '1,500',
      },
    });
    await waitFor(() => expect(field("The friend's order of at least (Rs)").value).toBe('1500'));
  });

  it('lists referrals, rewarded with what each was given or refused with why', async () => {
    vi.stubGlobal('fetch', referralsCore().fetcher);
    renderAdmin('/shop_1/marketing/referrals');

    const list = (await screen.findByText('Referrals so far')).nextElementSibling as HTMLElement;
    const [refused, rewarded] = within(list).getAllByRole('listitem');
    expect(within(refused!).getByText('Refused')).toBeTruthy();
    expect(within(refused!).getByText("Ordered from the customer's phone")).toBeTruthy();
    expect(within(rewarded!).getByText('Rewarded')).toBeTruthy();
    expect(within(rewarded!).getByText(/to the customer, .* to the friend/).textContent).toMatch(
      /200.*150/,
    );
    expect(within(rewarded!).getByRole('link', { name: 'Order' }).getAttribute('href')).toBe(
      '/shop_1/orders/ord_1',
    );
    expect(within(rewarded!).getByRole('link', { name: 'Friend' }).getAttribute('href')).toBe(
      '/shop_1/customers/cus_2',
    );
  });

  it('says when there are none yet', async () => {
    vi.stubGlobal('fetch', referralsCore([]).fetcher);
    renderAdmin('/shop_1/marketing/referrals');
    expect(await screen.findByText('No referrals yet')).toBeTruthy();
  });
});
