import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
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

  it('makes, lists, changes and deletes automatic discounts, with the discount scopes (ADR-515)', async () => {
    const AUTOMATIC = `id title kind percentage amount { amount } minimumSubtotal { amount }
      status combinesWithCodes summary`;
    const made = await gql(
      tokens.write,
      `mutation ($automaticDiscount: AutomaticDiscountInput!) {
        automaticDiscountCreate(automaticDiscount: $automaticDiscount) {
          automaticDiscount { ${AUTOMATIC} } userErrors { field code message }
        }
      }`,
      { automaticDiscount: { title: 'Eid sale', percentage: 10, minimumSubtotal: '3,000' } },
    );
    const eid = made.data?.automaticDiscountCreate.automaticDiscount;
    expect(eid).toMatchObject({
      id: expect.stringMatching(/^dsa_/),
      title: 'Eid sale',
      kind: 'PERCENTAGE',
      percentage: 10,
      amount: null,
      minimumSubtotal: { amount: '3000.00' },
      status: 'ACTIVE',
      combinesWithCodes: false,
      summary: '10% off orders of Rs 3,000 or more',
    });
    const blank = await gql(
      tokens.write,
      `mutation { automaticDiscountCreate(automaticDiscount: { percentage: 5 }) {
        automaticDiscount { id } userErrors { field code }
      } }`,
    );
    expect(blank.data?.automaticDiscountCreate.userErrors).toEqual([
      { field: ['automaticDiscount', 'title'], code: 'BLANK' },
    ]);

    const changed = await gql(
      tokens.write,
      `mutation ($id: ID!) {
        automaticDiscountUpdate(id: $id, automaticDiscount: { combinesWithCodes: true }) {
          automaticDiscount { combinesWithCodes summary } userErrors { code }
        }
      }`,
      { id: eid.id },
    );
    expect(changed.data?.automaticDiscountUpdate.automaticDiscount).toEqual({
      combinesWithCodes: true,
      summary: '10% off orders of Rs 3,000 or more; with codes',
    });
    const listed = await gql(tokens.read, `{ automaticDiscounts { id title } }`);
    expect(listed.data?.automaticDiscounts).toEqual([{ id: eid.id, title: 'Eid sale' }]);

    expect(
      (
        await gql(
          tokens.read,
          `mutation { automaticDiscountCreate(automaticDiscount: { title: "x", percentage: 5 }) {
            automaticDiscount { id }
          } }`,
        )
      ).errors?.[0]?.extensions?.code,
    ).toBe('ACCESS_DENIED');
    expect(
      (await gql(tokens.orders, `{ automaticDiscounts { id } }`)).errors?.[0]?.extensions?.code,
    ).toBe('ACCESS_DENIED');

    const deleted = await gql(
      tokens.write,
      `mutation ($id: ID!) { automaticDiscountDelete(id: $id) { deletedAutomaticDiscountId } }`,
      { id: eid.id },
    );
    expect(deleted.data?.automaticDiscountDelete.deletedAutomaticDiscountId).toBe(eid.id);
    expect(
      (
        await gql(tokens.read, `query ($id: ID!) { automaticDiscount(id: $id) { id } }`, {
          id: eid.id,
        })
      ).data?.automaticDiscount,
    ).toBeNull();
  });
  it('gives codes and automatic discounts to some products or collections, by their IDs (ADR-517)', async () => {
    const lawn = newId();
    const sale = newId();
    await admin.query(
      `INSERT INTO catalog.products (shop_id, id, title, handle) VALUES ($1, $2, 'Lawn', 'lawn')`,
      [shop, lawn],
    );
    await admin.query(
      `INSERT INTO catalog.collections (shop_id, id, title, handle) VALUES ($1, $2, 'Sale', 'sale')`,
      [shop, sale],
    );
    const lawnId = toPublicId('product', lawn);
    const saleId = toPublicId('collection', sale);
    const made = await gql(
      tokens.write,
      `mutation ($discountCode: DiscountCodeInput!) {
        discountCodeCreate(discountCode: $discountCode) {
          discountCode { productIds collectionIds summary } userErrors { field code }
        }
      }`,
      {
        discountCode: {
          code: 'LAWN10',
          percentage: 10,
          productIds: [lawnId],
          collectionIds: [saleId],
        },
      },
    );
    expect(made.data?.discountCodeCreate).toEqual({
      discountCode: {
        productIds: [lawnId],
        collectionIds: [saleId],
        summary: '10% off 1 product and 1 collection',
      },
      userErrors: [],
    });
    // An ID that is no product's, or one the shop lacks, is not found.
    const wrong = await gql(
      tokens.write,
      `mutation ($ids: [ID!]) {
        automaticDiscountCreate(
          automaticDiscount: { title: "Sale", percentage: 5, productIds: $ids }
        ) { automaticDiscount { id } userErrors { field code } }
      }`,
      { ids: [saleId, toPublicId('product', newId())] },
    );
    expect(wrong.data?.automaticDiscountCreate.userErrors).toEqual([
      { field: ['automaticDiscount', 'productIds', '0'], code: 'NOT_FOUND' },
    ]);
    const missing = await gql(
      tokens.write,
      `mutation ($ids: [ID!]) {
        automaticDiscountCreate(
          automaticDiscount: { title: "Sale", percentage: 5, collectionIds: $ids }
        ) { automaticDiscount { collectionIds } userErrors { field code } }
      }`,
      { ids: [saleId, toPublicId('collection', newId())] },
    );
    expect(missing.data?.automaticDiscountCreate.userErrors).toEqual([
      { field: ['automaticDiscount', 'collectionIds', '1'], code: 'NOT_FOUND' },
    ]);
  });
});
