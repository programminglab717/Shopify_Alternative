import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

function core(role: StaffRole, whatsappNumber: string | null) {
  let badges: unknown[] = [{ kind: 'CASH_ON_DELIVERY', days: null }];
  let channels = ['WHATSAPP'];
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'CheckoutPage':
        return {
          checkoutTrustBadges: badges,
          checkoutMarketingChannels: channels,
          onlineStorePreferences: { whatsappNumber },
        };
      case 'CheckoutTrustBadgesUpdate':
        badges = (variables.badges as { kind: string; days?: number }[]).map((badge) => ({
          kind: badge.kind,
          days: badge.days ?? null,
        }));
        return { checkoutTrustBadgesUpdate: { checkoutTrustBadges: badges, userErrors: [] } };
      case 'CheckoutMarketingChannelsUpdate':
        channels = variables.channels as string[];
        return {
          checkoutMarketingChannelsUpdate: { checkoutMarketingChannels: channels, userErrors: [] },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('The checkout page', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('adds badges, sets their days and order, and changes the boxes, sending what changed', async () => {
    const fake = core('owner', '+923001234567');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Checkout page/ }));
    await screen.findByRole('heading', { name: 'Checkout page' });
    expect(await screen.findByText('Cash on delivery')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add a badge'), { target: { value: 'EXCHANGE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    type('Days for 7-day exchange', '0');
    fireEvent.change(screen.getByLabelText('Add a badge'), { target: { value: 'WHATSAPP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Help on WhatsApp up' }));
    fireEvent.click(screen.getByLabelText('Offers by SMS'));

    fireEvent.click(screen.getByRole('button', { name: 'Save checkout page' }));
    expect(await screen.findByText('0-day exchange: give days from 1 to 90')).toBeTruthy();
    type('Days for 0-day exchange', '14');
    fireEvent.click(screen.getByRole('button', { name: 'Save checkout page' }));
    expect(await screen.findByText('Saved. The checkout shows it in a moment.')).toBeTruthy();
    expect(sentOf(fake, 'CheckoutTrustBadgesUpdate')).toEqual([
      {
        badges: [
          { kind: 'CASH_ON_DELIVERY' },
          { kind: 'WHATSAPP' },
          { kind: 'EXCHANGE', days: 14 },
        ],
      },
    ]);
    expect(sentOf(fake, 'CheckoutMarketingChannelsUpdate')).toEqual([
      { channels: ['WHATSAPP', 'SMS'] },
    ]);
    expect(screen.getByText('14-day exchange')).toBeTruthy();
  });

  it('offers Help on WhatsApp only with a WhatsApp number, and removes a badge alone', async () => {
    const fake = core('manager', null);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/checkout');

    const add = (await screen.findByLabelText('Add a badge')) as HTMLSelectElement;
    expect([...add.options].map((each) => each.value)).not.toContain('WHATSAPP');
    expect(screen.getByText(/^Help on WhatsApp needs your WhatsApp number/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cash on delivery' }));
    expect(screen.getByText('No badges: the checkout shows none.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save checkout page' }));
    await waitFor(() =>
      expect(sentOf(fake, 'CheckoutTrustBadgesUpdate')).toEqual([{ badges: [] }]),
    );
    expect(sentOf(fake, 'CheckoutMarketingChannelsUpdate')).toEqual([]);
  });
});
