import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const SETTINGS = {
  callingHours: null,
  firstCallMinutes: 30,
  deskWaitsForReminder: false,
  cancelUnpaidAfterDays: 3,
  cancelUnreachableAfterDays: null,
  customerCancellation: 'UNTIL_PACKED',
  updatedAt: null,
};

const RISK = {
  highValue: { amount: '15000.00', currencyCode: 'PKR' },
  holdAt: 0.6,
  updatedAt: null,
};

function core(role: StaffRole) {
  let settings: Record<string, unknown> = SETTINGS;
  let risk: Record<string, unknown> = RISK;
  return fakeCore(role, (operation, variables) => {
    const input = (variables?.input ?? {}) as Record<string, unknown>;
    switch (operation) {
      case 'OrderPolicies':
        return { orderSettings: settings, orderRiskSettings: risk };
      case 'OrderSettingsUpdate': {
        const hours = input.callingHours as { opens: string; closes: string } | undefined;
        if (hours && hours.closes <= hours.opens) {
          return {
            orderSettingsUpdate: {
              orderSettings: null,
              userErrors: [
                {
                  field: ['input', 'callingHours'],
                  code: 'INVALID',
                  message: 'Calling hours close at least an hour after they open, on the same day',
                },
              ],
            },
          };
        }
        settings = { ...settings, ...input, updatedAt: new Date().toISOString() };
        return { orderSettingsUpdate: { orderSettings: settings, userErrors: [] } };
      }
      case 'OrderRiskSettingsUpdate':
        risk = {
          ...risk,
          ...(input.highValue !== undefined && {
            highValue: {
              amount: `${String(input.highValue).replace(/,/g, '')}.00`,
              currencyCode: 'PKR',
            },
          }),
          ...(input.holdAt !== undefined && { holdAt: input.holdAt }),
          updatedAt: new Date().toISOString(),
        };
        return { orderRiskSettingsUpdate: { riskSettings: risk, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Order policies', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sets calling hours, cancelling and the desk, sending only what changed', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Order policies/ }));
    expect(((await screen.findByLabelText(/^Call at any time/)) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.queryByLabelText('Calls start')).toBeNull();
    fireEvent.click(screen.getByLabelText(/^Call at any time/));
    type('Calls start', '21:00');
    type('Calls end', '10:00');
    fireEvent.click(screen.getByLabelText(/^Wait for WhatsApp first/));
    type('Unreachable customers after (days)', '5');
    type('Unpaid orders after (days)', '');
    fireEvent.click(screen.getByLabelText(/^Until they confirm it/));

    fireEvent.click(screen.getByRole('button', { name: 'Save order policies' }));
    expect(
      await screen.findByText(
        'Calling hours: Calling hours close at least an hour after they open, on the same day',
      ),
    ).toBeTruthy();
    type('Calls start', '10:00');
    type('Calls end', '21:00');
    fireEvent.click(screen.getByRole('button', { name: 'Save order policies' }));
    expect(await screen.findByText('Saved. Orders from now on follow these.')).toBeTruthy();
    expect(sentOf(fake, 'OrderSettingsUpdate').at(-1)).toEqual({
      input: {
        callingHours: { opens: '10:00', closes: '21:00' },
        deskWaitsForReminder: true,
        cancelUnpaidAfterDays: null,
        cancelUnreachableAfterDays: 5,
        customerCancellation: 'UNTIL_CONFIRMED',
      },
    });
    expect(sentOf(fake, 'OrderRiskSettingsUpdate')).toEqual([]);
  });

  it('offers a paired product after the purchase at a percentage off, and offers none again (ADR-438)', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/orders');

    const offer = (await screen.findByLabelText(
      /^Offer a paired product on the order's page/,
    )) as HTMLInputElement;
    expect(offer.checked).toBe(false);
    expect(screen.queryByLabelText('Percentage off (%)')).toBeNull();
    fireEvent.click(offer);
    type('Percentage off (%)', 'lots');
    fireEvent.click(screen.getByRole('button', { name: 'Save order policies' }));
    expect(await screen.findByText('Percentage off (%): give a whole number')).toBeTruthy();
    type('Percentage off (%)', '15');
    fireEvent.click(screen.getByRole('button', { name: 'Save order policies' }));
    expect(await screen.findByText('Saved. Orders from now on follow these.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/^Offer a paired product on the order's page/));
    fireEvent.click(screen.getByRole('button', { name: 'Save order policies' }));
    await waitFor(() =>
      expect(sentOf(fake, 'OrderSettingsUpdate')).toEqual([
        { input: { upsellPercentOff: 15 } },
        { input: { upsellPercentOff: null } },
      ]),
    );
  });

  it('gives store credit back when a parcel comes back, where the shop says so (ADR-610)', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/orders');

    const back = (await screen.findByLabelText(
      /^Give store credit back when a parcel comes back/,
    )) as HTMLInputElement;
    expect(back.checked).toBe(false);
    fireEvent.click(back);
    fireEvent.click(screen.getByRole('button', { name: 'Save order policies' }));
    expect(await screen.findByText('Saved. Orders from now on follow these.')).toBeTruthy();
    expect(sentOf(fake, 'OrderSettingsUpdate')).toEqual([{ input: { creditBackOnReturn: true } }]);
    expect(
      (
        screen.getByLabelText(
          /^Give store credit back when a parcel comes back/,
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it('calls in Urdu the customers of high-value orders who leave the reminder unanswered (ADR-611)', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/orders');

    const calls = (await screen.findByLabelText('Automated call in Urdu')) as HTMLSelectElement;
    expect(calls.value).toBe('OFF');
    fireEvent.change(calls, { target: { value: 'HIGH_VALUE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save order policies' }));
    expect(await screen.findByText('Saved. Orders from now on follow these.')).toBeTruthy();
    expect(sentOf(fake, 'OrderSettingsUpdate')).toEqual([
      { input: { confirmationCalls: 'HIGH_VALUE' } },
    ]);
    expect((screen.getByLabelText('Automated call in Urdu') as HTMLSelectElement).value).toBe(
      'HIGH_VALUE',
    );
  });

  it('limits what staff take off an order, and takes the limit away (ADR-651)', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/orders');

    const most = (await screen.findByLabelText(
      'Most staff take off an order, in %',
    )) as HTMLInputElement;
    expect(most.value).toBe('');
    type('Most staff take off an order, in %', '10');
    fireEvent.click(screen.getByRole('button', { name: 'Save order policies' }));
    expect(await screen.findByText('Saved. Orders from now on follow these.')).toBeTruthy();
    type('Most staff take off an order, in %', '');
    fireEvent.click(screen.getByRole('button', { name: 'Save order policies' }));
    await waitFor(() => expect(sentOf(fake, 'OrderSettingsUpdate')).toHaveLength(2));
    expect(sentOf(fake, 'OrderSettingsUpdate')).toEqual([
      { input: { staffDiscountPercent: 10 } },
      { input: { staffDiscountPercent: null } },
    ]);
  });

  it('changes high value and the score that holds an order, and refuses what is not a number', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/orders');

    expect(((await screen.findByLabelText('High value from (Rs)')) as HTMLInputElement).value).toBe(
      '15000',
    );
    expect(
      (screen.getByLabelText('Hold for review at a score of (%)') as HTMLInputElement).value,
    ).toBe('60');
    type('First call within (minutes)', 'soon');
    fireEvent.click(screen.getByRole('button', { name: 'Save order policies' }));
    expect(
      await screen.findByText('First call within (minutes): give a whole number'),
    ).toBeTruthy();
    expect(fake.sent.some((each) => each.operation.endsWith('Update'))).toBe(false);

    type('First call within (minutes)', '30');
    type('High value from (Rs)', '20,000');
    type('Hold for review at a score of (%)', '');
    fireEvent.click(screen.getByRole('button', { name: 'Save order policies' }));
    await waitFor(() =>
      expect(sentOf(fake, 'OrderRiskSettingsUpdate')).toEqual([
        { input: { highValue: '20,000', holdAt: null } },
      ]),
    );
    expect(sentOf(fake, 'OrderSettingsUpdate')).toEqual([]);
    expect(await screen.findByText(/Now Rs 20,000\./)).toBeTruthy();
  });
});
