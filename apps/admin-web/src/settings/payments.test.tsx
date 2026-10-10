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
      },
    });
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
          newCustomers: true,
          refusedDeliveries: null,
          riskScore: null,
        },
      },
    });
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
