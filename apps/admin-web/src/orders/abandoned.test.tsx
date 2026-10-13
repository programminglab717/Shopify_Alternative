import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn } from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

function left(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    createdAt: LATER,
    abandonedAt: LATER,
    name: 'Ayesha Khan',
    phone: '+923001234567',
    lineItems: [
      { variantId: 'var_1', title: 'Lawn suit', variantTitle: 'M', quantity: 2 },
      { variantId: 'var_2', title: 'Dupatta', variantTitle: 'Default Title', quantity: 1 },
    ],
    subtotalPrice: rupees('9700.00'),
    remindedAt: null,
    recoveredOrder: null,
    ...extra,
  };
}

function core(
  role: StaffRole,
  pages: unknown[][] = [
    [
      left('ack_1', { remindedAt: LATER }),
      left('ack_2', { name: null, recoveredOrder: { id: 'ord_31', name: '#1031' } }),
    ],
  ],
  reminderAfterMinutes: number | null = 60,
) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'AbandonedCheckouts': {
        const page = variables.after ? 1 : 0;
        return {
          abandonedCheckouts: pages[page] ?? [],
          checkoutRecoverySettings: { reminderAfterMinutes },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('Abandoned checkouts (CHK-12, ADR-393)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists who left, what they would have ordered, and whether they were reminded or ordered', async () => {
    vi.stubGlobal('fetch', core('owner').fetcher);
    renderAdmin('/shop_1/abandoned-checkouts');

    await screen.findByRole('heading', { name: 'Abandoned checkouts' });
    expect(await screen.findByText(/and reminded once on WhatsApp 1 hour after\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Change' }).getAttribute('href')).toBe(
      '/shop_1/settings/checkout',
    );
    const [reminded, ordered] = screen.getAllByRole('listitem');
    expect(within(reminded!).getByText('Ayesha Khan')).toBeTruthy();
    expect(within(reminded!).getByText('0300 1234567')).toBeTruthy();
    expect(within(reminded!).getByText('2 × Lawn suit (M), 1 × Dupatta')).toBeTruthy();
    expect(within(reminded!).getByText('Rs 9,700')).toBeTruthy();
    expect(within(reminded!).getByText(/^Reminded /)).toBeTruthy();
    expect(
      within(reminded!).getByRole('link', { name: 'Message on WhatsApp' }).getAttribute('href'),
    ).toBe('https://wa.me/923001234567');
    // Ordered since: its order, and nobody to message.
    expect(within(ordered!).getByText('No name given')).toBeTruthy();
    expect(
      within(ordered!).getByRole('link', { name: 'Ordered: #1031' }).getAttribute('href'),
    ).toBe('/shop_1/orders/ord_31');
    expect(within(ordered!).queryByRole('link', { name: 'Message on WhatsApp' })).toBeNull();
  });

  it('shows numbers masked to marketers, with nobody to message, and says reminders are off', async () => {
    vi.stubGlobal(
      'fetch',
      core('marketer', [[left('ack_1', { phone: '0300 ••••567' })]], null).fetcher,
    );
    renderAdmin('/shop_1/abandoned-checkouts');

    expect(await screen.findByText(/They are not reminded\./)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Change' })).toBeNull();
    expect(screen.getByText('0300 ••••567')).toBeTruthy();
    expect(screen.getByText('Not reminded')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Message on WhatsApp' })).toBeNull();
  });

  it('pages through older checkouts, fifty at a time', async () => {
    const first = Array.from({ length: 50 }, (_, index) => left(`ack_${index}`));
    const fake = core('manager', [first, [left('ack_old', { name: 'Bilal' })]]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/abandoned-checkouts');

    fireEvent.click(await screen.findByRole('button', { name: 'Older' }));
    expect(await screen.findByText('Bilal')).toBeTruthy();
    await waitFor(() =>
      expect(
        fake.sent.filter((each) => each.operation === 'AbandonedCheckouts').at(-1)!.variables,
      ).toEqual({ first: 50, after: 'ack_49' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Newer' }));
    expect(await screen.findAllByText('Ayesha Khan')).toHaveLength(50);
  });

  it('is empty until somebody leaves a checkout with their number', async () => {
    vi.stubGlobal('fetch', core('confirmation_agent', [[]]).fetcher);
    renderAdmin('/shop_1/abandoned-checkouts');
    expect(
      await screen.findByText('Nobody has left a checkout after typing their number yet.'),
    ).toBeTruthy();
  });
});
