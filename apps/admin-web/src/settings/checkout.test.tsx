import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

function core(role: StaffRole, whatsappNumber: string | null) {
  let badges: unknown[] = [{ kind: 'CASH_ON_DELIVERY', days: null }];
  let channels = ['WHATSAPP'];
  let reminderAfterMinutes: number | null = null;
  let gifts: { wrap: unknown; messages: boolean } = {
    wrap: {
      variantId: 'var_9',
      productTitle: 'Gift wrap',
      variantTitle: 'Default Title',
      price: { amount: '150.00', currencyCode: 'PKR' },
      forSale: false,
    },
    messages: false,
  };
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'CheckoutPage':
        return {
          checkoutTrustBadges: badges,
          checkoutMarketingChannels: channels,
          onlineStorePreferences: { whatsappNumber },
          checkoutRecoverySettings: { reminderAfterMinutes },
          checkoutGiftOptions: gifts,
        };
      case 'DraftVariants':
        return {
          products: {
            nodes: [
              {
                id: 'prod_2',
                title: 'Gift box',
                variants: [
                  {
                    id: 'var_5',
                    title: 'Red',
                    availableForSale: true,
                    inventoryQuantity: 40,
                    price: { amount: '250.00', currencyCode: 'PKR' },
                  },
                ],
              },
            ],
          },
        };
      case 'CheckoutGiftOptionsUpdate': {
        const input = variables.input as { wrapVariantId: string | null; messages: boolean };
        gifts = {
          wrap: input.wrapVariantId && {
            variantId: input.wrapVariantId,
            productTitle: 'Gift box',
            variantTitle: 'Default Title',
            price: { amount: '250.00', currencyCode: 'PKR' },
            forSale: true,
          },
          messages: input.messages,
        };
        return { checkoutGiftOptionsUpdate: { checkoutGiftOptions: gifts, userErrors: [] } };
      }
      case 'CheckoutRecoverySettingsUpdate':
        reminderAfterMinutes = variables.reminderAfterMinutes as number | null;
        return {
          checkoutRecoverySettingsUpdate: {
            checkoutRecoverySettings: { reminderAfterMinutes },
            userErrors: [],
          },
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

  it('sells another gift wrap, or none, and asks for a gift message (ADR-414)', async () => {
    const fake = core('manager', null);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/checkout');

    const gifts = await screen.findByRole('region', { name: 'Gifts' });
    expect(within(gifts).getByText('Gift wrap')).toBeTruthy();
    expect(within(gifts).getByText(/^Not for sale/)).toBeTruthy();
    fireEvent.click(within(gifts).getByRole('button', { name: 'Choose another' }));
    type('Find products by name or SKU', 'gift');
    fireEvent.click(within(gifts).getByRole('button', { name: 'Find' }));
    fireEvent.click(await within(gifts).findByRole('button', { name: 'Add Gift box' }));
    expect(within(gifts).getByText('Gift box')).toBeTruthy();
    fireEvent.click(within(gifts).getByLabelText(/Ask for a gift message/));
    fireEvent.click(screen.getByRole('button', { name: 'Save checkout page' }));
    expect(await screen.findByText('Saved. The checkout shows it in a moment.')).toBeTruthy();
    expect(sentOf(fake, 'CheckoutGiftOptionsUpdate')).toEqual([
      { input: { wrapVariantId: 'var_5', messages: true } },
    ]);
    expect(sentOf(fake, 'CheckoutTrustBadgesUpdate')).toEqual([]);

    fireEvent.click(within(gifts).getByRole('button', { name: 'No gift wrap' }));
    expect(within(gifts).getByRole('button', { name: 'Choose gift wrap' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save checkout page' }));
    await waitFor(() =>
      expect(sentOf(fake, 'CheckoutGiftOptionsUpdate')).toEqual([
        { input: { wrapVariantId: 'var_5', messages: true } },
        { input: { wrapVariantId: null, messages: true } },
      ]),
    );
  });

  it('reminds shoppers who leave after the delay chosen, or never (ADR-393)', async () => {
    const fake = core('manager', null);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/checkout');

    const when = await screen.findByLabelText('Remind them');
    expect((when as HTMLSelectElement).value).toBe('');
    expect(screen.getByText(/paid from your message credit/)).toBeTruthy();
    fireEvent.change(when, { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save checkout page' }));
    expect(await screen.findByText('Saved. The checkout shows it in a moment.')).toBeTruthy();
    expect(sentOf(fake, 'CheckoutRecoverySettingsUpdate')).toEqual([{ reminderAfterMinutes: 60 }]);
    // Only what changed is sent.
    expect(sentOf(fake, 'CheckoutTrustBadgesUpdate')).toEqual([]);

    fireEvent.change(screen.getByLabelText('Remind them'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save checkout page' }));
    await waitFor(() =>
      expect(sentOf(fake, 'CheckoutRecoverySettingsUpdate')).toEqual([
        { reminderAfterMinutes: 60 },
        { reminderAfterMinutes: null },
      ]),
    );
  });
});
