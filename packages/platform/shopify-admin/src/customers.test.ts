import { describe, expect, it } from 'vitest';
import { ShopifyAdmin } from './admin.js';
import { readStoreCustomers, storeCustomersCsv } from './customers.js';

const LINES = [
  {
    id: 'gid://shopify/Customer/1',
    firstName: 'Ayesha',
    lastName: 'Khan',
    note: 'Prefers evening delivery',
    tags: ['vip', 'lahore'],
    defaultEmailAddress: { emailAddress: 'ayesha@example.pk', marketingState: 'SUBSCRIBED' },
    defaultPhoneNumber: { phoneNumber: '+923001234567', marketingState: 'UNSUBSCRIBED' },
    defaultAddress: {
      id: 'gid://shopify/MailingAddress/12?model_name=CustomerAddress',
      phone: '+923211234567',
    },
  },
  {
    id: 'gid://shopify/MailingAddress/11?model_name=CustomerAddress',
    firstName: 'Ayesha',
    lastName: 'Khan',
    phone: null,
    address1: 'House 4, Street 2',
    address2: '',
    city: 'Karachi',
    province: 'Sindh',
    zip: '75500',
    countryCodeV2: 'PK',
    __parentId: 'gid://shopify/Customer/1',
  },
  {
    id: 'gid://shopify/MailingAddress/12?model_name=CustomerAddress',
    firstName: 'Ayesha',
    lastName: null,
    phone: '+923211234567',
    address1: 'House 12, Street 4',
    address2: 'Gulberg',
    city: 'Lahore',
    province: 'Punjab',
    zip: null,
    countryCodeV2: 'PK',
    __parentId: 'gid://shopify/Customer/1',
  },
  {
    id: 'gid://shopify/Customer/2',
    firstName: null,
    lastName: null,
    note: null,
    tags: [],
    defaultEmailAddress: null,
    defaultPhoneNumber: null,
    defaultAddress: { phone: '0333 7654321' },
  },
  {
    id: 'gid://shopify/Customer/3',
    firstName: 'Bilal',
    lastName: '',
    note: null,
    tags: [],
    defaultEmailAddress: { emailAddress: 'bilal@example.pk', marketingState: 'NOT_SUBSCRIBED' },
    defaultPhoneNumber: null,
    defaultAddress: null,
  },
  // The address of a customer with no number, left out with them.
  {
    id: 'gid://shopify/MailingAddress/31',
    address1: 'Somewhere',
    city: 'Multan',
    __parentId: 'gid://shopify/Customer/3',
  },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

const store = (failed?: string) =>
  new ShopifyAdmin({
    shop: 'zari-kurtas.myshopify.com',
    credentials: { accessToken: 't' },
    fetch: (async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://storage.googleapis.com/')) return new Response(LINES);
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      const data = query.includes('shop {')
        ? { shop: { name: 'Zari Kurtas' } }
        : query.includes('bulkOperationRunQuery')
          ? {
              bulkOperationRunQuery: {
                bulkOperation: { id: 'b', status: 'CREATED' },
                userErrors: [],
              },
            }
          : failed
            ? { node: { id: 'b', status: 'FAILED', errorCode: failed } }
            : { node: { id: 'b', status: 'COMPLETED', url: 'https://storage.googleapis.com/b' } };
      return new Response(JSON.stringify({ data }));
    }) as typeof fetch,
  });

describe("A store's customers through its Admin API (ADR-755)", () => {
  it('reads those with a number, their own or their address’s, and counts those without', async () => {
    const read = await readStoreCustomers(store(), { sleep: async () => {} });
    expect(read).toMatchObject({ ok: true, value: { storeName: 'Zari Kurtas', withoutPhone: 1 } });
    const customers = read.ok ? read.value.customers : [];
    expect(customers).toEqual([
      {
        firstName: 'Ayesha',
        lastName: 'Khan',
        email: 'ayesha@example.pk',
        phone: '+923001234567',
        emailMarketing: 'SUBSCRIBED',
        smsMarketing: 'UNSUBSCRIBED',
        note: 'Prefers evening delivery',
        tags: ['vip', 'lahore'],
        // Its addresses, the default first (ADR-784).
        addresses: [
          {
            name: 'Ayesha',
            phone: '+923211234567',
            address1: 'House 12, Street 4',
            address2: 'Gulberg',
            city: 'Lahore',
            province: 'Punjab',
            zip: null,
            countryCode: 'PK',
            isDefault: true,
          },
          {
            name: 'Ayesha Khan',
            phone: null,
            address1: 'House 4, Street 2',
            address2: null,
            city: 'Karachi',
            province: 'Sindh',
            zip: '75500',
            countryCode: 'PK',
            isDefault: false,
          },
        ],
      },
      {
        firstName: null,
        lastName: null,
        email: null,
        phone: '0333 7654321',
        emailMarketing: null,
        smsMarketing: null,
        note: null,
        tags: [],
        addresses: [],
      },
    ]);
    // As Shopify's customer export writes them, each row named for its errors.
    expect(storeCustomersCsv(customers)).toEqual({
      csv:
        '"First Name","Last Name","Email","Accepts Email Marketing","Phone","Accepts SMS Marketing","Note","Tags"\r\n' +
        '"Ayesha","Khan","ayesha@example.pk","yes","+923001234567","unsubscribed","Prefers evening delivery","vip, lahore"\r\n' +
        '"","","","","0333 7654321","","",""\r\n',
      rowNames: ['Ayesha Khan', '0333 7654321'],
    });
  });

  it('says what the app needs when Shopify refuses', async () => {
    expect(await readStoreCustomers(store('ACCESS_DENIED'), { sleep: async () => {} })).toEqual({
      ok: false,
      kind: 'scope',
      message:
        "The store's app may not read its customers: give it the read_customers access scope, " +
        "and in its settings the access to customers' names, emails, phones and addresses",
    });
  });
});
