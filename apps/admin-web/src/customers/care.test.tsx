import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, REAUTHENTICATE, renderAdmin, signedIn, type } from '../test-support';

const pkr = (amount: string) => ({ amount, currencyCode: 'PKR' });
const LAST = new Date(Date.now() - 86_400_000).toISOString();

function customer(id: string, name: string, erasureScheduledAt: string | null = null) {
  return {
    id,
    displayName: name,
    name,
    phone: '+923001234567',
    otherPhones: [],
    email: null,
    note: '',
    tags: [],
    createdAt: LAST,
    numberOfOrders: 1,
    lastOrderAt: LAST,
    amountSpent: pkr('3200.00'),
    deliveryHistory: { delivered: 1, returned: 0, cancelled: 0, inProgress: 0, lost: 0 },
    blocklistEntry: null,
    whatsappMarketingConsent: { marketingState: 'SUBSCRIBED' },
    smsMarketingConsent: { marketingState: 'NOT_SUBSCRIBED' },
    emailMarketingConsent: { marketingState: 'NOT_SUBSCRIBED' },
    erasureScheduledAt,
    addresses: [],
    orders: { nodes: [] },
  };
}

function core(role: StaffRole) {
  let erasure: string | null = null;
  let confirmed = false;
  return fakeCore(
    role,
    (operation, variables) => {
      switch (operation) {
        case 'Customer':
          return {
            shop: { timezone: 'Asia/Karachi' },
            customer: customer(variables.id as string, 'Ayesha Khan', erasure),
          };
        case 'CustomerStoreCredit':
          return { customer: { id: variables.id, storeCreditAccounts: { nodes: [] } } };
        case 'CustomerStoreCreditLedger':
          return { customer: { id: variables.id, storeCreditAccounts: { nodes: [] } } };
        case 'Customers':
          return {
            customers: {
              nodes: [
                { ...customer('cus_1', 'Ayesha Khan'), tags: [] },
                { ...customer('cus_2', 'Ayesha K.'), phone: '+923211234567' },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        case 'CustomerCreate': {
          const input = variables.input as { phone: string };
          if (input.phone === '12345') {
            return {
              customerCreate: {
                customer: null,
                userErrors: [
                  {
                    field: ['input', 'phone'],
                    code: 'INVALID',
                    message: 'must be a Pakistani mobile number',
                  },
                ],
              },
            };
          }
          return { customerCreate: { customer: { id: 'cus_9' }, userErrors: [] } };
        }
        case 'CustomerMarketingConsentUpdate':
          return { customerMarketingConsentUpdate: { customer: { id: 'cus_1' }, userErrors: [] } };
        case 'CustomerMerge':
          return { customerMerge: { customer: { id: 'cus_1' }, userErrors: [] } };
        case 'CustomerDataExport':
          if (!confirmed) return REAUTHENTICATE;
          return {
            customerDataExport: {
              fileName: 'customer-cus_1.json',
              json: '{"format":"hatti.customer-data/1"}',
              userErrors: [],
            },
          };
        case 'CustomerErasureRequest':
          if (!confirmed) return REAUTHENTICATE;
          erasure = LATER;
          return { customerErasureRequest: { erasureScheduledAt: LATER, userErrors: [] } };
        case 'CustomerErasureCancel':
          erasure = null;
          return { customerErasureCancel: { userErrors: [] } };
        case 'CustomerErasureRequests':
          return {
            customerErasureRequests: {
              nodes: [
                {
                  requestedAt: LAST,
                  scheduledAt: LATER,
                  customer: { id: 'cus_3', displayName: 'Bilal Ahmed', phone: '+923331234567' },
                },
              ],
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

describe("Customers' care", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
    URL.createObjectURL = vi.fn(() => 'blob:customer');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('adds a customer by hand, with what they agreed to, and opens their page', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/customers');

    fireEvent.click(await screen.findByRole('link', { name: 'Add a customer' }));
    await screen.findByRole('heading', { name: 'Add a customer' });
    type('Mobile', '12345');
    type('Other numbers', '0321 1234567, 0333 7654321');
    type('Name', 'Sara Malik');
    type('Tags', 'wholesale, Lahore');
    fireEvent.click(screen.getByLabelText('WhatsApp'));
    fireEvent.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(
      await screen.findByText('Say what they agreed to: the words you asked them with.'),
    ).toBeTruthy();
    type('What they agreed to', 'Send me offers on WhatsApp');
    fireEvent.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(await screen.findByText('Mobile: must be a Pakistani mobile number')).toBeTruthy();

    type('Mobile', '0300 1234567');
    fireEvent.click(screen.getByRole('button', { name: 'Add customer' }));
    await screen.findByRole('heading', { name: 'Ayesha Khan' });
    expect(sentOf(fake, 'CustomerCreate').at(-1)).toEqual({
      input: {
        phone: '0300 1234567',
        otherPhones: ['0321 1234567', '0333 7654321'],
        name: 'Sara Malik',
        tags: ['wholesale', 'Lahore'],
        marketingConsent: [
          {
            channel: 'WHATSAPP',
            marketingState: 'SUBSCRIBED',
            wording: 'Send me offers on WhatsApp',
          },
        ],
      },
    });
    expect(sentOf(fake, 'Customer').at(-1)).toEqual({ id: 'cus_9' });
  });

  it('changes what they agreed to, and merges a duplicate once asked', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/customers/cus_1');

    const consent = await screen.findByRole('region', { name: 'Marketing they agreed to' });
    fireEvent.click(within(consent).getByLabelText('WhatsApp'));
    fireEvent.click(within(consent).getByLabelText('SMS'));
    type('What they agreed to', 'Yes to SMS offers');
    fireEvent.click(within(consent).getByRole('button', { name: 'Save marketing' }));
    await waitFor(() =>
      expect(sentOf(fake, 'CustomerMarketingConsentUpdate')).toEqual([
        {
          id: 'cus_1',
          marketingConsent: [
            { channel: 'WHATSAPP', marketingState: 'UNSUBSCRIBED' },
            { channel: 'SMS', marketingState: 'SUBSCRIBED', wording: 'Yes to SMS offers' },
          ],
        },
      ]),
    );

    type('Name or number', 'Ayesha');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: /Ayesha K\./ }));
    expect(screen.queryByRole('button', { name: /^Ayesha Khan/ })).toBeNull();
    expect(
      screen.getByText('Merge Ayesha K. into Ayesha Khan? This cannot be undone.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(await screen.findByText('Ayesha K. was merged in.')).toBeTruthy();
    expect(sentOf(fake, 'CustomerMerge')).toEqual([{ customerId: 'cus_1', duplicateId: 'cus_2' }]);
  });

  it('downloads their data and erases them in ten days, once the member confirms who they are; then keeps them', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/customers/cus_1');

    fireEvent.click(await screen.findByRole('button', { name: 'Download their data' }));
    await screen.findByText('Confirm it is you');
    type('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Saved as customer-cus_1.json. Send it to them.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Erase at their request' }));
    fireEvent.click(screen.getByRole('button', { name: 'Erase in 10 days' }));
    expect(
      await screen.findByText(/^Their personal data will be erased on .*, as they asked\.$/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep the customer' }));
    expect(await screen.findByRole('button', { name: 'Erase at their request' })).toBeTruthy();
    expect(sentOf(fake, 'CustomerErasureCancel')).toEqual([{ id: 'cus_1' }]);
  });

  it('lists the erasures waiting, and shows an agent none of it', async () => {
    vi.stubGlobal('fetch', core('manager').fetcher);
    renderAdmin('/shop_1/customers/erasures');
    expect(await screen.findByText('Bilal Ahmed')).toBeTruthy();
    expect(screen.getByText(/^Erased on .*; asked on /)).toBeTruthy();
    cleanup();

    vi.stubGlobal('fetch', core('confirmation_agent').fetcher);
    renderAdmin('/shop_1/customers/cus_1');
    await screen.findByRole('heading', { name: 'Ayesha Khan' });
    expect(screen.queryByRole('region', { name: 'Marketing they agreed to' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Erase at their request' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add a customer' })).toBeNull();
  });
});
