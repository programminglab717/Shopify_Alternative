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
  pixelCode: 'CABC123DEF456GHI789J',
  accessTokenHint: 'Tk42',
  purchaseAt: 'CONFIRMED',
  testEventCode: null,
  updatedAt: '2026-10-01T10:00:00Z',
};

const EVENTS = [
  {
    id: 'cev_1',
    platform: 'TIKTOK',
    orderId: 'order_1',
    moment: 'CONFIRMED',
    eventName: 'CompletePayment',
    status: 'SENT',
    attempts: 1,
    error: null,
    traceId: 'req-77',
    occurredAt: '2026-10-08T09:00:00Z',
    sentAt: '2026-10-08T09:00:15Z',
  },
  {
    id: 'cev_2',
    platform: 'TIKTOK',
    orderId: 'order_2',
    moment: 'PLACED',
    eventName: 'PlaceAnOrder',
    status: 'FAILED',
    attempts: 2,
    error: 'TikTok 40002: Invalid event_source_id',
    traceId: null,
    occurredAt: '2026-10-07T09:00:00Z',
    sentAt: null,
  },
];

function core(role: StaffRole, connected: typeof CONNECTED | null = null) {
  let pixel: Record<string, unknown> | null = connected;
  let confirmed = false;
  return fakeCore(
    role,
    (operation, variables) => {
      switch (operation) {
        case 'TikTokEvents':
          return { tiktokEvents: pixel };
        case 'TikTokEventsUpdate': {
          if (!confirmed) return REAUTHENTICATE;
          const input = variables.input as Record<string, unknown>;
          if (input.pixelCode === 'pixel-1') {
            return {
              tiktokEventsUpdate: {
                tiktokEvents: null,
                userErrors: [
                  {
                    field: ['input', 'pixelCode'],
                    code: 'INVALID',
                    message: "must be the pixel's code: 10 to 40 letters and digits",
                  },
                ],
              },
            };
          }
          const { accessToken, ...kept } = input;
          pixel = {
            purchaseAt: 'PLACED',
            testEventCode: null,
            ...pixel,
            ...kept,
            accessTokenHint: accessToken ? String(accessToken).slice(-4) : pixel?.accessTokenHint,
            updatedAt: new Date().toISOString(),
          };
          return { tiktokEventsUpdate: { tiktokEvents: pixel, userErrors: [] } };
        }
        case 'TikTokEventsDelete':
          pixel = null;
          return {
            tiktokEventsDelete: { deletedPixelCode: CONNECTED.pixelCode, userErrors: [] },
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

describe("TikTok's Events API", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('connects the pixel with its code and a token once the member confirms who they are', async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=tiktok');

    expect(await screen.findByText('Not connected.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sent to TikTok' })).toBeNull();
    type('Pixel code', 'pixel-1');
    type('Access token', 'a1b2c3d4e5f6a7b8c9d0Tk42');
    fireEvent.change(screen.getByLabelText('Tell TikTok of a purchase'), {
      target: { value: 'CONFIRMED' },
    });
    expect(screen.getByText(/TikTok learns from fewer fake orders\.$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect TikTok' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText("Pixel code: must be the pixel's code: 10 to 40 letters and digits"),
    ).toBeTruthy();

    type('Pixel code', 'CABC123DEF456GHI789J');
    fireEvent.click(screen.getByRole('button', { name: 'Connect TikTok' }));
    expect(await screen.findByText('Connected to pixel CABC123DEF456GHI789J.')).toBeTruthy();
    expect(sentOf(fake, 'TikTokEventsUpdate').at(-1)).toEqual({
      input: {
        pixelCode: 'CABC123DEF456GHI789J',
        accessToken: 'a1b2c3d4e5f6a7b8c9d0Tk42',
        purchaseAt: 'CONFIRMED',
      },
    });
    expect(
      screen.getByText('Saved. Orders placed from now on go to TikTok like this.'),
    ).toBeTruthy();
    expect(screen.getByText('Leave it blank to keep the one ending Tk42.')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Sent to TikTok' })).toBeTruthy();
  });

  it("lists TikTok's moments alone, with TikTok's request IDs", async () => {
    const fake = core('owner', CONNECTED);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=tiktok');

    const sent = await screen.findByRole('list');
    expect(within(sent).getByText('request_id req-77')).toBeTruthy();
    expect(within(sent).getByText('TikTok 40002: Invalid event_source_id')).toBeTruthy();
    expect(sentOf(fake, 'ConversionEvents')).toEqual([{ status: null, platform: 'TIKTOK' }]);
  });

  it('disconnects TikTok once asked whether they mean it', async () => {
    const fake = core('manager', CONNECTED);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=tiktok');

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect TikTok' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it connected' }));
    expect(sentOf(fake, 'TikTokEventsDelete')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect TikTok' }));
    expect(screen.getByText(/^Disconnect pixel CABC123DEF456GHI789J\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Not connected.')).toBeTruthy();
    expect(sentOf(fake, 'TikTokEventsDelete')).toEqual([{}]);
  });
});
