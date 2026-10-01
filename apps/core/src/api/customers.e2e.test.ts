import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
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
      // A new key for each request, as a client sends one per thing it means to do.
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
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
      DELETE FROM customers.consent_events;
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
      message: 'Held for review: the number is on the blocklist for refused deliveries (Refused 2)',
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
    expect(confirmed).toEqual({ order: { stage: 'TO_PACK' }, userErrors: [] });

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

  it('records marketing consent per channel, with its history', async () => {
    const created = await call(
      tokens.a,
      `mutation {
         customerCreate(input: {
           phone: "0300 1234567"
           email: "ayesha@example.com"
           marketingConsent: [
             { channel: WHATSAPP, marketingState: SUBSCRIBED, wording: "Send me offers on WhatsApp" }
           ]
         }) {
           customer {
             id
             whatsappMarketingConsent { marketingState consentUpdatedAt }
             emailMarketingConsent { marketingState consentUpdatedAt }
           }
           userErrors { field code message }
         }
       }`,
    );
    expect(created).toMatchObject({
      customer: {
        whatsappMarketingConsent: {
          marketingState: 'SUBSCRIBED',
          consentUpdatedAt: expect.stringMatching(/Z$/),
        },
        emailMarketingConsent: { marketingState: 'NOT_SUBSCRIBED', consentUpdatedAt: null },
      },
      userErrors: [],
    });
    const id = created.customer.id as string;

    const updated = await call(
      tokens.a,
      `mutation ($id: ID!, $consent: [MarketingConsentInput!]!) {
         customerMarketingConsentUpdate(id: $id, marketingConsent: $consent) {
           customer {
             smsMarketingConsent { marketingState }
             emailMarketingConsent { marketingState consentUpdatedAt }
             consentHistory(first: 5) {
               nodes { id channel marketingState source wording contact collectedAt recordedAt }
             }
           }
           userErrors { field code message }
         }
       }`,
      {
        id,
        consent: [
          {
            channel: 'EMAIL',
            marketingState: 'SUBSCRIBED',
            wording: 'Email me new arrivals',
            source: 'IMPORT',
            collectedAt: '2026-09-01T10:00:00.000Z',
          },
          { channel: 'SMS', marketingState: 'UNSUBSCRIBED' },
        ],
      },
    );
    expect(updated.userErrors).toEqual([]);
    expect(updated.customer).toMatchObject({
      smsMarketingConsent: { marketingState: 'UNSUBSCRIBED' },
      emailMarketingConsent: {
        marketingState: 'SUBSCRIBED',
        consentUpdatedAt: '2026-09-01T10:00:00.000Z',
      },
    });
    expect(updated.customer.consentHistory.nodes).toMatchObject([
      { channel: 'SMS', marketingState: 'UNSUBSCRIBED', source: 'API', contact: '+923001234567' },
      {
        id: expect.stringMatching(/^cev_/),
        channel: 'EMAIL',
        marketingState: 'SUBSCRIBED',
        source: 'IMPORT',
        wording: 'Email me new arrivals',
        contact: 'ayesha@example.com',
        collectedAt: '2026-09-01T10:00:00.000Z',
      },
      { channel: 'WHATSAPP', source: 'API', wording: 'Send me offers on WhatsApp' },
    ]);

    const unworded = await call(
      tokens.a,
      `mutation ($id: ID!) {
         customerMarketingConsentUpdate(id: $id, marketingConsent: [{ channel: SMS, marketingState: SUBSCRIBED }]) {
           userErrors { field code message }
         }
       }`,
      { id },
    );
    expect(unworded.userErrors).toEqual([
      {
        field: ['marketingConsent', '0', 'wording'],
        code: 'BLANK',
        message: "Wording can't be blank",
      },
    ]);
    const viewer = await gql(
      tokens.aCustomers,
      `mutation ($id: ID!) {
         customerMarketingConsentUpdate(id: $id, marketingConsent: [{ channel: SMS, marketingState: UNSUBSCRIBED }]) {
           userErrors { code }
         }
       }`,
      { id },
    );
    expect(viewer.errors?.[0]?.message).toContain('write_customers');
  });

  it('imports customers from CSV and exports them again', async () => {
    const file = [
      'Phone,Name,Tags,WhatsApp marketing',
      '0300 1234567,Ayesha Khan,"vip, eid",subscribed',
      '0333 5551234,Bilal Ahmed,,',
      '12345,Nobody,,',
    ].join('\n');
    const IMPORT = `
      mutation ($csv: String!, $dryRun: Boolean) {
        customersImport(csv: $csv, dryRun: $dryRun) {
          rows created updated skipped rowErrorCount dryRun
          rowErrors { row column message }
          userErrors { field code message }
        }
      }`;
    const dry = await call(tokens.a, IMPORT, { csv: file, dryRun: true });
    expect(dry).toMatchObject({ created: 2, dryRun: true });
    expect(await call(tokens.a, '{ customers(first: 5) { nodes { id } } }')).toEqual({ nodes: [] });

    const imported = await call(tokens.a, IMPORT, { csv: file });
    expect(imported).toEqual({
      rows: 3,
      created: 2,
      updated: 0,
      skipped: 0,
      rowErrorCount: 1,
      dryRun: false,
      rowErrors: [
        {
          row: 4,
          column: 'Phone',
          message: '"12345" is not a Pakistani mobile number, like 0300 1234567',
        },
      ],
      userErrors: [],
    });

    const exported = await call(
      tokens.a,
      `mutation { customersExport(query: "whatsapp_subscription_status = subscribed") {
         csv rowCount userErrors { field code message } } }`,
    );
    expect(exported).toMatchObject({ rowCount: 1, userErrors: [] });
    const lines = (exported.csv as string).replace('\uFEFF', '').trim().split('\r\n');
    expect(lines[0]).toContain(
      'Customer ID,Phone,Other phones,Name,Email,Tags,Note,WhatsApp marketing',
    );
    expect(lines[0]).toContain('Orders,Amount spent');
    expect(lines[1]).toContain('0300 1234567,,Ayesha Khan,,"vip, eid",,subscribed');

    const bad = await call(
      tokens.a,
      'mutation { customersExport(query: "orders > 1") { csv userErrors { field code } } }',
    );
    expect(bad).toEqual({ csv: null, userErrors: [{ field: ['query'], code: 'INVALID' }] });
    // Exports are for owners and managers: seeing customers is not enough.
    const denied = await gql(tokens.aCustomers, 'mutation { customersExport { rowCount } }');
    expect(denied.errors?.[0]?.message).toContain('write_customers');
  });

  it('merges duplicates, and erases a customer at their request', async () => {
    const MERGE = `
      mutation ($customerId: ID!, $duplicateId: ID!) {
        customerMerge(customerId: $customerId, duplicateId: $duplicateId) {
          customer {
            id phone otherPhones name numberOfOrders orders(first: 5) { nodes { name } }
          }
          userErrors { field code message }
        }
      }`;
    const ERASE = `
      mutation ($id: ID!) {
        customerErase(id: $id) { erasedCustomerId userErrors { field code message } }
      }`;
    const first = await placeOrder(ADDRESS);
    const second = await placeOrder({ ...ADDRESS, name: 'Ayesha K.', phone: '0311 1234567' });
    const ids = { customerId: first.customer.id, duplicateId: second.customer.id };

    // Merging and erasing change customers.
    const denied = await gql(tokens.aCustomers, MERGE, ids);
    expect(denied.errors?.[0]?.message).toContain('write_customers');

    expect(await call(tokens.a, MERGE, ids)).toEqual({
      customer: {
        id: first.customer.id,
        phone: '+923001234567',
        otherPhones: ['+923111234567'],
        name: 'Ayesha Khan',
        numberOfOrders: 2,
        orders: { nodes: [{ name: '#1002' }, { name: '#1001' }] },
      },
      userErrors: [],
    });
    const gone = await gql(tokens.a, 'query ($id: ID!) { customer(id: $id) { id } }', {
      id: second.customer.id,
    });
    expect(gone.data?.customer).toBeNull();
    // Another shop cannot erase them.
    expect((await call(tokens.b, ERASE, { id: first.customer.id })).userErrors).toMatchObject([
      { field: ['id'], code: 'NOT_FOUND' },
    ]);

    // Erasure waits until their orders are closed or cancelled.
    expect(await call(tokens.a, ERASE, { id: first.customer.id })).toEqual({
      erasedCustomerId: null,
      userErrors: [
        {
          field: ['id'],
          code: 'IN_USE',
          message: 'Their orders must be closed or cancelled first; still open: #1001, #1002',
        },
      ],
    });
    for (const order of [first, second]) {
      const cancelled = await call(
        tokens.a,
        'mutation ($id: ID!) { orderCancel(id: $id, reason: CUSTOMER) { userErrors { code } } }',
        { id: order.id },
      );
      expect(cancelled.userErrors).toEqual([]);
    }
    expect(await call(tokens.a, ERASE, { id: first.customer.id })).toEqual({
      erasedCustomerId: first.customer.id,
      userErrors: [],
    });
    const order = await call(
      tokens.a,
      `query ($id: ID!) {
         order(id: $id) {
           phone email customerErasedAt customer { id }
           shippingAddress { name phone address1 city province formatted }
           events(first: 1) { nodes { kind message } }
         }
       }`,
      { id: first.id },
    );
    expect(order).toEqual({
      phone: null,
      email: null,
      customerErasedAt: expect.any(String),
      customer: null,
      shippingAddress: {
        name: null,
        phone: null,
        address1: null,
        city: 'Karachi',
        province: 'Sindh',
        formatted: ['Karachi', 'Sindh'],
      },
      events: {
        nodes: [{ kind: 'erased', message: "The customer's details were erased at their request" }],
      },
    });
  });

  it("asks for a customer's erasure in ten days, which the shop can cancel until then", async () => {
    const REQUEST = `mutation ($id: ID!) {
      customerErasureRequest(id: $id) { erasureScheduledAt userErrors { field code message } }
    }`;
    const CANCEL = `mutation ($id: ID!) {
      customerErasureCancel(id: $id) { customerId userErrors { field code message } }
    }`;
    const SCHEDULED = 'query ($id: ID!) { customer(id: $id) { erasureScheduledAt } }';
    const created = await call(
      tokens.a,
      'mutation { customerCreate(input: { phone: "0345 7654321", name: "Hina" }) { customer { id } } }',
    );
    const id = created.customer.id as string;
    // Asking changes customers; reading them shows when.
    const denied = await gql(tokens.aCustomers, REQUEST, { id });
    expect(denied.errors?.[0]?.message).toContain('write_customers');
    const asked = await call(tokens.a, REQUEST, { id });
    expect(asked.userErrors).toEqual([]);
    const wait = new Date(asked.erasureScheduledAt as string).getTime() - Date.now();
    expect(wait).toBeGreaterThan(9.9 * 86_400_000);
    expect(wait).toBeLessThan(10.1 * 86_400_000);
    expect(await call(tokens.aCustomers, SCHEDULED, { id })).toEqual({
      erasureScheduledAt: asked.erasureScheduledAt,
    });

    // Another shop can't cancel it; this one can, once.
    expect((await call(tokens.b, CANCEL, { id })).userErrors).toMatchObject([
      { field: ['id'], code: 'NOT_FOUND' },
    ]);
    expect(await call(tokens.a, CANCEL, { id })).toEqual({ customerId: id, userErrors: [] });
    expect(await call(tokens.aCustomers, SCHEDULED, { id })).toEqual({ erasureScheduledAt: null });
    expect((await call(tokens.a, CANCEL, { id })).userErrors).toMatchObject([
      { field: ['id'], code: 'INVALID' },
    ]);
  });

  it('gives a customer their own data as a file, at their request', async () => {
    const EXPORT = `
      mutation ($id: ID!) {
        customerDataExport(id: $id) { fileName json userErrors { field code message } }
      }`;
    const order = await placeOrder(ADDRESS, { email: 'ayesha@example.com', note: 'Ring twice' });
    const id = order.customer.id as string;

    // It holds their orders, so it takes the orders' scope as well as the customers'.
    const customersOnly = await issueToken(shopA, ['write_customers']);
    expect((await gql(customersOnly, EXPORT, { id })).errors?.[0]?.message).toContain(
      'read_orders',
    );
    expect((await gql(tokens.aCustomers, EXPORT, { id })).errors?.[0]?.message).toContain(
      'write_customers',
    );

    const exported = await call(tokens.a, EXPORT, { id });
    expect(exported).toMatchObject({ fileName: `customer-${id}.json`, userErrors: [] });
    expect(JSON.parse(exported.json as string)).toMatchObject({
      format: 'hatti.customer-data/1',
      customer: { id, name: 'Ayesha Khan', phone: '+923001234567', email: 'ayesha@example.com' },
      consentHistory: [],
      orders: [
        {
          id: order.id,
          name: '#1001',
          lineItems: [{ title: 'Kurta', quantity: 1, unitPrice: '2000.00' }],
          note: 'Ring twice',
          shippingAddress: { name: 'Ayesha Khan', city: 'Karachi' },
        },
      ],
      draftOrders: [],
      discountCodeUses: [],
    });
    const { rows } = await admin.query<{ action: string; actor_kind: string }>(
      `SELECT action, actor_kind FROM platform.audit_log WHERE action = 'customer.data_exported'`,
    );
    expect(rows).toEqual([{ action: 'customer.data_exported', actor_kind: 'app' }]);
    // Another shop has no such customer.
    expect((await call(tokens.b, EXPORT, { id })).userErrors).toMatchObject([
      { field: ['id'], code: 'NOT_FOUND' },
    ]);
  });
});
