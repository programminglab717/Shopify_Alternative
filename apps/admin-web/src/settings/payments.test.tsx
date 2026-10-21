import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const saved = { userErrors: [] };

const DELIVERY = {
  charge: rupees('250.00'),
  freeAbove: null,
  days: null,
  zones: [],
  updatedAt: null,
};

const COD = {
  fee: rupees('0.00'),
  maxOrderTotal: null,
  refusedDeliveriesLimit: null,
  riskScoreLimit: null,
  verifyFromScore: null,
  unavailableCities: [],
  unavailableProductTags: [],
  advance: null,
  updatedAt: null,
};

describe('Delivery and payment settings in the admin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('saves delivery charges, the days delivery takes and a zone of cities', async () => {
    const core = fakeCore('owner', (operation) => {
      if (operation === 'DeliverySettings') return { deliverySettings: DELIVERY };
      if (operation === 'DeliverySettingsUpdate') return { deliverySettingsUpdate: saved };
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/delivery');

    expect(((await screen.findByLabelText('Delivery charge')) as HTMLInputElement).value).toBe(
      '250',
    );
    type('Delivery charge', '200');
    type('Free delivery from', '5,000');
    type('Fewest working days', '3');
    type('Most working days', '5');
    await press('Add a zone');
    type('Name', 'Lahore');
    type('Charge', '150');
    type('Cities', 'Lahore, kasur, Lahore');
    await press('Save');

    await screen.findByText('Saved. Checkout uses it from now on.');
    expect(
      core.sent.find((each) => each.operation === 'DeliverySettingsUpdate')?.variables,
    ).toEqual({
      input: {
        charge: '200',
        freeAbove: '5,000',
        days: { min: 3, max: 5 },
        zones: [{ name: 'Lahore', charge: '150', cities: ['Lahore', 'kasur'], days: null }],
        cutoffHour: null,
        weights: [],
      },
    });
  });

  it("sets the hour from which the day's orders count from the next day (ADR-597)", async () => {
    const core = fakeCore('owner', (operation) => {
      if (operation === 'DeliverySettings') {
        return { deliverySettings: { ...DELIVERY, cutoffHour: 15 } };
      }
      if (operation === 'DeliverySettingsUpdate') return { deliverySettingsUpdate: saved };
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/delivery');

    const cutoff = (await screen.findByLabelText(
      "Cut-off for the day's orders",
    )) as HTMLSelectElement;
    expect(cutoff.value).toBe('15');
    expect(cutoff.selectedOptions[0]?.textContent).toBe('3 pm');
    fireEvent.change(cutoff, { target: { value: '12' } });
    await press('Save');
    await screen.findByText('Saved. Checkout uses it from now on.');
    expect(
      core.sent.find((each) => each.operation === 'DeliverySettingsUpdate')?.variables,
    ).toMatchObject({ input: { cutoffHour: 12 } });
  });

  it('saves what heavier orders cost more, weights in kilograms sent in grams (ADR-703)', async () => {
    let answer: unknown = saved;
    const core = fakeCore('owner', (operation) => {
      if (operation === 'DeliverySettings') {
        return {
          deliverySettings: {
            ...DELIVERY,
            weights: [{ aboveGrams: 2000, charge: rupees('100.00') }],
          },
        };
      }
      if (operation === 'DeliverySettingsUpdate') return { deliverySettingsUpdate: answer };
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/delivery');

    expect(((await screen.findByLabelText('Over (kg)')) as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('Costs more') as HTMLInputElement).value).toBe('100');
    await press('Add a weight');
    fireEvent.change(screen.getAllByLabelText('Over (kg)')[1]!, { target: { value: 'heavy' } });
    fireEvent.change(screen.getAllByLabelText('Costs more')[1]!, { target: { value: '300' } });
    await press('Save');
    expect(screen.getByText('Weight 2: type a weight in kilograms, such as 2 or 2.5')).toBeTruthy();
    expect(core.sent.some((each) => each.operation === 'DeliverySettingsUpdate')).toBe(false);

    fireEvent.change(screen.getAllByLabelText('Over (kg)')[1]!, { target: { value: '5.5' } });
    await press('Save');
    await screen.findByText('Saved. Checkout uses it from now on.');
    expect(
      core.sent.find((each) => each.operation === 'DeliverySettingsUpdate')?.variables,
    ).toMatchObject({
      input: {
        weights: [
          { aboveGrams: 2000, charge: '100' },
          { aboveGrams: 5500, charge: '300' },
        ],
      },
    });

    // The core's problems name the weight.
    answer = {
      userErrors: [
        {
          field: ['input', 'weights', '1', 'aboveGrams'],
          code: 'TAKEN',
          message: 'This weight has a charge already',
        },
      ],
    };
    await press('Save');
    await screen.findByText('Weight 2 · Over (kg): This weight has a charge already');
  });

  it("names the zone a problem is in, and keeps days that aren't numbers from the core", async () => {
    const zone = {
      name: 'Karachi',
      cities: ['Karachi'],
      charge: rupees('100.00'),
      days: { min: 1, max: 2 },
    };
    const core = fakeCore('owner', (operation) => {
      if (operation === 'DeliverySettings') {
        return { deliverySettings: { ...DELIVERY, zones: [zone, { ...zone, name: 'Sindh' }] } };
      }
      if (operation === 'DeliverySettingsUpdate') {
        return {
          deliverySettingsUpdate: {
            userErrors: [
              {
                field: ['input', 'zones', '1', 'cities'],
                code: 'TAKEN',
                message: 'Karachi is in another zone',
              },
            ],
          },
        };
      }
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/delivery');

    await screen.findByText('Zone 2');
    fireEvent.change(screen.getAllByLabelText('Fewest working days')[1]!, {
      target: { value: 'two' },
    });
    await press('Save');
    expect(
      screen.getByText('Zone 1: type whole days from 0 to 30, or leave both blank'),
    ).toBeTruthy();
    expect(core.sent.some((each) => each.operation === 'DeliverySettingsUpdate')).toBe(false);

    fireEvent.change(screen.getAllByLabelText('Fewest working days')[1]!, {
      target: { value: '1' },
    });
    await press('Save');
    await screen.findByText('Zone 2 · Cities: Karachi is in another zone');
  });

  it('saves cash on delivery rules and an advance, scores out of 100 as the core keeps 0 to 1', async () => {
    const core = fakeCore('manager', (operation) => {
      if (operation === 'CashOnDeliverySettings') {
        return {
          cashOnDeliverySettings: COD,
          bankTransferSettings: { enabled: false, account: null },
        };
      }
      if (operation === 'CashOnDeliverySettingsUpdate') {
        return { cashOnDeliverySettingsUpdate: saved };
      }
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/cash-on-delivery');

    await screen.findByText('An advance is paid into your bank account: give it first.');
    type('Cash on delivery fee', '100');
    type('Cities', 'Gilgit, Skardu');
    type('Ask for a code from score', '40');
    type('Pay another way from score', '80');
    fireEvent.change(screen.getByLabelText('Ask for'), { target: { value: 'PERCENTAGE' } });
    type('Percentage', '20');
    fireEvent.click(screen.getByRole('checkbox', { name: /From new customers alone/ }));
    await press('Save');

    await screen.findByText('Saved. Checkout uses it from now on.');
    expect(
      core.sent.find((each) => each.operation === 'CashOnDeliverySettingsUpdate')?.variables,
    ).toEqual({
      input: {
        fee: '100',
        maxOrderTotal: null,
        unavailableCities: ['Gilgit', 'Skardu'],
        unavailableProductTags: [],
        refusedDeliveriesLimit: null,
        verifyFromScore: 0.4,
        riskScoreLimit: 0.8,
        advance: {
          percentage: 20,
          above: null,
          cities: [],
          productTags: [],
          onTaggedProducts: false,
          newCustomers: true,
          refusedDeliveries: null,
          riskScore: null,
        },
      },
    });
  });

  it('counts an amount or a share on the products it tags alone, where the shop says (ADR-712)', async () => {
    const core = fakeCore('manager', (operation) => {
      if (operation === 'CashOnDeliverySettings') {
        return {
          cashOnDeliverySettings: COD,
          bankTransferSettings: { enabled: false, account: null },
        };
      }
      if (operation === 'CashOnDeliverySettingsUpdate') {
        return { cashOnDeliverySettingsUpdate: saved };
      }
      throw new Error(`unexpected ${operation}`);
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/cash-on-delivery');

    await screen.findByText('An advance is paid into your bank account: give it first.');
    fireEvent.change(screen.getByLabelText('Ask for'), { target: { value: 'PERCENTAGE' } });
    type('Percentage', '50');
    const alone = /Counted on those products alone/;
    // Offered once it names tags, and for an amount or a share alone.
    expect(screen.queryByRole('checkbox', { name: alone })).toBeNull();
    type('Holding products tagged', 'custom-stitching');
    fireEvent.click(screen.getByRole('checkbox', { name: alone }));
    await press('Save');

    await screen.findByText('Saved. Checkout uses it from now on.');
    expect(
      core.sent.find((each) => each.operation === 'CashOnDeliverySettingsUpdate')?.variables,
    ).toMatchObject({
      input: {
        advance: { percentage: 50, productTags: ['custom-stitching'], onTaggedProducts: true },
      },
    });
    fireEvent.change(screen.getByLabelText('Ask for'), { target: { value: 'DELIVERY_CHARGE' } });
    expect(screen.queryByRole('checkbox', { name: alone })).toBeNull();
  });

  it('gives the bank account once the owner confirms who they are, naming what the core refused', async () => {
    let confirmed = false;
    let tries = 0;
    const core = fakeCore(
      'owner',
      (operation) => {
        if (operation === 'BankTransferSettings') {
          return {
            bankTransferSettings: {
              enabled: false,
              account: null,
              discount: null,
              updatedAt: null,
            },
          };
        }
        if (operation === 'BankTransferSettingsUpdate') {
          if (!confirmed) return REAUTHENTICATE;
          tries += 1;
          return {
            bankTransferSettingsUpdate:
              tries === 1
                ? {
                    userErrors: [
                      {
                        field: ['input', 'account', 'iban'],
                        code: 'INVALID',
                        message: 'Its check digits are wrong',
                      },
                    ],
                  }
                : saved,
          };
        }
        throw new Error(`unexpected ${operation}`);
      },
      (path) => {
        if (path === '/auth/reauthenticate/options') return { methods: ['password'], phone: null };
        if (path === '/auth/reauthenticate') {
          confirmed = true;
          return { authenticatedAt: LATER, sensitiveActionsUntil: LATER };
        }
        throw new Error(`unexpected ${path}`);
      },
    );
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/bank-transfer');

    await screen.findByLabelText('Bank');
    type('Bank', 'Meezan Bank');
    type('Account title', 'Zari Fabrics');
    type('IBAN', 'PK36 SCBL 0000 0011 2345 6703');
    type('Raast ID (optional)', '0300 1234567');
    fireEvent.click(screen.getByRole('checkbox', { name: /Offer bank transfer at checkout/ }));
    fireEvent.change(screen.getByLabelText('Something off for paying by transfer'), {
      target: { value: 'PERCENTAGE' },
    });
    type('Percentage off', '5');
    type('At most', '500');
    await press('Save');

    await confirmIdentity('Password', 'owner-password');
    await press('Confirm');
    await screen.findByText('IBAN: Its check digits are wrong');

    type('IBAN', 'PK36 SCBL 0000 0011 2345 6702');
    await press('Save');
    await screen.findByText('Saved. Checkout uses it from now on.');
    const updates = core.sent.filter((each) => each.operation === 'BankTransferSettingsUpdate');
    expect(updates).toHaveLength(3);
    expect(updates[2]?.variables).toEqual({
      input: {
        enabled: true,
        account: {
          bankName: 'Meezan Bank',
          title: 'Zari Fabrics',
          iban: 'PK36 SCBL 0000 0011 2345 6702',
          raastId: '0300 1234567',
          instructions: '',
        },
        discount: { percentage: 5, cap: '500' },
      },
    });
  });
});
