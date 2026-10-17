import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import {
  confirmIdentity,
  fakeCore,
  LATER,
  REAUTHENTICATE,
  renderAdmin,
  signedIn,
  type,
} from '../test-support';

const CONNECTED = {
  measurementId: 'G-4B7XK2M9QZ',
  apiSecretHint: 'Qx42',
  purchaseAt: 'CONFIRMED',
  updatedAt: '2026-10-01T10:00:00Z',
};

const EVENTS = [
  {
    id: 'cev_1',
    platform: 'GOOGLE',
    orderId: 'order_1',
    moment: 'CONFIRMED',
    eventName: 'purchase',
    status: 'SENT',
    attempts: 1,
    error: null,
    traceId: null,
    occurredAt: '2026-10-08T09:00:00Z',
    sentAt: '2026-10-08T09:00:15Z',
  },
  {
    id: 'cev_2',
    platform: 'GOOGLE',
    orderId: 'order_2',
    moment: 'PLACED',
    eventName: 'order_placed',
    status: 'EXPIRED',
    attempts: 4,
    error: 'Google 503: Service Unavailable',
    traceId: null,
    occurredAt: '2026-10-03T09:00:00Z',
    sentAt: null,
  },
];

function core(role: StaffRole, connected: typeof CONNECTED | null = null) {
  let stream: Record<string, unknown> | null = connected;
  let confirmed = false;
  return fakeCore(
    role,
    (operation, variables) => {
      switch (operation) {
        case 'GoogleAnalytics':
          return { googleAnalytics: stream };
        case 'GoogleAnalyticsUpdate': {
          if (!confirmed) return REAUTHENTICATE;
          const input = variables.input as Record<string, unknown>;
          if (input.measurementId === 'UA-12345-1') {
            return {
              googleAnalyticsUpdate: {
                googleAnalytics: null,
                userErrors: [
                  {
                    field: ['input', 'measurementId'],
                    code: 'INVALID',
                    message:
                      'must be the web stream\'s measurement ID, as "G-" and 4 to 20 letters and digits',
                  },
                ],
              },
            };
          }
          const { apiSecret, ...kept } = input;
          stream = {
            purchaseAt: 'PLACED',
            ...stream,
            ...kept,
            apiSecretHint: apiSecret ? String(apiSecret).slice(-4) : stream?.apiSecretHint,
            updatedAt: new Date().toISOString(),
          };
          return { googleAnalyticsUpdate: { googleAnalytics: stream, userErrors: [] } };
        }
        case 'GoogleAnalyticsDelete':
          stream = null;
          return {
            googleAnalyticsDelete: {
              deletedMeasurementId: CONNECTED.measurementId,
              userErrors: [],
            },
          };
        case 'ConversionEvents':
          return {
            conversionEvents: {
              nodes: variables.status
                ? EVENTS.filter((each) => each.status === variables.status)
                : EVENTS,
              pageInfo: { hasNextPage: false },
            },
          };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    },
    (path) => {
      if (path === '/auth/reauthenticate/options') {
        return { methods: ['password'], passkeyOptions: null, googleOptions: null, phone: null };
      }
      if (path === '/auth/reauthenticate') {
        confirmed = true;
        return { authenticatedAt: LATER, sensitiveActionsUntil: LATER };
      }
      return {};
    },
  );
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Google Analytics (ADR-550)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('connects the web stream with its measurement ID and a secret once the member confirms who they are', async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=google');

    expect(await screen.findByText('Not connected.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sent to Google' })).toBeNull();
    type('Measurement ID', 'UA-12345-1');
    type('API secret', 'aB3dE5gH7jK9mN1pQx42');
    fireEvent.change(screen.getByLabelText('Tell Google of a purchase'), {
      target: { value: 'DELIVERED' },
    });
    expect(screen.getByText(/They reach Google days after the order\.$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText(
        'Measurement ID: must be the web stream\'s measurement ID, as "G-" and 4 to 20 letters and digits',
      ),
    ).toBeTruthy();

    type('Measurement ID', 'G-4B7XK2M9QZ');
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    expect(await screen.findByText(/^Connected to web stream G-4B7XK2M9QZ\./)).toBeTruthy();
    expect(sentOf(fake, 'GoogleAnalyticsUpdate').at(-1)).toEqual({
      input: {
        measurementId: 'G-4B7XK2M9QZ',
        apiSecret: 'aB3dE5gH7jK9mN1pQx42',
        purchaseAt: 'DELIVERED',
      },
    });
    expect(
      screen.getByText('Saved. Orders placed from now on go to Google like this.'),
    ).toBeTruthy();
    expect(screen.getByText('Leave it blank to keep the one ending Qx42.')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Sent to Google' })).toBeTruthy();
  });

  it("lists Google's moments alone, and sends only what changed", async () => {
    const fake = core('owner', CONNECTED);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=google');

    const sent = await screen.findByRole('list');
    expect(within(sent).getByText('Google 503: Service Unavailable')).toBeTruthy();
    expect(within(sent).queryByText(/request_id|fbtrace_id/)).toBeNull();
    expect(sentOf(fake, 'ConversionEvents')).toEqual([{ status: null, platform: 'GOOGLE' }]);
    expect(
      screen.getByText(/import purchase from Google Analytics as a conversion\.$/),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Tell Google of a purchase'), {
      target: { value: 'PLACED' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText('Saved. Orders placed from now on go to Google like this.'),
    ).toBeTruthy();
    expect(sentOf(fake, 'GoogleAnalyticsUpdate').at(-1)).toEqual({
      input: { purchaseAt: 'PLACED' },
    });
  });

  it('disconnects Google once asked whether they mean it', async () => {
    const fake = core('manager', CONNECTED);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=google');

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Google' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it connected' }));
    expect(sentOf(fake, 'GoogleAnalyticsDelete')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google' }));
    expect(screen.getByText(/^Disconnect web stream G-4B7XK2M9QZ\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Not connected.')).toBeTruthy();
    expect(sentOf(fake, 'GoogleAnalyticsDelete')).toEqual([{}]);
  });
});
