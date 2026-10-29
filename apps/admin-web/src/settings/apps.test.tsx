import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  let sessions = 0;
  let apps: Record<string, unknown>[] = [SHEET, OLD];
  let storefrontTokens: Record<string, unknown>[] = [
    {
      id: 'sfat_1',
      title: 'Mobile app',
      private: false,
      hint: 'mno1',
      accessToken: null,
      createdAt: LATER,
    },
  ];
  let installed: Record<string, unknown>[] = [
    {
      id: 'tok_9',
      appId: 'papp_1',
      name: 'Reviews Pro',
      scopes: ['read_products', 'write_orders'],
      installedAt: EARLIER,
    },
  ];
  let embeds: Record<string, unknown>[] = [
    {
      id: 'aemb_1',
      appName: 'Reviews Pro',
      name: 'Reviews widget',
      src: 'https://cdn.reviews.example.pk/widget.js',
      enabled: false,
    },
  ];
  let functions: Record<string, unknown>[] = [
    {
      id: 'afun_1',
      appName: 'COD guard',
      title: 'Hide cash on delivery above Rs 10,000',
      target: 'payment_customization',
      enabled: false,
      configuration: '{}',
      lastError: 'It ran past 50 ms',
      failedAt: EARLIER,
    },
  ];
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
        case 'WebhookSubscriptionUpdate':
          if (!String(variables.callbackUrl).startsWith('https://')) {
            return {
              webhookSubscriptionUpdate: {
                webhookSubscription: null,
                userErrors: [
                  {
                    field: ['webhookSubscription', 'callbackUrl'],
                    code: 'INVALID',
                    message: 'Give an https address',
                  },
                ],
              },
            };
          }
          subscriptions = subscriptions.map((each) =>
            each.id === variables.id ? { ...each, callbackUrl: variables.callbackUrl } : each,
          );
          return {
            webhookSubscriptionUpdate: {
              webhookSubscription: { id: variables.id, callbackUrl: variables.callbackUrl },
              userErrors: [],
            },
          };
        case 'WebhookSubscriptionDelete':
          subscriptions = subscriptions.filter((each) => each.id !== variables.id);
          return {
            webhookSubscriptionDelete: {
              deletedWebhookSubscriptionId: variables.id,
              userErrors: [],
            },
          };
        case 'StorefrontAccessTokens':
          return {
            shop: { url: 'https://zari.hatti.pk' },
            storefrontAccessTokens: storefrontTokens,
          };
        case 'StorefrontAccessTokenCreate': {
          const input = variables.input as { title: string; private: boolean };
          const made = {
            id: 'sfat_2',
            title: input.title,
            private: input.private,
            hint: 'Zz99',
            accessToken: 'hsfp_shownOnceZz99',
            createdAt: LATER,
          };
          storefrontTokens = [...storefrontTokens, { ...made, accessToken: null }];
          return { storefrontAccessTokenCreate: { storefrontAccessToken: made, userErrors: [] } };
        }
        case 'StorefrontAccessTokenDelete':
          storefrontTokens = storefrontTokens.filter((token) => token.id !== variables.id);
          return {
            storefrontAccessTokenDelete: {
              deletedStorefrontAccessTokenId: variables.id,
              userErrors: [],
            },
          };
        case 'AppEmbeds':
          return { appEmbeds: embeds };
        case 'AppEmbedEnable':
          embeds = embeds.map((each) =>
            each.id === variables.id ? { ...each, enabled: variables.enabled } : each,
          );
          return {
            appEmbedEnable: {
              appEmbed: { id: variables.id, enabled: variables.enabled },
              userErrors: [],
            },
          };
        case 'AppFunctions':
          return { appFunctions: functions };
        case 'AppFunctionEnable':
          functions = functions.map((each) =>
            each.id === variables.id
              ? {
                  ...each,
                  enabled: variables.enabled,
                  configuration: variables.configuration ?? each.configuration,
                }
              : each,
          );
          return {
            appFunctionEnable: {
              appFunction: functions.find((each) => each.id === variables.id),
              userErrors: [],
            },
          };
        case 'AppSession':
          sessions += 1;
          return variables.id === 'tok_9'
            ? {
                appSession: {
                  name: 'Reviews Pro',
                  // A fresh token each time it is asked.
                  url: `https://reviews.example.pk/admin?shop=shop_1&embedded=1&id_token=${
                    sessions === 1 ? 'jwt' : `jwt${sessions}`
                  }`,
                  expiresAt: LATER,
                },
              }
            : { appSession: null };
        case 'InstalledApps':
          return { installedApps: installed };
        case 'AppUninstall':
          installed = installed.filter((app) => app.id !== variables.id);
          return { appUninstall: { uninstalledAppId: variables.id, userErrors: [] } };
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

    // Sent elsewhere, its topic kept; left as it was, nothing is sent (ADR-797).
    const change = () =>
      within(hooks).getByRole('button', {
        name: 'Change where the webhook for An order is placed is sent',
      });
    fireEvent.click(change());
    fireEvent.click(within(hooks).getByRole('button', { name: 'Save' }));
    expect(within(hooks).getByText('https://sheets.example.pk/hooks/orders')).toBeTruthy();
    fireEvent.click(change());
    const instead = within(hooks).getByLabelText('Send it to instead');
    fireEvent.change(instead, { target: { value: 'ftp://sheets.example.pk/hooks' } });
    fireEvent.submit(instead.closest('form')!);
    expect(await within(hooks).findByText(/Give an https address/)).toBeTruthy();
    fireEvent.change(instead, { target: { value: 'https://new.example.pk/hooks/orders' } });
    fireEvent.click(within(hooks).getByRole('button', { name: 'Save' }));
    expect(await within(hooks).findByText('https://new.example.pk/hooks/orders')).toBeTruthy();
    expect(sentOf(fake, 'WebhookSubscriptionUpdate')).toEqual([
      { id: 'whs_1', callbackUrl: 'ftp://sheets.example.pk/hooks' },
      { id: 'whs_1', callbackUrl: 'https://new.example.pk/hooks/orders' },
    ]);

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

  it('makes Storefront API tokens, shown once with where they go, and deletes them (DEV-02)', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Apps/ }));
    const section = await screen.findByRole('region', { name: 'Storefront API' });
    expect(
      await within(section).findByText('https://zari.hatti.pk/api/2026-10/graphql.json'),
    ).toBeTruthy();
    expect(within(section).getByText('Mobile app')).toBeTruthy();

    fireEvent.click(within(section).getByRole('button', { name: 'Make a Storefront API token' }));
    type('What uses it', 'Headless site');
    fireEvent.change(within(section).getByLabelText('Kind'), { target: { value: 'private' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Make the token' }));
    expect(await within(section).findByText('hsfp_shownOnceZz99')).toBeTruthy();
    expect(
      within(section).getByText(
        'Send it from your server alone, in the Shopify-Storefront-Private-Token header.',
      ),
    ).toBeTruthy();
    expect(sentOf(fake, 'StorefrontAccessTokenCreate')).toEqual([
      { input: { title: 'Headless site', private: true } },
    ]);
    fireEvent.click(within(section).getByRole('button', { name: "I've copied it" }));
    expect(within(section).queryByText('hsfp_shownOnceZz99')).toBeNull();

    fireEvent.click(within(section).getByRole('button', { name: 'Delete Mobile app' }));
    fireEvent.click(within(section).getByRole('button', { name: /^Remove/ }));
    await waitFor(() =>
      expect(sentOf(fake, 'StorefrontAccessTokenDelete')).toEqual([{ id: 'sfat_1' }]),
    );
  });

  it('lists the public apps installed, with what each reaches, and uninstalls one (DEV-05)', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Apps/ }));
    const section = await screen.findByRole('region', { name: 'Installed apps' });
    expect(await within(section).findByText('Reviews Pro')).toBeTruthy();
    expect(
      within(section).getByText(/^Reaches See products, See and change orders · Installed /),
    ).toBeTruthy();

    fireEvent.click(within(section).getByRole('button', { name: 'Uninstall Reviews Pro' }));
    expect(
      within(section).getByText('Uninstall Reviews Pro? It stops reaching the shop at once.'),
    ).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Uninstall' }));
    await waitFor(() => expect(sentOf(fake, 'AppUninstall')).toEqual([{ id: 'tok_9' }]));
    expect(await within(section).findByText('No app is installed.')).toBeTruthy();
  });

  it("opens an installed app inside the admin, and turns apps' storefront scripts on (DEV-06)", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/apps');

    const scripts = await screen.findByRole('region', { name: "Apps' storefront scripts" });
    expect(await within(scripts).findByText('Reviews widget')).toBeTruthy();
    expect(within(scripts).getByText('Off')).toBeTruthy();
    fireEvent.click(within(scripts).getByRole('button', { name: 'Turn on Reviews widget' }));
    await waitFor(() =>
      expect(sentOf(fake, 'AppEmbedEnable')).toEqual([{ id: 'aemb_1', enabled: true }]),
    );
    expect(await within(scripts).findByText('On')).toBeTruthy();

    const installed = await screen.findByRole('region', { name: 'Installed apps' });
    fireEvent.click(await within(installed).findByRole('link', { name: 'Open Reviews Pro' }));
    const frame = (await screen.findByTitle('Reviews Pro, inside Hatti')) as HTMLIFrameElement;
    // Its address names the admin, for the app's App Bridge to answer it alone (ADR-912).
    expect(frame.src).toBe(
      'https://reviews.example.pk/admin?shop=shop_1&embedded=1&id_token=jwt' +
        `&host=${encodeURIComponent(window.location.origin)}`,
    );
    expect(sentOf(fake, 'AppSession')).toEqual([{ id: 'tok_9' }]);
  });

  it("answers the app's App Bridge from its own frame alone (DEV-06, ADR-912)", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/apps/tok_9');
    const frame = (await screen.findByTitle('Reviews Pro, inside Hatti')) as HTMLIFrameElement;
    const app = frame.contentWindow!;
    const told = vi.spyOn(app, 'postMessage');
    const ask = (
      message: unknown,
      id?: string,
      origin = 'https://reviews.example.pk',
      source: unknown = app,
    ) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { bridge: 'hatti-app-bridge', version: 1, ...(id ? { id } : {}), message },
            origin,
            source: source as Window,
          }),
        );
      });

    // From another site, or another frame: nothing.
    ask({ type: 'toast', message: 'Phished' }, undefined, 'https://evil.example');
    ask({ type: 'toast', message: 'Phished' }, undefined, 'https://reviews.example.pk', window);
    ask({ type: 'toast', message: 'Reviews imported' });
    expect(await screen.findByText('Reviews imported')).toBeTruthy();
    expect(screen.queryByText('Phished')).toBeNull();

    // A fresh session token, sent to the app's origin alone.
    ask({ type: 'id_token' }, 't1');
    await waitFor(() =>
      expect(told).toHaveBeenCalledWith(
        {
          bridge: 'hatti-app-bridge',
          version: 1,
          id: 't1',
          message: { type: 'id_token', token: 'jwt2' },
        },
        'https://reviews.example.pk',
      ),
    );

    // The save bar, its buttons told of.
    ask({ type: 'save_bar', visible: true });
    const bar = await screen.findByRole('region', { name: "The app's unsaved changes" });
    fireEvent.click(within(bar).getByRole('button', { name: 'Save' }));
    expect(told).toHaveBeenCalledWith(
      { bridge: 'hatti-app-bridge', version: 1, message: { type: 'save' } },
      'https://reviews.example.pk',
    );
    ask({ type: 'save_bar', visible: false });
    expect(screen.queryByRole('region', { name: "The app's unsaved changes" })).toBeNull();

    // A page of the shop's admin, never another site.
    ask({ type: 'navigate', path: '//evil.example' });
    ask({ type: 'navigate', path: '/settings/apps' });
    expect(await screen.findByRole('region', { name: 'Installed apps' })).toBeTruthy();
  });

  it("turns apps' checkout functions on with their settings, and says when one failed (DEV-07)", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/apps');

    const functions = await screen.findByRole('region', { name: "Apps' checkout functions" });
    expect(
      await within(functions).findByText('Hide cash on delivery above Rs 10,000'),
    ).toBeTruthy();
    expect(within(functions).getByText('By COD guard · Hides ways to pay')).toBeTruthy();
    expect(within(functions).getByText(/Checkout went on without it\./)).toBeTruthy();
    fireEvent.change(
      within(functions).getByLabelText('Settings of Hide cash on delivery above Rs 10,000'),
      { target: { value: '{"above":1000000}' } },
    );
    fireEvent.click(
      within(functions).getByRole('button', {
        name: 'Turn on Hide cash on delivery above Rs 10,000',
      }),
    );
    await waitFor(() =>
      expect(sentOf(fake, 'AppFunctionEnable')).toEqual([
        { id: 'afun_1', enabled: true, configuration: '{"above":1000000}' },
      ]),
    );
    expect(await within(functions).findByText('On')).toBeTruthy();
  });

  it('says so of an app not installed', async () => {
    vi.stubGlobal('fetch', core().fetcher);
    renderAdmin('/shop_1/settings/apps/tok_404');
    expect(await screen.findByText('This app is not installed on the shop.')).toBeTruthy();
  });
});
