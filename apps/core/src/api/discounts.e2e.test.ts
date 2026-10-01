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

const FIELDS = `
  id code title kind percentage amount { amount currencyCode } minimumSubtotal { amount }
  startsAt endsAt status usageLimit oncePerCustomer usageCount summary`;

describe.skipIf(!server)('Admin GraphQL API: discount codes', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { write: '', read: '', orders: '' };

  async function issueToken(scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, hash, hint, scopes],
    );
    return token;
  }

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  const create = (token: string, discountCode: Record<string, unknown>) =>
    gql(
      token,
      `mutation ($discountCode: DiscountCodeInput!) {
        discountCodeCreate(discountCode: $discountCode) {
          discountCode { ${FIELDS} } userErrors { field code message }
        }
      }`,
      { discountCode },
    );

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    tokens.write = await issueToken(['write_discounts']);
    tokens.read = await issueToken(['read_discounts']);
    tokens.orders = await issueToken(['write_orders']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('makes, finds, changes and deletes discount codes', async () => {
    const made = await create(tokens.write, {
      code: 'EID25',
      percentage: 25,
      minimumSubtotal: '3,000',
      startsAt: '2026-10-01T00:00:00+05:00',
      oncePerCustomer: true,
    });
    const eid = made.data?.discountCodeCreate.discountCode;
    expect(eid).toEqual({
      id: expect.stringMatching(/^dsc_[0-9a-z]{26}$/),
      code: 'EID25',
      title: 'EID25',
      kind: 'PERCENTAGE',
      percentage: 25,
      amount: null,
      minimumSubtotal: { amount: '3000.00' },
      startsAt: '2026-09-30T19:00:00.000Z',
      endsAt: null,
      status: 'ACTIVE',
      usageLimit: null,
      oncePerCustomer: true,
      usageCount: 0,
      summary: '25% off orders of Rs 3,000 or more; one use a customer',
    });

    const free = await create(tokens.write, {
      code: 'free-delivery',
      freeShipping: true,
      startsAt: '2099-01-01T00:00:00Z',
    });
    expect(free.data?.discountCodeCreate.discountCode).toMatchObject({
      kind: 'FREE_SHIPPING',
      status: 'SCHEDULED',
      summary: 'Free delivery',
    });
    const taken = await create(tokens.write, { code: 'eid25', amount: '500' });
    expect(taken.data?.discountCodeCreate.userErrors).toEqual([
      {
        field: ['discountCode', 'code'],
        code: 'TAKEN',
        message: 'The shop has a code eid25 already, in some letter case',
      },
    ]);

    const listed = await gql(
      tokens.read,
      `{ discountCodes(first: 10) { nodes { code } pageInfo { hasNextPage } } }`,
    );
    expect(listed.data?.discountCodes).toEqual({
      nodes: [{ code: 'free-delivery' }, { code: 'EID25' }],
      pageInfo: { hasNextPage: false },
    });
    const found = await gql(tokens.read, `{ discountCodeByCode(code: "eid25") { id } }`);
    expect(found.data?.discountCodeByCode).toEqual({ id: eid.id });

    const updated = await gql(
      tokens.write,
      `mutation ($id: ID!) {
        discountCodeUpdate(id: $id, discountCode: { amount: "500", minimumSubtotal: null,
                                                     endsAt: "2026-10-01T00:00:00Z" }) {
          discountCode { kind amount { amount } minimumSubtotal { amount } status summary }
          userErrors { field code }
        }
      }`,
      { id: eid.id },
    );
    expect(updated.data?.discountCodeUpdate).toEqual({
      discountCode: {
        kind: 'FIXED_AMOUNT',
        amount: { amount: '500.00' },
        minimumSubtotal: null,
        status: 'EXPIRED',
        summary: 'Rs 500 off the order; one use a customer',
      },
      userErrors: [],
    });

    const deleted = await gql(
      tokens.write,
      `mutation ($id: ID!) { discountCodeDelete(id: $id) { deletedDiscountCodeId userErrors { code } } }`,
      { id: eid.id },
    );
    expect(deleted.data?.discountCodeDelete).toEqual({
      deletedDiscountCodeId: eid.id,
      userErrors: [],
    });
    const gone = await gql(tokens.read, `query ($id: ID!) { discountCode(id: $id) { id } }`, {
      id: eid.id,
    });
    expect(gone.data?.discountCode).toBeNull();
  });

  it("needs Shopify's discount scopes", async () => {
    const readOnly = await create(tokens.read, { code: 'NOPE', percentage: 5 });
    expect(readOnly.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const orders = await gql(tokens.orders, `{ discountCodes(first: 1) { nodes { id } } }`);
    expect(orders.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const bad = await gql(tokens.read, `{ discountCode(id: "ord_01") { id } }`);
    expect(bad.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });
});
