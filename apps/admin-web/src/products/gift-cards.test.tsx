import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import type { GiftCard } from '../api/types';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const EID: GiftCard = {
  id: 'gc_1',
  lastCharacters: 'NPQR',
  initialValue: { amount: '5000.0' },
  balance: { amount: '3800.0' },
  expiresOn: '2026-12-31',
  expired: false,
  enabled: true,
  note: 'Eid',
  createdAt: '2026-10-01T09:00:00Z',
};

function core(role: StaffRole, cards: GiftCard[]) {
  let current = cards;
  const change = (id: string, next: (card: GiftCard) => GiftCard) => {
    current = current.map((card) => (card.id === id ? next(card) : card));
    return { giftCard: current.find((card) => card.id === id), userErrors: [] };
  };
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'GiftCards': {
        const query = (variables.query as string | null) ?? '';
        return {
          giftCards: {
            nodes: current.filter((card) => card.lastCharacters.endsWith(query.toUpperCase())),
          },
        };
      }
      case 'GiftCardCreate': {
        const input = variables.input as { initialValue: string; code?: string };
        if (input.code === 'TAKEN123') {
          return {
            giftCardCreate: {
              giftCard: null,
              giftCardCode: null,
              userErrors: [
                {
                  field: ['input', 'code'],
                  code: 'TAKEN',
                  message: 'Another gift card has this code',
                },
              ],
            },
          };
        }
        const code = input.code ?? 'ABCD EFGH JKLM 2345';
        const made: GiftCard = {
          ...EID,
          id: 'gc_2',
          lastCharacters: code.replace(/\s/g, '').slice(-4),
          initialValue: { amount: input.initialValue },
          balance: { amount: input.initialValue },
          expiresOn: null,
          note: '',
        };
        current = [made, ...current];
        return { giftCardCreate: { giftCard: made, giftCardCode: code, userErrors: [] } };
      }
      case 'GiftCardCredit':
        return {
          giftCardCredit: change(variables.id as string, (card) => ({
            ...card,
            balance: { amount: '4300.0' },
          })),
        };
      case 'GiftCardDebit':
        return {
          giftCardDebit: change(variables.id as string, (card) => ({
            ...card,
            balance: { amount: '3300.0' },
          })),
        };
      case 'GiftCardDeactivate':
        return {
          giftCardDeactivate: change(variables.id as string, (card) => ({
            ...card,
            enabled: false,
          })),
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("The admin's gift cards (CAT-12, PAY-13, ADR-450)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('issues a card and shows its code once, or says why not', async () => {
    const fake = core('owner', []);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/gift-cards');

    expect(await screen.findByText('No gift cards yet')).toBeTruthy();
    const issue = () => screen.getByRole('button', { name: 'Issue card' }) as HTMLButtonElement;
    expect(issue().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '2,500' } });
    fireEvent.change(screen.getByLabelText('Code (optional)'), { target: { value: 'TAKEN123' } });
    fireEvent.click(issue());
    expect(await screen.findByText('Another gift card has this code')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Code (optional)'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Last day it can be used (optional)'), {
      target: { value: '2026-12-31' },
    });
    fireEvent.click(issue());
    expect(await screen.findByText('ABCD EFGH JKLM 2345')).toBeTruthy();
    expect(
      screen.getByText(
        'Gift card issued. Give this code to the customer now: it is not shown again.',
      ),
    ).toBeTruthy();
    expect(sentOf(fake, 'GiftCardCreate')).toEqual([
      { input: { initialValue: '2500', code: 'TAKEN123' } },
      { input: { initialValue: '2500', expiresOn: '2026-12-31' } },
    ]);
    expect(await screen.findByText('•••• 2345')).toBeTruthy();
    expect(screen.getByText('Rs 2,500 of Rs 2,500 left')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('adds to a card, takes from it, finds it by its code’s end, and deactivates it for good', async () => {
    const fake = core('manager', [EID]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/products/gift-cards');

    expect(await screen.findByText('Rs 3,800 of Rs 5,000 left')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add to it' }));
    fireEvent.change(screen.getByLabelText('Amount to add'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Rs 4,300 of Rs 5,000 left')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Take from it' }));
    fireEvent.change(screen.getByLabelText('Amount to take'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('Why (optional)'), {
      target: { value: 'Paid at the shop' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Rs 3,300 of Rs 5,000 left')).toBeTruthy();
    expect(sentOf(fake, 'GiftCardCredit')).toEqual([
      { id: 'gc_1', input: { creditAmount: { amount: '500', currencyCode: 'PKR' } } },
    ]);
    expect(sentOf(fake, 'GiftCardDebit')).toEqual([
      {
        id: 'gc_1',
        input: { debitAmount: { amount: '1000', currencyCode: 'PKR' }, note: 'Paid at the shop' },
      },
    ]);

    fireEvent.change(screen.getByLabelText("Find by the code's last 4 characters"), {
      target: { value: 'zzzz' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText('No gift card has a code ending so')).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Find by the code's last 4 characters"), {
      target: { value: 'pqr' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText('•••• NPQR')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(screen.getByText(/Deactivate •••• NPQR for good\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, deactivate' }));
    expect(await screen.findByText('Deactivated')).toBeTruthy();
    await waitFor(() => expect(sentOf(fake, 'GiftCardDeactivate')).toEqual([{ id: 'gc_1' }]));
    expect(screen.queryByRole('button', { name: 'Add to it' })).toBeNull();
  });

  it('shows cards to accountants and confirmation agents, with nothing to change', async () => {
    vi.stubGlobal('fetch', core('accountant', [{ ...EID, expired: true }]).fetcher);
    renderAdmin('/shop_1/products/gift-cards');
    expect(await screen.findByText('•••• NPQR')).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.getByText('Issued 1 Oct 2026 · last day 2026-12-31')).toBeTruthy();
    expect(screen.queryByLabelText('Value')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to it' })).toBeNull();
  });
});
