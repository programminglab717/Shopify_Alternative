import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, LATER, press, renderAdmin, signedIn } from '../test-support';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });

const CARD = {
  accountId: 'cra_1',
  originCity: 'Lahore',
  localFirst: pkr('150.0'),
  localEach: pkr('50.0'),
  otherFirst: pkr('250.0'),
  otherEach: pkr('100.0'),
  codFeePercent: 2.5,
  returnPercent: 50,
  updatedAt: LATER,
};

/** A shop with one courier account, with the card `card` or none. */
function core(card: typeof CARD | null) {
  let kept = card;
  return fakeCore('owner', (operation, variables) => {
    if (operation === 'CourierRateCards') {
      return {
        courierAccounts: [{ id: 'cra_1', name: 'PostEx Lahore', courierName: 'PostEx' }],
        courierRateCards: kept ? [kept] : [],
      };
    }
    if (operation === 'CourierRateCardSet') {
      const input = variables.input as Record<string, string>;
      if (input.originCity === 'Atlantis') {
        return {
          courierRateCardSet: {
            courierRateCard: null,
            userErrors: [
              {
                field: ['input', 'originCity'],
                code: 'INVALID',
                message: '"Atlantis" is not a city of Pakistan we know',
              },
            ],
          },
        };
      }
      kept = { ...CARD, originCity: input.originCity! };
      return { courierRateCardSet: { courierRateCard: kept, userErrors: [] } };
    }
    if (operation === 'CourierRateCardRemove') {
      kept = null;
      return { courierRateCardRemove: { removed: true, userErrors: [] } };
    }
    throw new Error(`unexpected ${operation}`);
  });
}

describe("A courier account's rate card in settings (ADR-383)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sets a card, saying what is wrong with it, and sends it whole', async () => {
    const fake = core(null);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/couriers/cra_1/rates');

    await screen.findByText('Rate card: PostEx Lahore');
    expect(screen.queryByRole('button', { name: 'Remove rate card' })).toBeNull();
    const type = (label: string, value: string, at = 0) =>
      fireEvent.change(screen.getAllByLabelText(label)[at]!, { target: { value } });
    type('City you ship from', 'Atlantis');
    type('First half kilo (Rs)', '150');
    type('Each half kilo after (Rs)', '50');
    type('First half kilo (Rs)', '250', 1);
    type('Each half kilo after (Rs)', '100', 1);
    type('Cash handling (%)', '2.5');
    type('Return charge (% of the charge)', '50');
    await press('Save rate card');
    expect(await screen.findByText('"Atlantis" is not a city of Pakistan we know')).toBeTruthy();

    type('City you ship from', 'Lahore');
    await press('Save rate card');
    await screen.findByText('Rate card saved. Parcels booked from now on are costed by it.');
    expect(
      fake.sent.filter((each) => each.operation === 'CourierRateCardSet').at(-1)?.variables,
    ).toEqual({
      accountId: 'cra_1',
      input: {
        originCity: 'Lahore',
        localFirst: '150',
        localEach: '50',
        otherFirst: '250',
        otherEach: '100',
        codFeePercent: '2.5',
        returnPercent: '50',
      },
    });
  });

  it('shows the card kept, and takes it away', async () => {
    const fake = core(CARD);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/couriers/cra_1/rates');

    expect((await screen.findByLabelText<HTMLInputElement>('City you ship from')).value).toBe(
      'Lahore',
    );
    expect(screen.getAllByLabelText<HTMLInputElement>('First half kilo (Rs)')[1]!.value).toBe(
      '250',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Cash handling (%)').value).toBe('2.5');
    await press('Remove rate card');
    await screen.findByText('Rate card removed. Parcels booked from now on are not costed.');
    expect(fake.sent.some((each) => each.operation === 'CourierRateCardRemove')).toBe(true);
  });
});
