import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, REAUTHENTICATE, renderAdmin, signedIn, type } from '../test-support';

const FEED = 'https://zari.hatti.pk/feeds/products.xml';

const CONNECTED = {
  pixelId: '1234567890123456',
  accessTokenHint: 'x9Qz',
  purchaseAt: 'DELIVERED',
  testEventCode: null,
  updatedAt: '2026-10-01T10:00:00Z',
};

const EVENTS = [
  {
    id: 'cev_1',
    orderId: 'order_1',
    moment: 'DELIVERED',
    eventName: 'Purchase',
    status: 'SENT',
    attempts: 1,
    error: null,
    traceId: 'AbC123',
    occurredAt: '2026-10-08T09:00:00Z',
    sentAt: '2026-10-08T09:00:15Z',
  },
  {
    id: 'cev_2',
    orderId: 'order_2',
    moment: 'PLACED',
    eventName: null,
    status: 'FAILED',
    attempts: 3,
    error: 'Invalid parameter',
    traceId: null,
    occurredAt: '2026-10-07T09:00:00Z',
    sentAt: null,
  },
];

function core(role: StaffRole, connected: typeof CONNECTED | null = null) {
  let meta: Record<string, unknown> | null = connected;
  let confirmed = false;
  return fakeCore(
    role,
    (operation, variables) => {
      switch (operation) {
        case 'MetaConversions':
          return { metaConversions: meta, shop: { id: 'shop_1', productFeedUrl: FEED } };
        case 'MetaConversionsUpdate': {
          if (!confirmed) return REAUTHENTICATE;
          const input = variables.input as Record<string, unknown>;
          if (input.pixelId === '12') {
            return {
              metaConversionsUpdate: {
                metaConversions: null,
                userErrors: [
                  {
                    field: ['input', 'pixelId'],
                    code: 'INVALID',
                    message: 'Pixel ID must be 15 or 16 digits',
                  },
                ],
              },
            };
          }
          const { accessToken, ...kept } = input;
          meta = {
            pixelId: '',
            purchaseAt: 'PLACED',
            testEventCode: null,
            ...meta,
            ...kept,
            accessTokenHint: accessToken
              ? String(accessToken).slice(-4)
              : (meta?.accessTokenHint ?? ''),
            updatedAt: new Date().toISOString(),
          };
          return { metaConversionsUpdate: { metaConversions: meta, userErrors: [] } };
        }
        case 'MetaConversionsDelete':
          meta = null;
          return {
            metaConversionsDelete: { deletedPixelId: CONNECTED.pixelId, userErrors: [] },
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

describe('Meta and the catalog feed', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the catalog feed and connects Meta once the member confirms who they are', async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=meta');

    expect(await screen.findByText(FEED)).toBeTruthy();
    expect(screen.getByText('Not connected.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sent to Meta' })).toBeNull();

    type('Dataset ID', '12');
    type('Access token', 'EAAB-token-abcd');
    fireEvent.change(screen.getByLabelText('Tell Meta of a purchase'), {
      target: { value: 'DELIVERED' },
    });
    expect(screen.getByText(/^Only the parcels customers took count as purchases/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Meta' }));
    await screen.findByText('Confirm it is you');
    type('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Dataset ID: Pixel ID must be 15 or 16 digits')).toBeTruthy();

    type('Dataset ID', '1234567890123456');
    fireEvent.click(screen.getByRole('button', { name: 'Connect Meta' }));
    expect(await screen.findByText('Connected to dataset 1234567890123456.')).toBeTruthy();
    expect(sentOf(fake, 'MetaConversionsUpdate').at(-1)).toEqual({
      input: {
        pixelId: '1234567890123456',
        accessToken: 'EAAB-token-abcd',
        purchaseAt: 'DELIVERED',
      },
    });
    expect(screen.getByText('Leave it blank to keep the one ending abcd.')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Sent to Meta' })).toBeTruthy();
  });

  it('changes only what changed, keeps the token, and lists the moments sent by status', async () => {
    const fake = core('owner', CONNECTED);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=meta');

    expect(await screen.findByText('Connected to dataset 1234567890123456.')).toBeTruthy();
    const sent = await screen.findByRole('list');
    expect(within(sent).getByText('Tried 3 times')).toBeTruthy();
    expect(within(sent).getByText('Invalid parameter')).toBeTruthy();
    expect(within(sent).getAllByRole('link', { name: 'Its order' })[0]?.getAttribute('href')).toBe(
      '/shop_1/orders/order_1',
    );

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'FAILED' } });
    await waitFor(() => expect(screen.queryByText('fbtrace_id AbC123')).toBeNull());
    expect(sentOf(fake, 'ConversionEvents')).toEqual([{ status: null }, { status: 'FAILED' }]);

    type('Test event code', 'TEST4821');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Confirm it is you');
    type('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText(/Test events show in Events Manager under code TEST4821\./),
    ).toBeTruthy();
    expect(sentOf(fake, 'MetaConversionsUpdate')).toEqual([
      { input: { testEventCode: 'TEST4821' } },
      { input: { testEventCode: 'TEST4821' } },
    ]);
  });

  it('disconnects Meta once asked whether they mean it', async () => {
    const fake = core('manager', CONNECTED);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=meta');

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Meta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it connected' }));
    expect(sentOf(fake, 'MetaConversionsDelete')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Meta' }));
    expect(screen.getByText(/^Disconnect dataset 1234567890123456\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Not connected.')).toBeTruthy();
    expect(sentOf(fake, 'MetaConversionsDelete')).toEqual([{}]);
  });

  it('is not there for an accountant', async () => {
    const fake = core('accountant');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=meta');
    expect((await screen.findAllByRole('link', { name: /Orders/ })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /Online store/ })).toBeNull();
    expect(screen.queryByText(FEED)).toBeNull();
    expect(sentOf(fake, 'MetaConversions')).toEqual([]);
  });
});
