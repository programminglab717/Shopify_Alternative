import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationOf, pageFor } from '../offline/push';
import type { ShopAccess } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import type { BrowserSubscription } from './push';

/** This browser's push service, as the tests have it. */
const browser = vi.hoisted(() => ({
  support: 'yes' as 'yes' | 'install' | 'no',
  allowed: true,
  blocked: false,
  subscription: null as BrowserSubscription | null,
}));

vi.mock('./push', () => ({
  pushSupport: () => browser.support,
  notificationsBlocked: () => browser.blocked,
  currentSubscription: () => Promise.resolve(browser.subscription),
  subscribeBrowser: (key: string) => {
    if (!browser.allowed) return Promise.resolve(null);
    browser.subscription = {
      endpoint: `https://fcm.googleapis.com/fcm/send/${key.slice(0, 4)}`,
      p256dh: 'B'.repeat(87),
      auth: 'a'.repeat(22),
    };
    return Promise.resolve(browser.subscription);
  },
  unsubscribeBrowser: () => {
    browser.subscription = null;
    return Promise.resolve();
  },
}));

const KEY = `B${'k'.repeat(86)}`;
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/Bkkk';

/** The core, keeping each browser's kinds as the Admin API does. */
function core(
  role: 'owner' | 'manager' | 'confirmation_agent' | 'packer' | 'accountant' | 'marketer',
  publicKey: string | null = KEY,
  shop?: Partial<ShopAccess>,
) {
  const kept = new Map<string, string[]>();
  return fakeCore(
    role,
    (operation, variables) => {
      if (operation === 'PushNotifications') {
        const endpoint = variables.endpoint as string | null;
        const kinds = endpoint ? kept.get(endpoint) : undefined;
        return {
          pushNotifications: {
            publicKey,
            subscription: kinds ? { endpoint, kinds } : null,
          },
        };
      }
      if (operation === 'PushSubscribe') {
        const input = variables.input as { endpoint: string; kinds: string[] };
        kept.set(input.endpoint, input.kinds);
        return {
          pushSubscribe: {
            subscription: { endpoint: input.endpoint, kinds: input.kinds },
            userErrors: [],
          },
        };
      }
      if (operation === 'PushUnsubscribe') {
        kept.delete(variables.endpoint as string);
        return { pushUnsubscribe: { unsubscribed: true } };
      }
      return {};
    },
    (path) =>
      path === '/auth/passkeys'
        ? { passkeys: [] }
        : path === '/auth/sessions'
          ? { sessions: [] }
          : {},
    { shop },
  );
}

const sent = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).at(-1)?.variables;

describe("The shop's news on a member of staff's phone (APP-03, ADR-506)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
    Object.assign(browser, { support: 'yes', allowed: true, blocked: false, subscription: null });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('turns notifications on for the kinds chosen, changes them, and turns them off', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/account');

    const card = await screen.findByRole('region', { name: 'Notifications on this device' });
    const lowStock = await within(card).findByRole('checkbox', { name: /Low stock/ });
    expect(within(card).getAllByRole('checkbox')).toHaveLength(6);
    fireEvent.click(lowStock);
    fireEvent.click(within(card).getByRole('button', { name: 'Turn on notifications' }));
    await waitFor(() =>
      expect(sent(fake, 'PushSubscribe')).toEqual({
        input: {
          endpoint: ENDPOINT,
          p256dh: 'B'.repeat(87),
          auth: 'a'.repeat(22),
          kinds: [
            'NEW_ORDER',
            'NEEDS_REVIEW',
            'CASH_REMITTED',
            'CONTACT_MESSAGE',
            'COMMENT_PENDING',
          ],
        },
      }),
    );
    expect(await within(card).findByText(/Notifications are on\. Hatti tells/)).toBeTruthy();
    expect(await within(card).findByText('Notifications are on for this device.')).toBeTruthy();

    fireEvent.click(within(card).getByRole('checkbox', { name: /Cash remitted/ }));
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sent(fake, 'PushSubscribe')).toMatchObject({
        input: { kinds: ['NEW_ORDER', 'NEEDS_REVIEW', 'CONTACT_MESSAGE', 'COMMENT_PENDING'] },
      }),
    );

    fireEvent.click(await within(card).findByRole('button', { name: 'Turn off on this device' }));
    await waitFor(() => expect(sent(fake, 'PushUnsubscribe')).toEqual({ endpoint: ENDPOINT }));
    expect(await within(card).findByText('Notifications are off for this device.')).toBeTruthy();
    expect(browser.subscription).toBeNull();
  });

  it("offers each member of staff only their role's news", async () => {
    vi.stubGlobal('fetch', core('accountant').fetcher);
    renderAdmin('/shop_1/account');
    const card = await screen.findByRole('region', { name: 'Notifications on this device' });
    const boxes = await within(card).findAllByRole('checkbox');
    expect(boxes.map((box) => box.closest('label')!.textContent)).toEqual([
      'Cash remittedA courier’s statement of the cash they sent.',
    ]);
  });

  it('offers who answers customers the contact form’s messages (ADR-591)', async () => {
    vi.stubGlobal('fetch', core('confirmation_agent').fetcher);
    renderAdmin('/shop_1/account');
    const card = await screen.findByRole('region', { name: 'Notifications on this device' });
    const boxes = await within(card).findAllByRole('checkbox');
    expect(boxes.map((box) => box.closest('label')!.textContent)).toEqual([
      expect.stringMatching(/^New orders/),
      expect.stringMatching(/^Orders to review/),
      'Contact form messagesA shopper writing to you from your online store’s contact page.',
    ]);
  });

  it('offers who writes the blogs the comments waiting for approval (ADR-619)', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/account');
    const card = await screen.findByRole('region', { name: 'Notifications on this device' });
    const boxes = await within(card).findAllByRole('checkbox');
    expect(boxes.map((box) => box.closest('label')!.textContent)).toEqual([
      'Comments to approveA shopper’s comment on an article, waiting for you to approve it.',
    ]);
  });

  it("offers a custom role's member only the news of work they may do (ADR-581)", async () => {
    vi.stubGlobal(
      'fetch',
      core('manager', KEY, {
        mfaRequired: true,
        scopes: ['write_orders', 'read_inventory'],
        capabilities: ['assign_orders'],
        customRole: { id: 'role_1', name: 'Lead' },
      }).fetcher,
    );
    renderAdmin('/shop_1/account');
    const card = await screen.findByRole('region', { name: 'Notifications on this device' });
    const boxes = await within(card).findAllByRole('checkbox');
    expect(boxes.map((box) => box.closest('label')!.textContent)).toEqual([
      expect.stringMatching(/^New orders/),
      expect.stringMatching(/^Orders to review/),
    ]);
  });

  it('says why where notifications cannot be turned on', async () => {
    browser.allowed = false;
    browser.blocked = true;
    const fake = core('packer');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/account');
    let card = await screen.findByRole('region', { name: 'Notifications on this device' });
    expect(await within(card).findByText('Your role has no news to be told of.')).toBeTruthy();
    cleanup();

    vi.stubGlobal('fetch', core('owner').fetcher);
    renderAdmin('/shop_1/account');
    card = await screen.findByRole('region', { name: 'Notifications on this device' });
    expect(await within(card).findByText(/blocked in this browser/)).toBeTruthy();
    cleanup();

    vi.stubGlobal('fetch', core('owner', null).fetcher);
    renderAdmin('/shop_1/account');
    expect(await screen.findByText('Hatti does not send notifications yet.')).toBeTruthy();
    cleanup();

    browser.support = 'install';
    renderAdmin('/shop_1/account');
    expect(await screen.findByText(/Add Hatti to your home screen first/)).toBeTruthy();
  });

  it("shows the core's push, and opens only the admin's own pages", () => {
    expect(
      notificationOf({
        title: 'Zari: new order #1001',
        body: 'Rs 4,500, cash on delivery.',
        url: '/shop_1/orders/ord_1',
        tag: 'new_order:1',
      }),
    ).toEqual({
      title: 'Zari: new order #1001',
      options: {
        body: 'Rs 4,500, cash on delivery.',
        tag: 'new_order:1',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        dir: 'auto',
        data: { url: '/shop_1/orders/ord_1' },
      },
    });
    expect(notificationOf({ body: 'no title' })).toBeNull();
    expect(notificationOf('text')).toBeNull();

    const origin = 'https://admin.hatti.pk';
    expect(pageFor('/shop_1/orders/ord_1', origin)).toBe(`${origin}/shop_1/orders/ord_1`);
    for (const elsewhere of ['https://evil.example/x', '//evil.example/x', 'javascript:x', 7]) {
      expect(pageFor(elsewhere, origin)).toBe(`${origin}/`);
    }
  });
});
