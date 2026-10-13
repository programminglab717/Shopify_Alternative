import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  confirmIdentity,
  fakeCore,
  LATER,
  REAUTHENTICATE,
  renderAdmin,
  signedIn,
  type,
} from '../test-support';

const SHEET = {
  id: 'tok_1',
  name: 'Orders sheet',
  scopes: ['read_products', 'write_orders'],
  tokenHint: 'abcd',
  secretHint: 'wxyz',
  createdAt: LATER,
};

const OLD = {
  id: 'tok_2',
  name: 'Development token',
  scopes: [
    'write_products',
    'write_inventory',
    'write_locations',
    'write_orders',
    'write_customers',
    'write_segments',
    'write_discounts',
    'read_store_credit_accounts',
    'write_store_credit_account_transactions',
    'write_files',
    'write_content',
    'write_online_store_pages',
    'write_online_store_navigation',
    'write_themes',
    'write_translations',
    'write_legal_policies',
    'write_domains',
    'write_pixels',
    'write_marketing_events',
    'write_settings',
  ],
  tokenHint: 'efgh',
  secretHint: null,
  createdAt: LATER,
};

const EARLIER = new Date(Date.now() - 3_600_000).toISOString();

const DELIVERED = {
  id: 'whd_1',
  status: 'DELIVERED',
  attempts: 1,
  responseStatus: 200,
  error: null,
  createdAt: EARLIER,
  lastAttemptAt: EARLIER,
  nextAttemptAt: null,
};

const RETRYING = {
  ...DELIVERED,
  id: 'whd_2',
  status: 'PENDING',
  attempts: 2,
  responseStatus: 500,
  error: 'It answered 500',
  nextAttemptAt: LATER,
};

function core() {
  let confirmed = false;
  let apps: Record<string, unknown>[] = [SHEET, OLD];
  let subscriptions: Record<string, unknown>[] = [
    {
      id: 'whs_1',
      topic: 'ORDERS_CREATE',
      callbackUrl: 'https://sheets.example.pk/hooks/orders',
      appId: 'tok_1',
      createdAt: EARLIER,
      lastDelivery: RETRYING,
    },
  ];
  return fakeCore(
    'owner',
    (operation, variables) => {
      switch (operation) {
        case 'CustomApps':
          return { customApps: apps };
        case 'CustomAppCreate': {
          if (!confirmed) return REAUTHENTICATE;
          const input = variables.input as { name: string; scopes: string[] };
          const app = { ...SHEET, id: 'tok_3', ...input, tokenHint: '9876', secretHint: '5432' };
          apps = [app, ...apps];
          return {
            customAppCreate: {
              customApp: app,
              accessToken: 'hat_madeOnce9876',
              webhookSecret: 'hws_signedWith5432',
              userErrors: [],
            },
          };
        }
        case 'CustomAppUpdate': {
          const input = variables.input as { name: string; scopes: string[] };
          apps = apps.map((app) => (app.id === variables.id ? { ...app, ...input } : app));
          return {
            customAppUpdate: {
              customApp: apps.find((app) => app.id === variables.id),
              userErrors: [],
            },
          };
        }
        case 'CustomAppTokenRotate':
          return {
            customAppTokenRotate: {
              customApp: SHEET,
              accessToken: 'hat_newOne1111',
              userErrors: [],
            },
          };
        case 'CustomAppSecretRotate':
          apps = apps.map((app) =>
            app.id === variables.id ? { ...app, secretHint: '2222' } : app,
          );
          return {
            customAppSecretRotate: {
              customApp: apps.find((app) => app.id === variables.id),
              webhookSecret: 'hws_newSecret2222',
              userErrors: [],
            },
          };
        case 'WebhookSubscriptions':
          return { webhookSubscriptions: subscriptions };
        case 'WebhookDeliveries':
          return { webhookDeliveries: [RETRYING, DELIVERED] };
        case 'WebhookSubscriptionCreate':
          subscriptions = [
            ...subscriptions,
            {
              id: 'whs_2',
              topic: variables.topic,
              callbackUrl: variables.callbackUrl,
              appId: variables.appId,
              createdAt: LATER,
              lastDelivery: null,
            },
          ];
          return {
            webhookSubscriptionCreate: { webhookSubscription: { id: 'whs_2' }, userErrors: [] },
          };
        case 'WebhookSubscriptionDelete':
          subscriptions = subscriptions.filter((each) => each.id !== variables.id);
          return {
            webhookSubscriptionDelete: {
              deletedWebhookSubscriptionId: variables.id,
              userErrors: [],
            },
          };
        case 'CustomAppDelete':
          apps = apps.filter((app) => app.id !== variables.id);
          return { customAppDelete: { deletedCustomAppId: variables.id, userErrors: [] } };
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

describe('Custom apps in settings (DEV-04, ADR-395)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('makes an app with what it may reach, once the owner confirms who they are, and shows its token once', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Apps/ }));
    const sheet = (await screen.findByText('Orders sheet')).closest('li');
    const old = screen.getByText('Development token').closest('li');
    expect(within(sheet!).getByText('Products: Read · Orders: Read and write')).toBeTruthy();
    expect(within(sheet!).getByText('Token ends abcd · Signing secret ends wxyz')).toBeTruthy();
    expect(within(old!).getByText('Everything the API offers')).toBeTruthy();
    expect(within(old!).getByText('Token ends efgh · No signing secret yet')).toBeTruthy();
    expect(within(old!).getByRole('button', { name: 'Make a signing secret' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Make an app' }));
    type('Name', 'Accounting sync');
    fireEvent.change(screen.getByLabelText('Orders'), { target: { value: 'read' } });
    fireEvent.change(screen.getByLabelText('Customers'), { target: { value: 'write' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make it' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    expect(
      await screen.findByText(/^Copy what Accounting sync needs now: it is not shown again\./),
    ).toBeTruthy();
    expect(screen.getByText('hat_madeOnce9876')).toBeTruthy();
    expect(screen.getByText('hws_signedWith5432')).toBeTruthy();
    const input = { name: 'Accounting sync', scopes: ['read_orders', 'write_customers'] };
    expect(sentOf(fake, 'CustomAppCreate')).toEqual([{ input }, { input }]);

    fireEvent.click(screen.getByRole('button', { name: "I've copied it" }));
    expect(screen.queryByText('hat_madeOnce9876')).toBeNull();
    expect(await screen.findByText('Accounting sync')).toBeTruthy();
  });

  it("changes an app's access, gives it a new token or secret, and removes it", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/apps');

    const sheet = () => screen.getByText('Orders sheet').closest('li')!;
    await screen.findByText('Orders sheet');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Change' }));
    expect((screen.getByLabelText('Orders') as HTMLSelectElement).value).toBe('write');
    fireEvent.change(screen.getByLabelText('Products'), { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sentOf(fake, 'CustomAppUpdate')).toEqual([
        { id: 'tok_1', input: { name: 'Orders sheet', scopes: ['write_orders'] } },
      ]),
    );
    expect(await screen.findByText('Orders: Read and write')).toBeTruthy();

    fireEvent.click(within(sheet()).getByRole('button', { name: 'New token' }));
    expect(await screen.findByText('hat_newOne1111')).toBeTruthy();
    expect(screen.queryByText('Webhook signing secret')).toBeNull();

    const old = screen.getByText('Development token').closest('li')!;
    fireEvent.click(within(old).getByRole('button', { name: 'Make a signing secret' }));
    expect(await screen.findByText('hws_newSecret2222')).toBeTruthy();

    fireEvent.click(within(sheet()).getByRole('button', { name: 'Remove Orders sheet' }));
    expect(
      within(sheet()).getByText('Remove Orders sheet? Its token stops working at once.'),
    ).toBeTruthy();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Remove it' }));
    await waitFor(() => expect(screen.queryByText('Orders sheet')).toBeNull());
    expect(sentOf(fake, 'CustomAppDelete')).toEqual([{ id: 'tok_1' }]);
  });

  it("shows each app's webhooks and how they went, and adds and removes them", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/apps');

    const hooks = await screen.findByRole('region', { name: "Orders sheet's webhooks" });
    expect(within(hooks).getByText('An order is placed')).toBeTruthy();
    expect(within(hooks).getByText('https://sheets.example.pk/hooks/orders')).toBeTruthy();
    expect(within(hooks).getByText(/^Trying again .*: It answered 500$/)).toBeTruthy();
    fireEvent.click(within(hooks).getByRole('button', { name: 'Recent deliveries' }));
    expect(await within(hooks).findByText(/^Delivered /)).toBeTruthy();
    expect(within(hooks).getByText('Tries: 2')).toBeTruthy();
    expect(
      fake.sent.filter((each) => each.operation === 'WebhookDeliveries').at(-1)!.variables,
    ).toEqual({ subscriptionId: 'whs_1', first: 10 });

    // Topics of what the app may read alone: orders and products, and its own removal.
    fireEvent.click(within(hooks).getByRole('button', { name: 'Add a webhook' }));
    const when = within(hooks).getByLabelText('When') as HTMLSelectElement;
    expect([...when.options].map((option) => option.text)).toEqual([
      'An order is placed',
      'An order changes',
      'An order is cancelled',
      'An order is paid',
      'A parcel is sent',
      'A parcel moves on',
      'A product is added',
      'A product changes',
      'A product is deleted',
      'This app is removed',
    ]);
    fireEvent.change(when, { target: { value: 'ORDERS_PAID' } });
    fireEvent.change(within(hooks).getByLabelText('Send it to'), {
      target: { value: 'https://sheets.example.pk/hooks/paid' },
    });
    fireEvent.click(within(hooks).getByRole('button', { name: 'Add it' }));
    expect(await within(hooks).findByText('Nothing sent yet')).toBeTruthy();
    expect(within(hooks).getByText('https://sheets.example.pk/hooks/paid')).toBeTruthy();
    expect(
      fake.sent.filter((each) => each.operation === 'WebhookSubscriptionCreate')[0]!.variables,
    ).toEqual({
      topic: 'ORDERS_PAID',
      callbackUrl: 'https://sheets.example.pk/hooks/paid',
      appId: 'tok_1',
    });

    fireEvent.click(
      within(hooks).getByRole('button', { name: 'Remove the webhook for An order is placed' }),
    );
    await waitFor(() => expect(within(hooks).queryByText('An order is placed')).toBeNull());
    // The development token has none.
    expect(
      within(screen.getByRole('region', { name: "Development token's webhooks" })).getByText(
        /^It is sent nothing yet\./,
      ),
    ).toBeTruthy();
  });
});
