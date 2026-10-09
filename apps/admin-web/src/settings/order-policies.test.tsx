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
