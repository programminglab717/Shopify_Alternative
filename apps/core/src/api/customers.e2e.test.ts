import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface GraphQLResponse {
  data?: Record<string, Json> | null;
  errors?: { message: string; path?: string[]; extensions?: { code?: string } }[];
}

const SCOPES = [
  'write_products',
  'write_inventory',
  'write_locations',
  'write_orders',
  'write_customers',
];

const ADDRESS = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  address1: 'House 12, Street 4, Block 5',
  city: 'khi',
};

const CUSTOMER_FIELDS = `
  id phone name displayName email note tags version
  numberOfOrders amountSpent { formatted } lastOrderAt
  deliveryHistory { delivered returned cancelled inProgress }
  addresses { city formatted }
  orders(first: 5) { nodes { name stage } pageInfo { hasNextPage } }
  blocklistEntry { reason note }
`;

const ORDER_CREATE = `
  mutation ($input: OrderCreateInput!) {
    orderCreate(input: $input) {
      order { id name stage customer { id phone numberOfOrders } }
      userErrors { field code message }
    }
  }`;

describe.skipIf(!server)('Admin GraphQL API: customers and the blocklist', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', aCustomers: '', aOrders: '', b: '' };
  let kurta = '';

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

  /** Runs a query or mutation and returns its first field, failing the test on GraphQL errors. */
  async function call(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  async function placeOrder(address: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const created = await call(tokens.a, ORDER_CREATE, {
      input: {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        shippingAddress: address,
        ...extra,
      },
    });
    expect(created.userErrors).toEqual([]);
    return created.order;
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
    tokens.aCustomers = await issueToken(shopA, ['read_customers']);
    tokens.aOrders = await issueToken(shopA, ['read_orders']);
    tokens.b = await issueToken(shopB, SCOPES);
    api = await startTestApi(testDb);
    app = api.app;

    const created = await call(
      tokens.a,
      `mutation {
         productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,000" }] }) {
           product { variants { id } }
         }
       }`,
    );
    kurta = created.product.variants[0].id;
  });

  beforeEach(async () => {
    await admin.query(`
      DELETE FROM orders.orders;
      DELETE FROM orders.counters;
      DELETE FROM customers.customers;
      DELETE FROM customers.blocklist_entries;`);
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("gives orders their customer, with what the customer's orders add up to", async () => {
    const first = await placeOrder(ADDRESS, { advancePaid: '250' });
    expect(first.customer).toMatchObject({
      id: expect.stringMatching(/^cus_/),
      phone: '+923001234567',
      numberOfOrders: 1,
    });
    const second = await placeOrder({ ...ADDRESS, phone: '+92 300 1234567', city: 'Lahore' });
    expect(second.customer.id).toBe(first.customer.id);
    const cancelled = await call(
      tokens.a,
      `mutation ($id: ID!) { orderCancel(id: $id, reason: CUSTOMER) { userErrors { code } } }`,
      { id: second.id },
    );
    expect(cancelled.userErrors).toEqual([]);
    await placeOrder({ ...ADDRESS, name: 'Bilal Ahmed', phone: '0333 5551234' });

    const customer = await call(
      tokens.a,
      `query ($id: ID!) { customer(id: $id) { ${CUSTOMER_FIELDS} } }`,
      {
        id: first.customer.id,
      },
    );
    expect(customer).toMatchObject({
      phone: '+923001234567',
      name: 'Ayesha Khan',
      displayName: 'Ayesha Khan',
      email: null,
      version: 1,
      numberOfOrders: 2,
      amountSpent: { formatted: 'Rs 250' },
      lastOrderAt: expect.stringMatching(/Z$/),
      deliveryHistory: { delivered: 0, returned: 0, cancelled: 1, inProgress: 1 },
      addresses: [{ city: 'Lahore' }, { city: 'Karachi' }],
      orders: { nodes: [{ name: '#1002', stage: 'CANCELLED' }, { name: '#1001' }] },
      blocklistEntry: null,
    });

    const list = await call(
      tokens.a,
      '{ customers(first: 10) { nodes { name numberOfOrders } pageInfo { hasNextPage } } }',
    );
    expect(list.nodes).toEqual([
      { name: 'Bilal Ahmed', numberOfOrders: 1 },
      { name: 'Ayesha Khan', numberOfOrders: 2 },
    ]);
    const found = await call(tokens.a, '{ customers(first: 5, query: "4567") { nodes { name } } }');
    expect(found.nodes).toEqual([{ name: 'Ayesha Khan' }]);
  });

  it('adds and edits customers', async () => {
    const bad = await call(
      tokens.a,
      `mutation { customerCreate(input: { phone: "042 1234567" }) {
         customer { id } userErrors { field code message } } }`,
    );
    expect(bad).toEqual({
      customer: null,
      userErrors: [
        {
          field: ['input', 'phone'],
          code: 'INVALID',
          message: 'Phone must be a Pakistani mobile number, like 0300 1234567',
        },
      ],
    });

    const created = await call(
      tokens.a,
      `mutation { customerCreate(input: { phone: "0321 7654321", tags: ["wholesale"] }) {
         customer { id phone name displayName tags numberOfOrders } userErrors { code } } }`,
    );
    expect(created).toMatchObject({
      customer: {
        phone: '+923217654321',
        name: null,
        displayName: '0321 7654321',
        tags: ['wholesale'],
        numberOfOrders: 0,
      },
      userErrors: [],
    });
    const taken = await call(
      tokens.a,
      `mutation { customerCreate(input: { phone: "+923217654321" }) { userErrors { field code } } }`,
    );
    expect(taken.userErrors).toEqual([{ field: ['input', 'phone'], code: 'TAKEN' }]);

    const updated = await call(
      tokens.a,
      `mutation ($id: ID!) {
         customerUpdate(id: $id, input: { name: "Fatima Raza", note: "Buys for her boutique" }) {
           customer { name displayName note version } userErrors { code } } }`,
      { id: created.customer.id },
    );
    expect(updated).toEqual({
      customer: {
        name: 'Fatima Raza',
        displayName: 'Fatima Raza',
        note: 'Buys for her boutique',
        version: 2,
      },
      userErrors: [],
    });

    // Her first order finds her by number and leaves her profile as it is.
    const order = await placeOrder({ ...ADDRESS, name: 'F. Raza', phone: '03217654321' });
    expect(order.customer).toEqual({
      id: created.customer.id,
      phone: '+923217654321',
      numberOfOrders: 1,
    });
  });

  it('blocks numbers: their orders wait for staff to review', async () => {
    const added = await call(
      tokens.a,
      `mutation {
         blocklistAdd(input: { phone: "0300 1234567", reason: REFUSED_DELIVERIES, note: "Refused 2" }) {
           blocklistEntry { id phone reason note customer { id } } userErrors { code } } }`,
    );
    expect(added).toMatchObject({
      blocklistEntry: {
        id: expect.stringMatching(/^blk_/),
        phone: '+923001234567',
        reason: 'REFUSED_DELIVERIES',
        note: 'Refused 2',
        customer: null,
      },
      userErrors: [],
    });

    const held = await placeOrder(ADDRESS);
    expect(held.stage).toBe('NEEDS_REVIEW');
    const order = await call(
      tokens.a,
      `query ($id: ID!) { order(id: $id) {
         customer { blocklistEntry { reason } }
         events(first: 5) { nodes { kind message } } } }`,
      { id: held.id },
    );
    expect(order.customer.blocklistEntry).toEqual({ reason: 'REFUSED_DELIVERIES' });
    expect(order.events.nodes[0]).toEqual({
      kind: 'held',
      message:
        'Held for review: 0300 1234567 is on the blocklist for refused deliveries (Refused 2)',
    });

    const blocklist = await call(
      tokens.a,
      '{ blocklist(first: 5, query: "03001234567") { nodes { phone customer { name } } } }',
    );
    expect(blocklist.nodes).toEqual([
      { phone: '+923001234567', customer: { name: 'Ayesha Khan' } },
    ]);

    const confirmed = await call(
      tokens.a,
      `mutation ($id: ID!) { orderConfirm(id: $id) { order { stage } userErrors { code } } }`,
      { id: held.id },
    );
    expect(confirmed).toEqual({ order: { stage: 'TO_FULFILL' }, userErrors: [] });

    const removed = await call(
      tokens.a,
      `mutation { blocklistRemove(phone: "+923001234567") {
         deletedBlocklistEntryId userErrors { code } } }`,
    );
    expect(removed).toEqual({ deletedBlocklistEntryId: added.blocklistEntry.id, userErrors: [] });
    const again = await call(
      tokens.a,
      `mutation { blocklistRemove(phone: "03001234567") {
         deletedBlocklistEntryId userErrors { field code message } } }`,
    );
    expect(again).toEqual({
      deletedBlocklistEntryId: null,
      userErrors: [
        { field: ['phone'], code: 'NOT_FOUND', message: '0300 1234567 is not on the blocklist' },
      ],
    });
    expect((await placeOrder(ADDRESS)).stage).toBe('NEEDS_CONFIRMATION');
  });

  it('needs customer scopes for customers, and order scopes for their orders', async () => {
    const order = await placeOrder(ADDRESS);

    // Orders without customers: the order shows, its customer does not.
    const withoutCustomers = await gql(
      tokens.aOrders,
      `query ($id: ID!) { order(id: $id) { name customer { id } } }`,
      { id: order.id },
    );
    expect(withoutCustomers.data?.order).toEqual({ name: '#1001', customer: null });
    expect(withoutCustomers.errors?.[0]).toMatchObject({
      path: ['order', 'customer'],
      extensions: { code: 'ACCESS_DENIED' },
    });
    expect(
      (await gql(tokens.aOrders, '{ customers(first: 1) { nodes { id } } }')).errors?.[0]?.message,
    ).toContain('read_customers');

    // Customers without orders: profiles show, orders do not; nothing can be changed.
    const profiles = await gql(
      tokens.aCustomers,
      '{ customers(first: 5) { nodes { phone } } blocklist(first: 5) { nodes { id } } }',
    );
    expect(profiles.errors).toBeUndefined();
    expect(profiles.data?.customers.nodes).toEqual([{ phone: '+923001234567' }]);
    const stats = await gql(
      tokens.aCustomers,
      '{ customers(first: 1) { nodes { numberOfOrders } } }',
    );
    expect(stats.errors?.[0]?.message).toContain('read_orders');
    const write = await gql(
      tokens.aCustomers,
      'mutation { blocklistAdd(input: { phone: "03001234567", reason: OTHER }) { userErrors { code } } }',
    );
    expect(write.errors?.[0]?.message).toContain('write_customers');
  });

  it("keeps each shop's customers and blocklist to itself", async () => {
    const order = await placeOrder(ADDRESS);
    await call(
      tokens.a,
      'mutation { blocklistAdd(input: { phone: "03335551234", reason: FRAUD }) { userErrors { code } } }',
    );
    expect(
      await call(tokens.b, 'query ($id: ID!) { customer(id: $id) { id } }', {
        id: order.customer.id,
      }),
    ).toBeNull();
    expect(await call(tokens.b, '{ customers(first: 5) { nodes { id } } }')).toEqual({
      nodes: [],
    });
    expect(await call(tokens.b, '{ blocklist(first: 5) { nodes { id } } }')).toEqual({ nodes: [] });
    const update = await call(
      tokens.b,
      `mutation ($id: ID!) { customerUpdate(id: $id, input: { name: "X" }) { userErrors { code } } }`,
      { id: order.customer.id },
    );
    expect(update.userErrors).toEqual([{ code: 'NOT_FOUND' }]);
    const unblock = await call(
      tokens.b,
      'mutation { blocklistRemove(phone: "03335551234") { userErrors { code } } }',
    );
    expect(unblock.userErrors).toEqual([{ code: 'NOT_FOUND' }]);
  });
});
