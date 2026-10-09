import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const SETTINGS = {
  routing: 'RICH',
  language: 'UR',
  disabledNotifications: ['STOCK_OUT'],
  alertsPhone: null,
  updatedAt: null,
};

const PRICES = [
  { category: 'UTILITY', channel: 'WHATSAPP', price: { amount: '4.20', currencyCode: 'PKR' } },
  { category: 'UTILITY', channel: 'SMS', price: { amount: '1.50', currencyCode: 'PKR' } },
  { category: 'MARKETING', channel: 'WHATSAPP', price: { amount: '13.25', currencyCode: 'PKR' } },
];

const MESSAGES = [
  {
    id: 'msg_1',
    kind: 'ORDER_CONFIRMATION',
    channel: 'WHATSAPP',
    status: 'READ',
    recipient: '+92300*****67',
    orderId: 'order_1',
    error: null,
    attempts: 1,
    createdAt: '2026-10-08T09:00:00Z',
    sentAt: '2026-10-08T09:00:05Z',
    deliveredAt: '2026-10-08T09:00:09Z',
    readAt: '2026-10-08T09:02:00Z',
  },
  {
    id: 'msg_2',
    kind: 'ORDER_SHIPPED',
    channel: 'SMS',
    status: 'FAILED',
    recipient: '+92321*****45',
    orderId: 'order_2',
    error: 'Number unreachable',
    attempts: 3,
    createdAt: '2026-10-07T09:00:00Z',
    sentAt: null,
    deliveredAt: null,
    readAt: null,
  },
];

function core(role: StaffRole) {
  let settings: Record<string, unknown> = SETTINGS;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'MessagingSettings':
        return { messagingSettings: settings, billingMessagePrices: PRICES };
      case 'MessagingSettingsUpdate': {
        const input = variables.input as Record<string, unknown>;
        if (input.alertsPhone === '12345') {
          return {
            messagingSettingsUpdate: {
              messagingSettings: null,
              userErrors: [
                {
                  field: ['input', 'alertsPhone'],
                  code: 'INVALID',
                  message: 'must be a Pakistani mobile',
                },
              ],
            },
          };
        }
        settings = {
          ...settings,
          ...input,
          ...(typeof input.alertsPhone === 'string' && { alertsPhone: '+923001234567' }),
          updatedAt: new Date().toISOString(),
        };
        return { messagingSettingsUpdate: { messagingSettings: settings, userErrors: [] } };
      }
      case 'Messages':
        return {
          messages: {
            nodes: MESSAGES.filter(
              (each) =>
                (!variables.status || each.status === variables.status) &&
                (!variables.orderId || each.orderId === variables.orderId),
            ),
            pageInfo: { hasNextPage: false },
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Customer messages', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('changes how they go, which go, and the alerts number, sending what changed', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Customer messages/ }));
    expect(await screen.findByText(/^Every message on WhatsApp, Rs 4\.20 each/)).toBeTruthy();
    expect(
      screen.getByText(/^Updates that need no answer go by SMS, Rs 1\.50 a part\./),
    ).toBeTruthy();
    expect((screen.getByLabelText(/^Out of stock/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/^Order shipped/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/^Codes customers prove their number with/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/^SMS for updates/));
    fireEvent.click(screen.getByLabelText(/^Order shipped/));
    fireEvent.click(screen.getByLabelText(/^Out of stock/));
    type('Alerts number', '12345');
    fireEvent.click(screen.getByRole('button', { name: 'Save messages' }));
    expect(await screen.findByText('Alerts number: must be a Pakistani mobile')).toBeTruthy();

    type('Alerts number', '0300 1234567');
    fireEvent.click(screen.getByRole('button', { name: 'Save messages' }));
    expect(await screen.findByText('Saved. Messages from now on go like this.')).toBeTruthy();
    expect(sentOf(fake, 'MessagingSettingsUpdate').at(-1)).toEqual({
      input: {
        routing: 'ECONOMY',
        disabledNotifications: ['ORDER_SHIPPED'],
        alertsPhone: '0300 1234567',
      },
    });
    expect((screen.getByLabelText('Alerts number') as HTMLInputElement).value).toBe('0300 1234567');
  });

  it('lists the messages sent, by status, with their orders and why one failed', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/messages');

    const sent = await screen.findByRole('region', { name: 'Messages sent' });
    expect(await within(sent).findByText('Confirm your order')).toBeTruthy();
    expect(within(sent).getByText('Read', { selector: 'span' })).toBeTruthy();
    expect(within(sent).getByText('Number unreachable')).toBeTruthy();
    expect(within(sent).getByText('Tried 3 times')).toBeTruthy();
    expect(within(sent).getAllByRole('link', { name: 'Its order' })[1]?.getAttribute('href')).toBe(
      '/shop_1/orders/order_2',
    );

    fireEvent.change(within(sent).getByLabelText('Show'), { target: { value: 'FAILED' } });
    await waitFor(() => expect(within(sent).queryByText('Confirm your order')).toBeNull());
    expect(sentOf(fake, 'Messages')).toEqual([
      { orderId: null, status: null },
      { orderId: null, status: 'FAILED' },
    ]);
  });
});
