import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
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
  address2: 'Gulshan-e-Iqbal',
  landmark: 'Near Jamia Masjid',
  city: 'khi',
  zip: '75300',
};

const ORDER_FIELDS = `
  id name number stage status confirmationStatus financialStatus fulfillmentStatus
  paymentMethod source phone email note tags cancelReason version createdAt updatedAt
  shippingAddress { name phone address2 landmark city province formatted }
  lineItems { title variantTitle sku quantity unitPrice { formatted } totalPrice { formatted } variantId }
  subtotalPrice { formatted } totalDiscounts { formatted } totalShippingPrice { formatted }
  totalPrice { formatted } amountPaid { formatted } codAmount { formatted }
  location { name }
  risk { score level reasons { code message weight } }
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
      // A new key for each request, as a client sends one per thing it means to do.
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
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
        address2: 'Gulshan-e-Iqbal',
        landmark: 'Near Jamia Masjid',
        city: 'Karachi',
        province: 'Sindh',
        formatted: [
          'Ayesha Khan',
          'House 12, Street 4, Block 5',
          'Gulshan-e-Iqbal',
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
      risk: {
        score: 0.1,
        level: 'LOW',
        reasons: [{ code: 'first_order', message: 'First order from this number', weight: 0.1 }],
      },
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
      stage: 'TO_PACK',
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

  it('ships an order, follows its parcels and checks a refused one back in', async () => {
    const [size] = await stockedVariants(tokens.a, 'Sindhi Ajrak', ['One size'], 4);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: size, quantity: 2 }],
        shippingAddress: ADDRESS,
        paymentMethod: 'PREPAID',
      },
    });
    const orderId = created.order.id;
    const lineId = (
      await gql(tokens.a, `query ($id: ID!) { order(id: $id) { lineItems { id } } }`, {
        id: orderId,
      })
    ).data?.order.lineItems[0].id as string;

    const PARCEL = `fulfillment { id status trackingInfo { company number url } location { name }
                      fulfillmentLineItems { lineItem { id } quantity restockedQuantity }
                      shippedAt deliveredAt returnedAt }
                    order { stage status fulfillmentStatus financialStatus
                            lineItems { fulfilledQuantity fulfillableQuantity } }
                    userErrors { field code message }`;
    const first = await mutate(
      tokens.a,
      `mutation ($id: ID!, $input: OrderFulfillInput) { orderFulfill(id: $id, input: $input) { ${PARCEL} } }`,
      {
        id: orderId,
        input: {
          lineItems: [{ id: lineId, quantity: 1 }],
          trackingInfo: { company: 'TCS', number: '779012345678' },
        },
      },
    );
    expect(first).toEqual({
      fulfillment: {
        id: expect.stringMatching(/^ful_/),
        status: 'IN_TRANSIT',
        trackingInfo: { company: 'TCS', number: '779012345678', url: null },
        location: { name: 'Main location' },
        fulfillmentLineItems: [{ lineItem: { id: lineId }, quantity: 1, restockedQuantity: null }],
        shippedAt: expect.any(String),
        deliveredAt: null,
        returnedAt: null,
      },
      order: {
        stage: 'PARTIALLY_FULFILLED',
        status: 'OPEN',
        fulfillmentStatus: 'PARTIALLY_FULFILLED',
        financialStatus: 'PAID',
        lineItems: [{ fulfilledQuantity: 1, fulfillableQuantity: 1 }],
      },
      userErrors: [],
    });
    const second = await mutate(
      tokens.a,
      `mutation ($id: ID!) { orderFulfill(id: $id) { ${PARCEL} } }`,
      { id: orderId },
    );
    expect(second.order.stage).toBe('IN_TRANSIT');

    const delivered = await mutate(
      tokens.a,
      `mutation ($id: ID!) { fulfillmentMarkDelivered(id: $id) { ${PARCEL} } }`,
      { id: first.fulfillment.id },
    );
    expect(delivered.fulfillment).toMatchObject({
      status: 'DELIVERED',
      deliveredAt: expect.any(String),
    });
    const returning = await mutate(
      tokens.a,
      `mutation ($id: ID!) { fulfillmentMarkReturning(id: $id) { ${PARCEL} } }`,
      { id: second.fulfillment.id },
    );
    expect(returning.order.stage).toBe('RETURNING');
    const back = await mutate(
      tokens.a,
      `mutation ($id: ID!, $restock: [FulfillmentRestockInput!]) {
         fulfillmentReceiveReturn(id: $id, restock: $restock) { ${PARCEL} }
       }`,
      { id: second.fulfillment.id, restock: [{ lineItemId: lineId, quantity: 0 }] },
    );
    expect(back.fulfillment).toMatchObject({
      status: 'RETURNED',
      fulfillmentLineItems: [{ quantity: 1, restockedQuantity: 0 }],
      returnedAt: expect.any(String),
    });
    // Prepaid, one parcel delivered: done.
    expect(back.order).toMatchObject({
      stage: 'COMPLETED',
      status: 'CLOSED',
      fulfillmentStatus: 'PARTIALLY_RETURNED',
      lineItems: [{ fulfilledQuantity: 2, fulfillableQuantity: 0 }],
    });

    const tracked = await gql(
      tokens.aReader,
      '{ orders(first: 5, query: "779012345678") { nodes { id } } }',
    );
    expect(tracked.data?.orders.nodes).toEqual([{ id: orderId }]);
    const tracking = await mutate(
      tokens.a,
      `mutation ($id: ID!) {
         fulfillmentTrackingInfoUpdate(id: $id, trackingInfo: { company: "TCS", number: "779012345679", url: "https://www.tcsexpress.com/track" }) { ${PARCEL} }
       }`,
      { id: first.fulfillment.id },
    );
    expect(tracking.fulfillment.trackingInfo).toEqual({
      company: 'TCS',
      number: '779012345679',
      url: 'https://www.tcsexpress.com/track',
    });
    for (const [name, query] of [
      [
        'orderFulfill',
        `mutation ($id: ID!) { orderFulfill(id: $id) { userErrors { field code } } }`,
      ],
      [
        'fulfillmentMarkDelivered',
        `mutation ($id: ID!) { fulfillmentMarkDelivered(id: $id) { userErrors { field code } } }`,
      ],
      [
        'fulfillmentMarkReturning',
        `mutation ($id: ID!) { fulfillmentMarkReturning(id: $id) { userErrors { field code } } }`,
      ],
      [
        'fulfillmentReceiveReturn',
        `mutation ($id: ID!) { fulfillmentReceiveReturn(id: $id) { userErrors { field code } } }`,
      ],
      [
        'fulfillmentTrackingInfoUpdate',
        `mutation ($id: ID!) { fulfillmentTrackingInfoUpdate(id: $id, trackingInfo: { number: "X" }) { userErrors { field code } } }`,
      ],
    ] as const) {
      const id = name === 'orderFulfill' ? orderId : first.fulfillment.id;
      const payload = await mutate(tokens.b, query, { id });
      expect(payload.userErrors, name).toEqual([{ field: ['id'], code: 'NOT_FOUND' }]);
    }
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

  it('scores cash-on-delivery orders and holds risky ones, as the shop sets', async () => {
    const SETTINGS = '{ orderRiskSettings { holdAt highValue { amount formatted } updatedAt } }';
    const UPDATE = `
      mutation ($input: OrderRiskSettingsInput!) {
        orderRiskSettingsUpdate(input: $input) {
          riskSettings { holdAt highValue { formatted } }
          userErrors { field code message }
        }
      }`;
    // Owners and managers set the policy; order scopes are not enough.
    expect((await gql(tokens.a, SETTINGS)).errors?.[0]?.message).toContain('read_settings');
    const denied = await gql(tokens.a, UPDATE, { input: { holdAt: 0.3 } });
    expect(denied.errors?.[0]?.message).toContain('write_settings');

    const settings = await issueToken(shopA, ['write_settings']);
    expect((await gql(settings, SETTINGS)).data?.orderRiskSettings).toEqual({
      holdAt: 0.6,
      highValue: { amount: '15000.00', formatted: 'Rs 15,000' },
      updatedAt: null,
    });
    expect(await mutate(settings, UPDATE, { input: { holdAt: 2 } })).toEqual({
      riskSettings: null,
      userErrors: [
        {
          field: ['input', 'holdAt'],
          code: 'INVALID',
          message: 'Hold at must be from 0.01 to 1, in hundredths',
        },
      ],
    });
    expect(await mutate(settings, UPDATE, { input: { holdAt: 0.3, highValue: '5,000' } })).toEqual({
      riskSettings: { holdAt: 0.3, highValue: { formatted: 'Rs 5,000' } },
      userErrors: [],
    });

    // A first order worth Rs 6,998 from a new number scores 0.3: held.
    const [size] = await stockedVariants(tokens.a, 'Bridal Dupatta', ['Free'], 5);
    const held = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: size, quantity: 2 }],
        shippingAddress: { ...ADDRESS, phone: '0345-7654321' },
      },
    });
    expect(held.order).toMatchObject({
      stage: 'NEEDS_REVIEW',
      confirmationStatus: 'NEEDS_REVIEW',
      risk: {
        score: 0.3,
        level: 'MEDIUM',
        reasons: [
          { code: 'high_value', message: 'High value: Rs 6,998', weight: 0.2 },
          { code: 'first_order', message: 'First order from this number', weight: 0.1 },
        ],
      },
    });
    const medium = await gql(
      tokens.aReader,
      '{ orders(first: 50, riskLevel: MEDIUM) { nodes { id risk { level } } } }',
    );
    const nodes = medium.data?.orders.nodes as { id: string; risk: { level: string } }[];
    expect(nodes.map((node) => node.id)).toContain(held.order.id);
    expect(new Set(nodes.map((node) => node.risk.level))).toEqual(new Set(['MEDIUM']));

    await mutate(settings, UPDATE, { input: { holdAt: 0.6, highValue: '15000' } });
  });

  it('packs orders, and confirms, packs, tags and cancels many at once', async () => {
    const [size] = await stockedVariants(tokens.a, 'Khaddar Shawl', ['Free'], 10);
    const ids: string[] = [];
    for (const name of ['Ayesha Khan', 'Bilal Ahmed', 'Sana Tariq']) {
      const created = await mutate(tokens.a, ORDER_CREATE, {
        input: {
          lineItems: [{ variantId: size, quantity: 1 }],
          shippingAddress: { ...ADDRESS, name },
        },
      });
      ids.push(created.order.id as string);
    }
    const [first, second, third] = ids as [string, string, string];
    const PACK = `
      mutation ($id: ID!) {
        orderMarkPacked(id: $id) { order { stage packedAt } userErrors { field code message } }
      }`;
    expect(await mutate(tokens.a, PACK, { id: first })).toEqual({
      order: null,
      userErrors: [
        { field: ['id'], code: 'INVALID', message: 'Only confirmed or paid orders can be packed' },
      ],
    });

    const bulk = (name: string, args = '') => `
      mutation ($ids: [ID!]!) {
        ${name}(ids: $ids${args}) {
          orders { id stage tags } userErrors { field code message }
        }
      }`;
    const stages = (payload: Json) => payload.orders.map((order: Json) => order.stage) as string[];
    const missing = `ord_${'0'.repeat(26)}`;
    const confirmed = await mutate(tokens.a, bulk('orderBulkConfirm'), { ids: [...ids, missing] });
    expect(stages(confirmed)).toEqual(['TO_PACK', 'TO_PACK', 'TO_PACK']);
    expect(confirmed.userErrors).toEqual([
      { field: ['ids', '3'], code: 'NOT_FOUND', message: 'Order not found' },
    ]);

    expect(await mutate(tokens.a, PACK, { id: first })).toEqual({
      order: { stage: 'TO_BOOK', packedAt: expect.any(String) },
      userErrors: [],
    });
    const packed = await mutate(tokens.a, bulk('orderBulkMarkPacked'), { ids: [second, third] });
    expect(stages(packed)).toEqual(['TO_BOOK', 'TO_BOOK']);
    const toBook = await gql(
      tokens.aReader,
      '{ orders(first: 50, stage: TO_BOOK) { nodes { id } } }',
    );
    expect(toBook.data?.orders.nodes.map((node: Json) => node.id)).toEqual([third, second, first]);
    const unpacked = await mutate(
      tokens.a,
      `mutation ($id: ID!) {
         orderMarkUnpacked(id: $id) { order { stage packedAt } userErrors { code } }
       }`,
      { id: third },
    );
    expect(unpacked).toEqual({ order: { stage: 'TO_PACK', packedAt: null }, userErrors: [] });

    const tagged = await mutate(tokens.a, bulk('orderBulkAddTags', ', tags: ["eid", "tcs"]'), {
      ids,
    });
    expect(tagged.orders.map((order: Json) => order.tags)).toEqual([
      ['eid', 'tcs'],
      ['eid', 'tcs'],
      ['eid', 'tcs'],
    ]);
    const untagged = await mutate(tokens.a, bulk('orderBulkRemoveTags', ', tags: ["EID"]'), {
      ids: [first],
    });
    expect(untagged.orders[0].tags).toEqual(['tcs']);

    // Another shop's orders are not found, and stay as they are.
    const elsewhere = await mutate(tokens.b, bulk('orderBulkCancel', ', reason: FRAUD'), { ids });
    expect(elsewhere).toEqual({
      orders: [],
      userErrors: ids.map((_, index) => ({
        field: ['ids', String(index)],
        code: 'NOT_FOUND',
        message: 'Order not found',
      })),
    });
    const cancelled = await mutate(
      tokens.a,
      bulk('orderBulkCancel', ', reason: NO_RESPONSE, staffNote: "Unreachable for two days"'),
      { ids },
    );
    expect(stages(cancelled)).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);

    expect((await mutate(tokens.a, bulk('orderBulkConfirm'), { ids: [] })).userErrors).toEqual([
      { field: ['ids'], code: 'BLANK', message: 'Ids must include at least one' },
    ]);
    const denied = await gql(tokens.aReader, bulk('orderBulkConfirm'), { ids });
    expect(denied.errors?.[0]?.message).toContain('write_orders');
  });

  it('prints packing slips and invoices for the orders asked for', async () => {
    const [size] = await stockedVariants(tokens.a, 'Kohati Chappal', ['9'], 5);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 2 }], shippingAddress: ADDRESS },
    });
    const id = created.order.id as string;
    const DOCUMENT = `
      query ($ids: [ID!]!, $kind: OrderDocumentKind!, $paper: PaperSize, $language: DocumentLanguage) {
        orderDocument(ids: $ids, kind: $kind, paper: $paper, language: $language) {
          html title fileName orders { id name }
        }
      }`;
    const slip = await gql(tokens.aReader, DOCUMENT, { ids: [id], kind: 'PACKING_SLIP' });
    const document = slip.data?.orderDocument;
    expect(document).toMatchObject({
      title: `Packing slip ${created.order.name}`,
      fileName: `packing-slip-${created.order.number}.html`,
      orders: [{ id, name: created.order.name }],
    });
    // A4 and both languages unless asked otherwise.
    expect(document.html).toMatch(/<html\s+lang="en"\s+dir="ltr"\s+data-paper="a4"/);
    expect(document.html).toContain('<span lang="ur" dir="rtl">پیکنگ سلپ</span>');
    expect(document.html).toContain('Rs 6,998');

    const invoice = await gql(tokens.a, DOCUMENT, {
      ids: [id],
      kind: 'INVOICE',
      paper: 'THERMAL_80MM',
      language: 'URDU',
    });
    expect(invoice.data?.orderDocument.html).toMatch(
      /<html\s+lang="ur"\s+dir="rtl"\s+data-paper="thermal_80mm"/,
    );
    expect(invoice.data?.orderDocument.html).toContain('انوائس');

    // Another shop's orders are left out; bad input is refused.
    const elsewhere = await gql(tokens.b, DOCUMENT, { ids: [id], kind: 'INVOICE' });
    expect(elsewhere.data?.orderDocument.orders).toEqual([]);
    const empty = await gql(tokens.a, DOCUMENT, { ids: [], kind: 'INVOICE' });
    expect(empty.errors?.[0]).toMatchObject({
      message: 'Ids must include at least one',
      extensions: { code: 'BAD_USER_INPUT' },
    });
    const malformed = await gql(tokens.a, DOCUMENT, { ids: ['ord_1'], kind: 'INVOICE' });
    expect(malformed.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    const denied = await gql(tokens.aNoOrders, DOCUMENT, { ids: [id], kind: 'INVOICE' });
    expect(denied.errors?.[0]?.message).toContain('read_orders');
  });

  it('records refunds, up to what was paid', async () => {
    const [size] = await stockedVariants(tokens.a, 'Silk Dupatta', ['Free'], 3);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: size, quantity: 1 }],
        shippingAddress: ADDRESS,
        paymentMethod: 'PREPAID',
      },
    });
    const id = created.order.id as string;
    const REFUND = `
      mutation ($id: ID!, $input: OrderRefundInput!) {
        orderRefund(id: $id, input: $input) {
          refund { id amount { formatted } method reference note createdAt }
          order {
            financialStatus amountPaid { formatted } amountRefunded { formatted } refunds { id }
          }
          userErrors { field code message }
        }
      }`;
    const refunded = await mutate(tokens.a, REFUND, {
      id,
      input: {
        amount: '1,000',
        method: 'BANK_TRANSFER',
        reference: 'IBFT-1',
        note: 'Faded colour',
      },
    });
    expect(refunded).toEqual({
      refund: {
        id: expect.stringMatching(/^rfd_/),
        amount: { formatted: 'Rs 1,000' },
        method: 'BANK_TRANSFER',
        reference: 'IBFT-1',
        note: 'Faded colour',
        createdAt: expect.any(String),
      },
      order: {
        financialStatus: 'PARTIALLY_REFUNDED',
        amountPaid: { formatted: 'Rs 3,499' },
        amountRefunded: { formatted: 'Rs 1,000' },
        refunds: [{ id: refunded.refund.id }],
      },
      userErrors: [],
    });
    expect(
      await mutate(tokens.a, REFUND, { id, input: { amount: '5000', method: 'CASH' } }),
    ).toEqual({
      refund: null,
      order: null,
      userErrors: [
        {
          field: ['input', 'amount'],
          code: 'INVALID',
          message: 'A refund can be at most Rs 2,499: what was paid and not refunded yet',
        },
      ],
    });
    const elsewhere = await mutate(tokens.b, REFUND, {
      id,
      input: { amount: '1', method: 'CASH' },
    });
    expect(elsewhere.userErrors).toEqual([
      { field: ['id'], code: 'NOT_FOUND', message: 'Order not found' },
    ]);
    const denied = await gql(tokens.aReader, REFUND, {
      id,
      input: { amount: '1', method: 'CASH' },
    });
    expect(denied.errors?.[0]?.message).toContain('write_orders');
  });

  it('exports orders as CSV for whoever can read them, and filters by when they were placed', async () => {
    const [size] = await stockedVariants(tokens.a, 'Ralli Quilt', ['Queen'], 5);
    const created = await mutate(tokens.a, ORDER_CREATE, {
      input: { lineItems: [{ variantId: size, quantity: 2 }], shippingAddress: ADDRESS },
    });
    const EXPORT = `
      mutation ($query: String, $layout: OrderExportLayout, $placedFrom: DateTime) {
        ordersExport(query: $query, layout: $layout, placedFrom: $placedFrom) {
          csv rowCount userErrors { field code message }
        }
      }`;
    // Reading orders is enough, as it is to see them.
    const exported = await mutate(tokens.aReader, EXPORT, { query: created.order.name });
    expect(exported).toMatchObject({ rowCount: 1, userErrors: [] });
    const [header, row] = (exported.csv as string).split('\r\n');
    expect(header).toMatch(/^\uFEFFOrder,Order ID,Placed,Stage,/);
    expect(row).toContain(`${created.order.name},${created.order.id},`);
    expect(row).toContain(',2 × Ralli Quilt (Queen),2,');

    const lines = await mutate(tokens.aReader, EXPORT, {
      query: created.order.name,
      layout: 'LINE_ITEMS',
    });
    expect(lines.rowCount).toBe(1);
    expect(lines.csv).toContain(',1,Ralli Quilt,Queen,SKU-Queen,2,3499.00,6998.00,0,');

    const later = await mutate(tokens.aReader, EXPORT, {
      query: created.order.name,
      placedFrom: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(later.rowCount).toBe(0);
    const listed = await gql(
      tokens.aReader,
      'query ($before: DateTime) { orders(first: 5, placedBefore: $before) { nodes { id } } }',
      { before: '2020-01-01T00:00:00Z' },
    );
    expect(listed.data?.orders.nodes).toEqual([]);

    const elsewhere = await mutate(tokens.b, EXPORT, { query: created.order.name });
    expect(elsewhere.rowCount).toBe(0);
    const denied = await gql(tokens.aNoOrders, EXPORT, {});
    expect(denied.errors?.[0]?.message).toContain('read_orders');
  });
});
