import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, LATER, press, renderAdmin, signedIn } from '../test-support';

const account = (id: string, name: string, courierName: string, isDefault: boolean) => ({
  id,
  name,
  courier: courierName.toLowerCase(),
  courierName,
  isDefault,
  credentialsHint: 'f00d',
  pickupCode: null,
  createdAt: LATER,
});

const ACCOUNTS = [
  account('cra_1', 'PostEx', 'PostEx', true),
  account('cra_2', 'Karachi', 'Leopards', false),
];

const KARACHI = {
  id: 'crl_1',
  accountId: 'cra_2',
  accountArchived: false,
  cities: ['Karachi', 'Hyderabad'],
  codAtLeast: null,
  codBelow: null,
};

/** The couriers page of a shop with two accounts and `rules`; what is saved, kept. */
function core(rules: unknown[]) {
  let kept = rules;
  return fakeCore('owner', (operation, variables) => {
    if (operation === 'CourierAccounts') return { couriers: [], courierAccounts: ACCOUNTS };
    if (operation === 'CourierRules') return { courierRules: kept };
    if (operation === 'CourierRulesUpdate') {
      const asked = variables.rules as { cities: string[] }[];
      if (asked.some((rule) => rule.cities.includes('Atlantis'))) {
        return {
          courierRulesUpdate: {
            courierRules: null,
            userErrors: [
              {
                field: ['rules', '1', 'cities', '0'],
                code: 'INVALID',
                message: '"Atlantis" is not a city of Pakistan we know',
              },
            ],
          },
        };
      }
      kept = asked.map((rule, index) => ({
        ...rule,
        id: `crl_${index + 1}`,
        accountArchived: false,
        codAtLeast: null,
        codBelow: null,
      }));
      return { courierRulesUpdate: { courierRules: kept, userErrors: [] } };
    }
    throw new Error(`unexpected ${operation}`);
  });
}

describe('Courier rules in settings (ADR-382)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('adds a rule, says what is wrong with one, and saves them in their order', async () => {
    const fake = core([KARACHI]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/couriers');

    await screen.findByText('Which courier books an order');
    expect(
      screen.getByText(
        'When orders are booked without choosing an account, each goes with the first rule it matches; the rest go with PostEx, the default.',
      ),
    ).toBeTruthy();
    const first = screen.getByRole('listitem', { name: 'Rule 1' });
    expect(within(first).getByLabelText<HTMLInputElement>('Cities').value).toBe(
      'Karachi, Hyderabad',
    );
    expect(within(first).getByLabelText<HTMLSelectElement>('Book with').value).toBe('cra_2');

    fireEvent.click(screen.getByRole('button', { name: 'Add a rule' }));
    const second = screen.getByRole('listitem', { name: 'Rule 2' });
    fireEvent.change(within(second).getByLabelText('Cities'), { target: { value: 'Atlantis' } });
    await press('Save rules');
    expect(
      await screen.findByText('Rule 2: "Atlantis" is not a city of Pakistan we know'),
    ).toBeTruthy();

    fireEvent.change(within(second).getByLabelText('Cities'), { target: { value: '' } });
    fireEvent.change(within(second).getByLabelText('Cash to collect at least (Rs)'), {
      target: { value: '20,000' },
    });
    // The rule for cash comes first.
    fireEvent.click(screen.getByRole('button', { name: 'Move rule 2 up' }));
    await press('Save rules');
    await screen.findByText('Rules saved. Orders booked from now on follow them.');
    expect(
      fake.sent.filter((each) => each.operation === 'CourierRulesUpdate').at(-1)?.variables,
    ).toEqual({
      rules: [
        { accountId: 'cra_1', cities: [], codAtLeast: '20,000', codBelow: null },
        { accountId: 'cra_2', cities: ['Karachi', 'Hyderabad'], codAtLeast: null, codBelow: null },
      ],
    });
  });

  it('warns of a rule whose account was archived, and takes rules away', async () => {
    const fake = core([{ ...KARACHI, accountId: 'cra_9', accountArchived: true }]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/couriers');

    const rule = await screen.findByRole('listitem', { name: 'Rule 1' });
    expect(
      within(rule).getByText(
        "This rule's account was archived, so the rule is passed over. Choose another account or remove it.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 1' }));
    expect(
      screen.getByText('No rules: orders booked without choosing an account go with the default.'),
    ).toBeTruthy();
    await press('Save rules');
    await screen.findByText('Rules saved. Orders booked from now on follow them.');
    expect(fake.sent.find((each) => each.operation === 'CourierRulesUpdate')?.variables).toEqual({
      rules: [],
    });
  });
});
