import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface GraphQLResponse {
  data?: Record<string, Json> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

const SCOPES = ['write_products', 'write_inventory', 'write_locations', 'write_orders'];

const ADDRESS = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  address1: 'House 12, Street 4, Block 5',
  address2: 'Near Jamia Masjid',
  city: 'khi',
  zip: '75300',
};

const ORDER_FIELDS = `
  id name number stage status confirmationStatus financialStatus fulfillmentStatus
  paymentMethod source phone email note tags cancelReason version createdAt updatedAt
  shippingAddress { name phone city province formatted }
  lineItems { title variantTitle sku quantity unitPrice { formatted } totalPrice { formatted } variantId }
  subtotalPrice { formatted } totalDiscounts { formatted } totalShippingPrice { formatted }
  totalPrice { formatted } amountPaid { formatted } codAmount { formatted }
  location { name }
`;

const ORDER_CREATE = `
  mutation ($input: OrderCreateInput!) {
    orderCreate(input: $input) { order { ${ORDER_FIELDS} } userErrors { field code message } }
  }`;

describe.skipIf(!server)('Admin GraphQL API: orders', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', aReader: '', aNoOrders: '', b: '' };

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
    );
    return token;
  }

  async function gql(
    token: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<GraphQLResponse> {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token },
      payload: { query, variables },
    });
    return response.json() as GraphQLResponse;
  }

  /** Runs a mutation and returns its payload, failing the test on GraphQL errors. */
  async function mutate(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  /** A product with a variant per size at a price, with stock at the primary location. */
  async function stockedVariants(token: string, title: string, sizes: string[], stock: number) {
    const created = await mutate(
      token,
      `mutation ($input: ProductCreateInput!) {
         productCreate(input: $input) {
           product { variants { id inventoryItem { id } } } userErrors { code }
         }
       }`,
      {
        input: {
          title,
          status: 'ACTIVE',
          options: [{ name: 'Size', values: sizes }],
          variants: sizes.map((size) => ({
            optionValues: [size],
            price: '3,499',
            sku: `SKU-${size}`,
          })),
        },
      },
    );
    const variants = created.product.variants as { id: string; inventoryItem: { id: string } }[];
    const location = (await gql(token, '{ location { id } }')).data?.location.id as string;
    const counted = await mutate(
      token,
      `mutation ($input: InventorySetQuantitiesInput!) {
         inventorySetQuantities(input: $input) { userErrors { code } }
       }`,
      {
        input: {
          name: 'available',
          reason: 'received',
          quantities: variants.map((variant) => ({
            inventoryItemId: variant.inventoryItem.id,
            locationId: location,
            quantity: stock,
          })),
        },
      },
    );
    expect(counted.userErrors).toEqual([]);
    return variants.map((variant) => variant.id);
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, SCOPES);
    tokens.aReader = await issueToken(shopA, ['read_orders']);
    tokens.aNoOrders = await issueToken(shopA, ['write_products']);
    tokens.b = await issueToken(shopB, SCOPES);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('places an order, finds it, confirms it and records payment', async () => {
    const [size8, size9] = await stockedVariants(tokens.a, 'Peshawari Chappal', ['8', '9'], 5);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [
          { variantId: size8, quantity: 2 },
          { variantId: size9, quantity: 1, price: '3,000' },
        ],
        shippingAddress: ADDRESS,
        email: 'ayesha@example.com',
        shippingPrice: '250',
        discount: '499',
        tags: ['whatsapp'],
      },
    });
    expect(created.userErrors).toEqual([]);
    const order = created.order;
    expect(order).toMatchObject({
      id: expect.stringMatching(/^ord_/),
      name: '#1001',
      number: 1001,
      stage: 'NEEDS_CONFIRMATION',
      status: 'OPEN',
      confirmationStatus: 'PENDING',
      financialStatus: 'PENDING',
      fulfillmentStatus: 'UNFULFILLED',
      paymentMethod: 'CASH_ON_DELIVERY',
      source: 'API',
      phone: '+923001234567',
      shippingAddress: {
        name: 'Ayesha Khan',
        city: 'Karachi',
        province: 'Sindh',
        formatted: [
          'Ayesha Khan',
          'House 12, Street 4, Block 5',
          'Near Jamia Masjid',
          'Karachi 75300',
          'Sindh',
        ],
      },
      lineItems: [
        {
          title: 'Peshawari Chappal',
          variantTitle: '8',
          sku: 'SKU-8',
          quantity: 2,
          unitPrice: { formatted: 'Rs 3,499' },
          totalPrice: { formatted: 'Rs 6,998' },
          variantId: size8,
        },
        { variantTitle: '9', unitPrice: { formatted: 'Rs 3,000' } },
      ],
      subtotalPrice: { formatted: 'Rs 9,998' },
      totalDiscounts: { formatted: 'Rs 499' },
      totalShippingPrice: { formatted: 'Rs 250' },
      totalPrice: { formatted: 'Rs 9,749' },
      amountPaid: { formatted: 'Rs 0' },
      codAmount: { formatted: 'Rs 9,749' },
      location: { name: 'Main location' },
      createdAt: expect.stringMatching(/Z$/),
    });

    // The stock is committed: size 8 has 3 left to sell.
    const stock = await gql(
      tokens.a,
      `query ($id: ID!) { product(id: $id) { variants { inventoryQuantity } } }`,
      {
        id: (await gql(tokens.a, '{ products(first: 1) { nodes { id } } }')).data?.products.nodes[0]
          .id,
      },
    );
    expect(stock.data?.product.variants).toEqual([
      { inventoryQuantity: 3 },
      { inventoryQuantity: 4 },
    ]);

    const found = await gql(
      tokens.aReader,
      `{ byPhone: orders(first: 5, query: "+92 300 123 4567") { nodes { name } }
         byName: orders(first: 5, query: "ayesha") { nodes { name } }
         waiting: orders(first: 5, stage: NEEDS_CONFIRMATION) { nodes { name } }
         orderStageCounts { stage count } }`,
    );
    expect(found.errors).toBeUndefined();
    expect(found.data?.byPhone.nodes).toEqual([{ name: '#1001' }]);
    expect(found.data?.byName.nodes).toEqual([{ name: '#1001' }]);
    expect(found.data?.waiting.nodes).toEqual([{ name: '#1001' }]);
    expect(found.data?.orderStageCounts).toContainEqual({ stage: 'NEEDS_CONFIRMATION', count: 1 });

    const confirmed = await mutate(
      tokens.a,
      `mutation ($id: ID!) { orderConfirm(id: $id) { order { stage confirmationStatus confirmedAt } userErrors { code } } }`,
      { id: order.id },
    );
    expect(confirmed.order).toMatchObject({
      stage: 'TO_FULFILL',
      confirmationStatus: 'CONFIRMED',
      confirmedAt: expect.any(String),
    });
    const paid = await mutate(
      tokens.a,
      `mutation ($id: ID!) { orderMarkAsPaid(id: $id) { order { financialStatus amountPaid { formatted } paidAt } userErrors { code } } }`,
      { id: order.id },
    );
    expect(paid.order).toMatchObject({
      financialStatus: 'PAID',
      amountPaid: { formatted: 'Rs 9,749' },
      paidAt: expect.any(String),
    });

    const timeline = await gql(
      tokens.aReader,
      `query ($id: ID!) { order(id: $id) { events(first: 2) { nodes { kind message createdAt } pageInfo { hasNextPage } } } }`,
      { id: order.id },
    );
    expect(timeline.data?.order.events).toEqual({
      nodes: [
        {
          kind: 'paid',
          message: 'Marked as paid: Rs 9,749 received',
          createdAt: expect.any(String),
        },
        { kind: 'confirmed', message: 'Confirmed by the customer', createdAt: expect.any(String) },
      ],
      pageInfo: { hasNextPage: true },
    });
  });

  it('cancels an order and releases its stock', async () => {
    const [size] = await stockedVariants(tokens.a, 'Multani Khussa', ['37'], 2);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 2 }], shippingAddress: ADDRESS },
    });
    const soldOut = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 1 }], shippingAddress: ADDRESS },
    });
    expect(soldOut).toEqual({
      order: null,
      userErrors: [
        {
          field: ['input', 'lineItems', '0', 'quantity'],
          code: 'OUT_OF_STOCK',
          message: '"Multani Khussa" is out of stock at Main location',
        },
      ],
    });
    const cancelled = await mutate(
      tokens.a,
      `mutation ($id: ID!) {
         orderCancel(id: $id, reason: CUSTOMER, staffNote: "Ordered by mistake") {
           order { stage status cancelReason cancelledAt } userErrors { code }
         }
       }`,
      { id: created.order.id },
    );
    expect(cancelled.order).toMatchObject({
      stage: 'CANCELLED',
      status: 'CANCELLED',
      cancelReason: 'CUSTOMER',
      cancelledAt: expect.any(String),
    });
    const again = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 2 }], shippingAddress: ADDRESS },
    });
    expect(again.userErrors).toEqual([]);
  });

  it('changes the address and returns user errors for bad input', async () => {
    const [size] = await stockedVariants(tokens.a, 'Lawn Suit', ['S'], 10);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 1 }], shippingAddress: ADDRESS },
    });
    const updated = await mutate(
      tokens.a,
      `mutation ($id: ID!, $input: OrderUpdateInput!) {
         orderUpdate(id: $id, input: $input) { order { phone shippingAddress { city province } note version } userErrors { code } }
       }`,
      {
        id: created.order.id,
        input: {
          shippingAddress: { ...ADDRESS, phone: '0321 7654321', city: 'pindi', zip: null },
          note: 'Leave with the guard',
        },
      },
    );
    expect(updated.order).toEqual({
      phone: '+923217654321',
      shippingAddress: { city: 'Rawalpindi', province: 'Punjab' },
      note: 'Leave with the guard',
      version: 2,
    });
    const invalid = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: size, quantity: 0 }],
        shippingAddress: { ...ADDRESS, phone: '12345' },
      },
    });
    expect(invalid.userErrors).toEqual([
      {
        field: ['input', 'lineItems', '0', 'quantity'],
        code: 'INVALID',
        message: 'Quantity must be a whole number from 1 to 10000',
      },
      {
        field: ['input', 'shippingAddress', 'phone'],
        code: 'INVALID',
        message: 'Phone must be a Pakistani mobile number, like 0300 1234567',
      },
    ]);
  });

  it('needs order scopes, and rejects malformed ids', async () => {
    const write = await gql(
      tokens.aReader,
      `mutation { orderConfirm(id: "ord_${'0'.repeat(26)}") { userErrors { code } } }`,
    );
    expect(write.errors?.[0]?.message).toContain('write_orders');
    const read = await gql(tokens.aNoOrders, '{ orders(first: 1) { nodes { id } } }');
    expect(read.errors?.[0]?.message).toContain('read_orders');
    const malformed = await gql(tokens.a, `{ order(id: "prod_${'0'.repeat(26)}") { id } }`);
    expect(malformed.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    const cursor = await gql(
      tokens.a,
      '{ orders(first: 1, after: "bm90LWpzb24") { nodes { id } } }',
    );
    expect(cursor.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it("never exposes or changes another shop's orders", async () => {
    const [size] = await stockedVariants(tokens.a, 'Private Kurta', ['M'], 3);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 1 }], shippingAddress: ADDRESS },
    });
    const orderId = created.order.id;
    const read = await gql(tokens.b, `query ($id: ID!) { order(id: $id) { id } }`, { id: orderId });
    expect(read).toEqual({ data: { order: null } });
    const list = await gql(tokens.b, '{ orders(first: 10) { nodes { id } } }');
    expect(list.data?.orders.nodes).toEqual([]);

    for (const [name, query] of [
      [
        'orderConfirm',
        `mutation ($id: ID!) { orderConfirm(id: $id) { userErrors { field code } } }`,
      ],
      [
        'orderCancel',
        `mutation ($id: ID!) { orderCancel(id: $id, reason: FRAUD) { userErrors { field code } } }`,
      ],
      [
        'orderMarkAsPaid',
        `mutation ($id: ID!) { orderMarkAsPaid(id: $id) { userErrors { field code } } }`,
      ],
      [
        'orderUpdate',
        `mutation ($id: ID!) { orderUpdate(id: $id, input: { note: "Mine" }) { userErrors { field code } } }`,
      ],
    ] as const) {
      const payload = await mutate(tokens.b, query, { id: orderId });
      expect(payload.userErrors, name).toEqual([{ field: ['id'], code: 'NOT_FOUND' }]);
    }
    const stolen = await mutate(tokens.b, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 1 }], shippingAddress: ADDRESS },
    });
    expect(stolen.userErrors).toMatchObject([
      { field: ['input', 'lineItems', '0', 'variantId'], code: 'NOT_FOUND' },
    ]);
    const own = await gql(tokens.a, `query ($id: ID!) { order(id: $id) { stage note version } }`, {
      id: orderId,
    });
    expect(own.data?.order).toEqual({ stage: 'NEEDS_CONFIRMATION', note: '', version: 1 });
  });
});
