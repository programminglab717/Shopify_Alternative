import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  confirmIdentity,
  fakeCore,
  LATER,
  press,
  REAUTHENTICATE,
  renderAdmin,
  signedIn,
  type,
} from '../test-support';

const JAZZCASH = {
  gateway: 'jazzcash',
  name: 'JazzCash',
  test: false,
  refunds: 'PARTIAL',
  credentials: [
    { key: 'merchantId', label: 'Merchant ID', optional: false },
    { key: 'password', label: 'Password', optional: false },
    { key: 'mpin', label: 'Wallet MPIN', optional: true },
  ],
};
const SAFEPAY = { ...JAZZCASH, gateway: 'safepay', name: 'Safepay', refunds: 'WHOLE' };

const account = (id: string, gateway: typeof JAZZCASH) => ({
  id,
  gateway: gateway.gateway,
  gatewayName: gateway.name,
  environment: 'PRODUCTION',
  credentialsHint: 'f00d',
  webhookUrl: `https://hatti.test/webhooks/payments/${gateway.gateway}/${id}`,
  createdAt: LATER,
});

const STORAGE = 'http://localhost:4000/storage/shops/shop_1/files/f1/logo.png';

describe('The shop and its online payments in settings', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('connects a gateway once the owner confirms who they are, and gives its webhook address', async () => {
    let confirmed = false;
    const core = fakeCore(
      'owner',
      (operation) => {
        if (operation === 'PaymentGateways') {
          return {
            paymentGateways: [JAZZCASH],
            paymentGatewayAccounts: confirmed ? [account('pga_1', JAZZCASH)] : [],
            onlinePaymentSettings: { updatedAt: null, discount: null },
          };
        }
        if (operation === 'PaymentGatewayAccountConnect') {
          if (!confirmed) return REAUTHENTICATE;
          return {
            paymentGatewayAccountConnect: {
              paymentGatewayAccount: account('pga_1', JAZZCASH),
              userErrors: [],
            },
          };
        }
        throw new Error(`unexpected ${operation}`);
      },
      (path) => {
        if (path === '/auth/reauthenticate/options') return { methods: ['password'], phone: null };
        if (path === '/auth/reauthenticate') {
          confirmed = true;
          return { authenticatedAt: LATER, sensitiveActionsUntil: LATER };
        }
        throw new Error(`unexpected ${path}`);
      },
    );
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/online-payments');

    await screen.findByText('No online payments yet.');
    type('Merchant ID', ' MC12345 ');
    type('Password', 'secret');
    fireEvent.click(screen.getByRole('checkbox', { name: /Use its test environment/ }));
    await press('Connect');
    // The panel's own password field, not the gateway's.
    await confirmIdentity('Password', 'owner-password');
    await press('Confirm');

    await screen.findByText(/JazzCash is connected\. Add this address in its dashboard/);
    expect(
      screen.getAllByText('https://hatti.test/webhooks/payments/jazzcash/pga_1').length,
    ).toBeGreaterThan(0);
    const connects = core.sent.filter((each) => each.operation === 'PaymentGatewayAccountConnect');
    expect(connects).toHaveLength(2);
    expect(connects[1]?.variables).toEqual({
      input: {
        gateway: 'jazzcash',
        environment: 'SANDBOX',
        // The optional MPIN left blank is not sent.
        credentials: [
          { key: 'merchantId', value: 'MC12345' },
          { key: 'password', value: 'secret' },
        ],
      },
    });
  });

  it("changes a gateway's credentials once the owner confirms who they are, and moves it to real payments", async () => {
    let confirmed = false;
    let current = { ...account('pga_1', JAZZCASH), environment: 'SANDBOX' };
    const core = fakeCore(
      'owner',
      (operation, variables) => {
        if (operation === 'PaymentGateways') {
          return {
            paymentGateways: [JAZZCASH],
            paymentGatewayAccounts: [current],
            onlinePaymentSettings: { updatedAt: null, discount: null },
          };
        }
        if (operation === 'PaymentGatewayAccountUpdate') {
          if (!confirmed) return REAUTHENTICATE;
          const input = variables.input as {
            environment: string;
            credentials: { key: string; value: string }[];
          };
          if (input.credentials[0]?.value === 'MC-OLD') {
            return {
              paymentGatewayAccountUpdate: {
                paymentGatewayAccount: null,
                userErrors: [
                  {
                    field: ['input', 'credentials'],
                    code: 'INVALID',
                    message: 'JazzCash did not take these credentials',
                  },
                ],
              },
            };
          }
          current = { ...current, environment: input.environment, credentialsHint: 'be9f' };
          return {
            paymentGatewayAccountUpdate: { paymentGatewayAccount: current, userErrors: [] },
          };
        }
        throw new Error(`unexpected ${operation}`);
      },
      (path) => {
        if (path === '/auth/reauthenticate/options') return { methods: ['password'], phone: null };
        if (path === '/auth/reauthenticate') {
          confirmed = true;
          return { authenticatedAt: LATER, sensitiveActionsUntil: LATER };
        }
        throw new Error(`unexpected ${path}`);
      },
    );
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/online-payments');

    fireEvent.click(await screen.findByRole('button', { name: 'Change its credentials' }));
    await screen.findByText("JazzCash's credentials");
    const test = screen.getByRole('checkbox', { name: /Use its test environment/ });
    expect(test).toHaveProperty('checked', true);
    fireEvent.click(test);
    expect(
      screen.getByText(
        "JazzCash moves to its real environment: give that environment's credentials. Customers pay through it for real from then on.",
      ),
    ).toBeTruthy();
    type('Merchant ID', ' MC-LIVE ');
    type('Password', 'live-secret');
    await press('Save the credentials');
    await confirmIdentity('Password', 'owner-password');
    await press('Confirm');

    await screen.findByText('JazzCash now takes real payments.');
    const updates = () =>
      core.sent.filter((each) => each.operation === 'PaymentGatewayAccountUpdate');
    expect(updates()).toHaveLength(2);
    expect(updates()[1]?.variables).toEqual({
      id: 'pga_1',
      input: {
        environment: 'PRODUCTION',
        credentials: [
          { key: 'merchantId', value: 'MC-LIVE' },
          { key: 'password', value: 'live-secret' },
        ],
      },
    });
    await screen.findByText('ends in be9f');
    expect(screen.queryByText('Test environment')).toBeNull();

    // Credentials the core will not take are said, and the form stays.
    await press('Change its credentials');
    type('Merchant ID', 'MC-OLD');
    type('Password', 'old');
    type('Wallet MPIN (optional)', '1234');
    await press('Save the credentials');
    await screen.findByText('JazzCash did not take these credentials');
    type('Merchant ID', 'MC-NEW');
    await press('Save the credentials');
    await screen.findByText("JazzCash's credentials are changed.");
    expect(updates().at(-1)?.variables).toEqual({
      id: 'pga_1',
      input: {
        environment: 'PRODUCTION',
        credentials: [
          { key: 'merchantId', value: 'MC-NEW' },
          { key: 'password', value: 'old' },
          { key: 'mpin', value: '1234' },
        ],
      },
    });
  });

  it('puts the gateways in the order customers are offered them, and archives one', async () => {
    const core = fakeCore('manager', (operation) => {
      switch (operation) {
        case 'PaymentGateways':
          return {
            paymentGateways: [JAZZCASH, SAFEPAY],
            paymentGatewayAccounts: [account('pga_1', JAZZCASH), account('pga_2', SAFEPAY)],
            onlinePaymentSettings: { updatedAt: null, discount: null },
          };
        case 'PaymentGatewayAccountsReorder':
          return { paymentGatewayAccountsReorder: { paymentGatewayAccounts: [], userErrors: [] } };
        case 'PaymentGatewayAccountArchive':
          return {
            paymentGatewayAccountArchive: {
              paymentGatewayAccount: { id: 'pga_2' },
              userErrors: [],
            },
          };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/online-payments');

    await screen.findByText('Customers are offered them in this order.');
    expect(screen.getByText('Refunds: any part of a payment, from Hatti.')).toBeTruthy();
    // Every gateway has an account, so none is offered to connect.
    expect(screen.queryByRole('button', { name: 'Connect another gateway' })).toBeNull();
    await press('Move down');
    await waitFor(() =>
      expect(
        core.sent.find((each) => each.operation === 'PaymentGatewayAccountsReorder')?.variables,
      ).toEqual({ ids: ['pga_2', 'pga_1'] }),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Archive' })[1]!);
    await screen.findByText('No new payments through it; those made still count.');
    await press('Archive it');
    await waitFor(() =>
      expect(
        core.sent.find((each) => each.operation === 'PaymentGatewayAccountArchive')?.variables,
      ).toEqual({ id: 'pga_2' }),
    );
  });

  it('takes something off orders paid online once there is a gateway, or nothing again', async () => {
    let discount: Record<string, unknown> | null = null;
    const core = fakeCore('owner', (operation, variables) => {
      switch (operation) {
        case 'PaymentGateways':
          return {
            paymentGateways: [JAZZCASH],
            paymentGatewayAccounts: [account('pga_1', JAZZCASH)],
            onlinePaymentSettings: { updatedAt: null, discount },
          };
        case 'OnlinePaymentSettingsUpdate': {
          const input = (variables.input as { discount: Record<string, unknown> | null }).discount;
          if (input && 'amount' in input && input.amount === '0') {
            return {
              onlinePaymentSettingsUpdate: {
                onlinePaymentSettings: null,
                userErrors: [
                  {
                    field: ['input', 'discount', 'amount'],
                    code: 'INVALID',
                    message: 'must be more than zero',
                  },
                ],
              },
            };
          }
          discount = input && {
            kind: 'percentage' in input ? 'PERCENTAGE' : 'FIXED_AMOUNT',
            percentage: input.percentage ?? null,
            cap: input.cap ? { amount: `${String(input.cap)}.00`, currencyCode: 'PKR' } : null,
            amount: null,
          };
          return {
            onlinePaymentSettingsUpdate: {
              onlinePaymentSettings: { updatedAt: LATER, discount },
              userErrors: [],
            },
          };
        }
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/online-payments');

    const choice = (await screen.findByLabelText(
      'Something off for paying online',
    )) as HTMLSelectElement;
    expect(choice.value).toBe('NONE');
    const sent = () => core.sent.filter((each) => each.operation === 'OnlinePaymentSettingsUpdate');

    fireEvent.change(choice, { target: { value: 'FIXED_AMOUNT' } });
    type('Amount off', '0');
    await press('Save');
    await screen.findByText('Amount off: must be more than zero');

    fireEvent.change(choice, { target: { value: 'PERCENTAGE' } });
    type('Percentage off', 'five');
    await press('Save');
    await screen.findByText('Percentage off: type a percentage, such as 10 or 12.5');
    expect(sent()).toHaveLength(1);

    type('Percentage off', '5%');
    type('At most', '300');
    await press('Save');
    await screen.findByText('Saved. Checkout uses it from now on.');
    expect(sent().at(-1)?.variables).toEqual({
      input: { discount: { percentage: 5, cap: '300' } },
    });

    fireEvent.change(choice, { target: { value: 'NONE' } });
    expect(screen.queryByLabelText('Percentage off')).toBeNull();
    await press('Save');
    await waitFor(() => expect(sent()).toHaveLength(3));
    expect(sent().at(-1)?.variables).toEqual({ input: { discount: null } });
  });

  it('asks nothing of paying online while no gateway is connected and nothing is taken off', async () => {
    vi.stubGlobal(
      'fetch',
      fakeCore('owner', (operation) => {
        if (operation !== 'PaymentGateways') throw new Error(`unexpected ${operation}`);
        return {
          paymentGateways: [JAZZCASH],
          paymentGatewayAccounts: [],
          onlinePaymentSettings: { updatedAt: null, discount: null },
        };
      }).fetcher,
    );
    renderAdmin('/shop_1/settings/online-payments');

    await screen.findByText('No online payments yet.');
    expect(screen.queryByLabelText('Something off for paying online')).toBeNull();
  });

  it('uploads a logo for the shop, and saves its WhatsApp number', async () => {
    const core = fakeCore('owner', (operation) => {
      switch (operation) {
        case 'ShopDetails':
          return {
            shop: { brand: { logo: null, squareLogo: null } },
            onlineStorePreferences: { whatsappNumber: '+923001234567' },
          };
        case 'StagedUploadsCreate':
          return {
            stagedUploadsCreate: {
              stagedTargets: [
                {
                  url: `${STORAGE}?expires=1&signature=s`,
                  httpMethod: 'PUT',
                  resourceUrl: STORAGE,
                  parameters: [{ name: 'content-type', value: 'image/png' }],
                },
              ],
              userErrors: [],
            },
          };
        case 'FileCreate':
          return { fileCreate: { files: [{ id: 'fil_1' }], userErrors: [] } };
        case 'ShopBrandUpdate':
          return { shopBrandUpdate: { brand: { updatedAt: LATER }, userErrors: [] } };
        case 'OnlineStorePreferencesUpdate':
          return {
            onlineStorePreferencesUpdate: {
              preferences: { whatsappNumber: '+923217654321' },
              userErrors: [],
            },
          };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/shop');

    const number = (await screen.findByLabelText('WhatsApp number')) as HTMLInputElement;
    expect(number.value).toBe('0300 1234567');
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Logo', { selector: 'input' }), {
        target: { files: [new File([new Uint8Array(4)], 'logo.png', { type: 'image/png' })] },
      }),
    );
    await waitFor(() =>
      expect(core.sent.find((each) => each.operation === 'ShopBrandUpdate')?.variables).toEqual({
        input: { logo: 'fil_1' },
      }),
    );
    expect(core.uploads).toEqual([
      { url: `${STORAGE}?expires=1&signature=s`, type: 'image/png', size: 4 },
    ]);
    expect(core.sent.find((each) => each.operation === 'FileCreate')?.variables).toEqual({
      files: [{ originalSource: STORAGE, alt: 'Logo' }],
    });

    type('WhatsApp number', '0321 7654321');
    await press('Save');
    await screen.findByText('Saved. Your storefront shows it in a moment.');
    expect(number.value).toBe('0321 7654321');
    expect(
      core.sent.find((each) => each.operation === 'OnlineStorePreferencesUpdate')?.variables,
    ).toEqual({ input: { whatsappNumber: '0321 7654321' } });
  });
});
