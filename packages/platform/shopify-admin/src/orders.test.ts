import { describe, expect, it } from 'vitest';
import { ShopifyAdmin } from './admin.js';
import { hundredthsOf, readStoreOrders } from './orders.js';

const LINES = [
  {
    id: 'gid://shopify/Order/1',
    name: '#1001',
    createdAt: '2025-03-20T09:00:00Z',
    cancelledAt: null,
    currencyCode: 'PKR',
    email: 'ayesha@example.pk',
    phone: null,
    note: 'Leave with the guard',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    customer: { defaultPhoneNumber: { phoneNumber: '+923001234567' } },
    shippingAddress: {
      name: 'Ayesha Khan',
      phone: '0300 1234567',
      address1: 'House 12, Street 4',
      address2: '',
      city: 'Lahore',
      province: 'Punjab',
      zip: '54000',
      countryCodeV2: 'PK',
    },
    subtotalPriceSet: { shopMoney: { amount: '9000.0' } },
    totalShippingPriceSet: { shopMoney: { amount: '250.0' } },
    totalDiscountsSet: { shopMoney: { amount: '500.5' } },
    totalPriceSet: { shopMoney: { amount: '8749.5' } },
  },
  {
    id: 'gid://shopify/LineItem/11',
    title: 'Lawn suit',
    variantTitle: 'M',
    sku: 'LAWN-M',
    quantity: 2,
    originalUnitPriceSet: { shopMoney: { amount: '4500.00' } },
    __parentId: 'gid://shopify/Order/1',
  },
  {
    id: 'gid://shopify/Order/2',
    name: '#1002',
    createdAt: '2025-04-01T09:00:00Z',
    cancelledAt: '2025-04-02T09:00:00Z',
    currencyCode: 'PKR',
    email: null,
    phone: null,
    note: null,
    displayFinancialStatus: 'REFUNDED',
    displayFulfillmentStatus: 'UNFULFILLED',
    customer: null,
    shippingAddress: null,
    subtotalPriceSet: { shopMoney: { amount: '0.0' } },
    totalShippingPriceSet: { shopMoney: { amount: '0.0' } },
    totalDiscountsSet: { shopMoney: { amount: '0.0' } },
    totalPriceSet: { shopMoney: { amount: '0.0' } },
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

describe("A store's orders through its Admin API (ADR-786)", () => {
  it('reads each order with its items, amounts in hundredths, and its customer’s number where it has none', async () => {
    const read = await readStoreOrders(store(), { sleep: async () => {} });
    expect(read).toMatchObject({ ok: true, value: { storeName: 'Zari Kurtas' } });
    const orders = read.ok ? read.value.orders : [];
    expect(orders[0]).toEqual({
      id: 'gid://shopify/Order/1',
      name: '#1001',
      phone: '+923001234567',
      email: 'ayesha@example.pk',
      placedAt: '2025-03-20T09:00:00Z',
      cancelledAt: null,
      currency: 'PKR',
      subtotal: 900_000n,
      shipping: 25_000n,
      discounts: 50_050n,
      total: 874_950n,
      financialStatus: 'PAID',
      fulfillmentStatus: 'FULFILLED',
      note: 'Leave with the guard',
      shippingAddress: {
        name: 'Ayesha Khan',
        phone: '0300 1234567',
        address1: 'House 12, Street 4',
        address2: null,
        city: 'Lahore',
        province: 'Punjab',
        zip: '54000',
        countryCode: 'PK',
      },
      lines: [
        { title: 'Lawn suit', variantTitle: 'M', sku: 'LAWN-M', quantity: 2, price: 450_000n },
      ],
    });
    expect(orders[1]).toMatchObject({
      name: '#1002',
      phone: null,
      note: '',
      cancelledAt: '2025-04-02T09:00:00Z',
      shippingAddress: null,
      lines: [],
    });
  });

  it('says the scopes the app needs when Shopify refuses', async () => {
    expect(await readStoreOrders(store('ACCESS_DENIED'), { sleep: async () => {} })).toMatchObject({
      ok: false,
      kind: 'scope',
      message: expect.stringContaining('read_all_orders') as unknown,
    });
  });

  it('reads amounts as Shopify writes them, in hundredths', () => {
    expect(hundredthsOf('4500.0')).toBe(450_000n);
    expect(hundredthsOf('0.05')).toBe(5n);
    expect(hundredthsOf('12')).toBe(1_200n);
    expect(hundredthsOf('-3.5')).toBe(-350n);
    expect(hundredthsOf('abc')).toBe(0n);
    expect(hundredthsOf(null)).toBe(0n);
  });
});
