import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const SETTINGS = {
  routing: 'RICH',
  language: 'UR',
  disabledNotifications: ['STOCK_OUT'],
  alertsPhone: null,
  replyToEmail: null,
  replyTargetMinutes: null,
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
  {
    // A code to sign in on the storefront (ADR-570), which belongs to no order.
    id: 'msg_3',
    kind: 'ACCOUNT_CODE',
    channel: 'WHATSAPP',
    status: 'SENT',
    recipient: '+92333*****89',
    orderId: null,
    error: null,
    attempts: 1,
    createdAt: '2026-10-06T09:00:00Z',
    sentAt: '2026-10-06T09:00:02Z',
    deliveredAt: null,
    readAt: null,
  },
];

/** Requests for the shop's own SMS sender name, the newest first (ADR-469). */
type Request = { id: string; name: string; status: string; answer: string | null };

function core(role: StaffRole, requests: Request[] = []) {
  let settings: Record<string, unknown> = SETTINGS;
  const kept = [...requests];
  const at = { createdAt: '2026-10-08T09:00:00Z', decidedAt: null };
  let webChat = {
    enabled: false,
    greeting: null as string | null,
    updatedAt: null as string | null,
  };
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'WebChatSettings':
        return { webChatSettings: webChat };
      case 'WebChatSettingsUpdate': {
        const input = variables.input as { enabled: boolean; greeting: string | null };
        webChat = { ...input, updatedAt: '2026-10-27T09:00:00Z' };
        return { webChatSettingsUpdate: { webChatSettings: webChat, userErrors: [] } };
      }
      case 'SmsSender':
        return {
          smsSender: {
            name: kept.find((request) => request.status === 'APPROVED')?.name ?? null,
            requests: kept.map((request) => ({ ...at, ...request })),
          },
        };
      case 'SmsSenderRequest': {
        const name = String(variables.name).trim();
        kept.unshift({ id: `snd_${kept.length + 1}`, name, status: 'WAITING', answer: null });
        return {
          smsSenderRequest: { request: { id: kept[0]!.id, status: 'WAITING' }, userErrors: [] },
        };
      }
      case 'SmsSenderWithdraw': {
        const waiting = kept.find((request) => request.status === 'WAITING')!;
        waiting.status = 'WITHDRAWN';
        return {
          smsSenderWithdraw: { request: { id: waiting.id, status: 'WITHDRAWN' }, userErrors: [] },
        };
      }
      case 'MessagingSettings':
        return { messagingSettings: settings, billingMessagePrices: PRICES };
      case 'MessagingSettingsUpdate': {
        const input = variables.input as Record<string, unknown>;
        if (input.replyToEmail === 'help@zari') {
          return {
            messagingSettingsUpdate: {
              messagingSettings: null,
              userErrors: [
                {
                  field: ['input', 'replyToEmail'],
                  code: 'INVALID',
                  message: 'must be an email address, like name@example.com',
                },
              ],
            },
          };
        }
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
    // The summary of the day before, each morning (ADR-386): on unless turned off.
    expect((screen.getByLabelText(/^Yesterday's summary/) as HTMLInputElement).checked).toBe(true);
    expect(
      screen.getByText(/^To the alerts number each morning: the day before's orders/),
    ).toBeTruthy();
    expect(screen.getByText(/^Codes customers prove their number with/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/^SMS for updates/));
    fireEvent.click(screen.getByLabelText(/^Order shipped/));
    fireEvent.click(screen.getByLabelText(/^Out of stock/));
    fireEvent.click(screen.getByLabelText(/^Yesterday's summary/));
    type('Alerts number', '12345');
    fireEvent.click(screen.getByRole('button', { name: 'Save messages' }));
    expect(await screen.findByText('Alerts number: must be a Pakistani mobile')).toBeTruthy();

    type('Alerts number', '0300 1234567');
    fireEvent.click(screen.getByRole('button', { name: 'Save messages' }));
    expect(await screen.findByText('Saved. Messages from now on go like this.')).toBeTruthy();
    expect(sentOf(fake, 'MessagingSettingsUpdate').at(-1)).toEqual({
      input: {
        routing: 'ECONOMY',
        disabledNotifications: ['DAILY_SUMMARY', 'ORDER_SHIPPED'],
        alertsPhone: '0300 1234567',
      },
    });
    expect((screen.getByLabelText('Alerts number') as HTMLInputElement).value).toBe('0300 1234567');
  });

  it("sends replies to the shop's emails where it says, blank for none (ADR-659)", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/messages');

    const field = (await screen.findByLabelText('Replies to emails go to')) as HTMLInputElement;
    expect(field.value).toBe('');
    expect(
      screen.getByText(/leave it blank and the emails say replies aren't read\.$/),
    ).toBeTruthy();
    type('Replies to emails go to', 'help@zari');
    fireEvent.click(screen.getByRole('button', { name: 'Save messages' }));
    expect(
      await screen.findByText(
        'Replies to emails go to: must be an email address, like name@example.com',
      ),
    ).toBeTruthy();

    type('Replies to emails go to', ' help@zari.pk ');
    fireEvent.click(screen.getByRole('button', { name: 'Save messages' }));
    expect(await screen.findByText('Saved. Messages from now on go like this.')).toBeTruthy();
    // Alone of what changed.
    expect(sentOf(fake, 'MessagingSettingsUpdate').at(-1)).toEqual({
      input: { replyToEmail: 'help@zari.pk' },
    });

    type('Replies to emails go to', '');
    fireEvent.click(screen.getByRole('button', { name: 'Save messages' }));
    await waitFor(() =>
      expect(sentOf(fake, 'MessagingSettingsUpdate').at(-1)).toEqual({
        input: { replyToEmail: null },
      }),
    );
  });

  it('keeps the minutes in which the shop answers the inbox, blank for none (ADR-760)', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/messages');

    const label = 'Answer the inbox within (minutes)';
    expect(((await screen.findByLabelText(label)) as HTMLInputElement).value).toBe('');
    // Past a day, the browser's own check keeps it from being sent.
    type(label, '2000');
    fireEvent.click(screen.getByRole('button', { name: 'Save messages' }));
    expect(sentOf(fake, 'MessagingSettingsUpdate')).toEqual([]);
    type(label, '30');
    fireEvent.click(screen.getByRole('button', { name: 'Save messages' }));
    expect(await screen.findByText('Saved. Messages from now on go like this.')).toBeTruthy();
    expect(sentOf(fake, 'MessagingSettingsUpdate').at(-1)).toEqual({
      input: { replyTargetMinutes: 30 },
    });
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('30');

    type(label, '');
    fireEvent.click(screen.getByRole('button', { name: 'Save messages' }));
    await waitFor(() =>
      expect(sentOf(fake, 'MessagingSettingsUpdate').at(-1)).toEqual({
        input: { replyTargetMinutes: null },
      }),
    );
  });

  it("asks for the shop's own SMS sender name, checked as typed, and withdraws it (ADR-469)", async () => {
    const fake = core('owner', [
      { id: 'snd_1', name: 'ZARI PK', status: 'REFUSED', answer: 'Jazz refused it' },
    ]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/messages');

    const card = await screen.findByRole('region', { name: 'SMS sender name' });
    expect(await within(card).findByText('Your SMS come from Hatti’s shared name.')).toBeTruthy();
    expect(
      within(card).getByText('Hatti could not register ZARI PK: Jazz refused it'),
    ).toBeTruthy();
    const ask = within(card).getByRole('button', { name: 'Ask Hatti' }) as HTMLButtonElement;
    type('Name to send from', 'Zari!');
    expect(
      within(card).getByText('Use 3 to 11 English letters, digits and spaces, with a letter.'),
    ).toBeTruthy();
    expect(ask.disabled).toBe(true);
    type('Name to send from', ' ZARI ');
    fireEvent.click(ask);
    expect(await within(card).findByText(/^Hatti is registering ZARI, asked for on/)).toBeTruthy();
    expect(sentOf(fake, 'SmsSenderRequest')).toEqual([{ name: ' ZARI ' }]);
    expect(within(card).queryByRole('button', { name: 'Ask Hatti' })).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw' }));
    expect(await within(card).findByRole('button', { name: 'Ask Hatti' })).toBeTruthy();
    expect(sentOf(fake, 'SmsSenderWithdraw')).toHaveLength(1);
  });

  it("shows marketers the name the shop's SMS go from, the form the owner's and managers'", async () => {
    const fake = core('marketer', [
      { id: 'snd_1', name: 'ZARI', status: 'APPROVED', answer: null },
    ]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/messages');

    const card = await screen.findByRole('region', { name: 'SMS sender name' });
    expect(await within(card).findByText('Your SMS come from ZARI.')).toBeTruthy();
    expect(
      within(card).getByText('The shop’s owner and managers ask for a name of its own.'),
    ).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Ask Hatti' })).toBeNull();
  });

  it('turns the chat on the online store on with a greeting of its own (ADR-812)', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/messages');

    const card = await screen.findByRole('region', { name: 'Chat on your online store' });
    const on = (await within(card).findByLabelText(
      'Offer the chat on your online store',
    )) as HTMLInputElement;
    expect(on.checked).toBe(false);
    const save = within(card).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(on);
    fireEvent.change(within(card).getByLabelText('What the chat says first (optional)'), {
      target: { value: ' Ask us about sizes! ' },
    });
    fireEvent.click(save);
    expect(await within(card).findByText('Saved.')).toBeTruthy();
    expect(sentOf(fake, 'WebChatSettingsUpdate')).toEqual([
      { input: { enabled: true, greeting: 'Ask us about sizes!' } },
    ]);
  });

  it('lists the messages sent, by status, with their orders and why one failed', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/messages');

    const sent = await screen.findByRole('region', { name: 'Messages sent' });
    expect(await within(sent).findByText('Confirm your order')).toBeTruthy();
    expect(within(sent).getByText('Sign-in code')).toBeTruthy();
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
