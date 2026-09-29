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
  errors?: { message: string; path?: string[]; extensions?: { code?: string } }[];
}

const SCOPES = [
  'write_products',
  'write_inventory',
  'write_locations',
  'write_orders',
  'write_customers',
  'write_segments',
];

const SEGMENT_FIELDS = `
  id name query version
  memberCount
  members(first: 10) { nodes { name } pageInfo { hasNextPage } }
`;

describe.skipIf(!server)('Admin GraphQL API: segments', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', marketer: '', segmentsOnly: '', customersOnly: '', b: '' };

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

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, SCOPES);
    tokens.marketer = await issueToken(shopA, ['read_orders', 'read_customers', 'write_segments']);
    tokens.segmentsOnly = await issueToken(shopA, ['read_segments']);
    tokens.customersOnly = await issueToken(shopA, ['read_customers']);
    tokens.b = await issueToken(shopB, SCOPES);
    api = await startTestApi(testDb);
    app = api.app;

    // Two orders from Ayesha in Karachi, one from Bilal in Lahore; Fatima has not ordered.
    const created = await call(
      tokens.a,
      `mutation {
         productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,000" }] }) {
           product { variants { id } }
         }
       }`,
    );
    const kurta = created.product.variants[0].id as string;
    const place = (name: string, phone: string, city: string) =>
      call(
        tokens.a,
        `mutation ($input: OrderCreateInput!) {
           orderCreate(input: $input) { userErrors { code } }
         }`,
        {
          input: {
            lineItems: [{ variantId: kurta, quantity: 1 }],
            shippingAddress: { name, phone, address1: 'House 1', city },
          },
        },
      );
    await place('Ayesha Khan', '0300 1234567', 'khi');
    await place('Ayesha Khan', '0300 1234567', 'Karachi');
    await place('Bilal Ahmed', '0333 5551234', 'lhr');
    await call(
      tokens.a,
      'mutation { customerCreate(input: { phone: "0321 7654321", name: "Fatima" }) { userErrors { code } } }',
    );
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('lists the fields segments can use', async () => {
    const filters = (await call(
      tokens.a,
      '{ segmentFilters { name type description example operators } }',
    )) as { name: string; type: string; operators: string[] }[];
    const byName = new Map(filters.map((filter) => [filter.name, filter]));
    expect(byName.get('number_of_orders')).toMatchObject({
      type: 'NUMBER',
      operators: ['=', '!=', '>', '>=', '<', '<=', 'BETWEEN'],
    });
    expect(byName.get('city')).toMatchObject({
      type: 'TEXT',
      operators: ['=', '!=', 'IN', 'NOT IN'],
    });
    expect(byName.get('customer_tags')).toMatchObject({ type: 'TEXT_LIST' });
    expect(byName.get('amount_spent')).toMatchObject({ type: 'MONEY' });
    expect(byName.get('last_order_date')).toMatchObject({ type: 'DATE' });
    expect(byName.get('blocked')).toMatchObject({ type: 'BOOLEAN' });
  });

  it('saves segments, shows who is in them now, and deletes them', async () => {
    const created = await call(
      tokens.a,
      `mutation { segmentCreate(name: "Repeat buyers", query: "number_of_orders >= 2") {
         segment { ${SEGMENT_FIELDS} } userErrors { field code message } } }`,
    );
    expect(created).toEqual({
      segment: {
        id: expect.stringMatching(/^seg_/),
        name: 'Repeat buyers',
        query: 'number_of_orders >= 2',
        version: 1,
        memberCount: 1,
        members: { nodes: [{ name: 'Ayesha Khan' }], pageInfo: { hasNextPage: false } },
      },
      userErrors: [],
    });
    const id = created.segment.id as string;

    const invalid = await call(
      tokens.a,
      `mutation { segmentCreate(name: "Broken", query: "orders >= 2") {
         segment { id } userErrors { field code message } } }`,
    );
    expect(invalid).toEqual({
      segment: null,
      userErrors: [
        {
          field: ['query'],
          code: 'INVALID',
          message: 'Unknown field "orders". Did you mean number_of_orders? (at character 1)',
        },
      ],
    });

    const updated = await call(
      tokens.a,
      `mutation ($id: ID!) { segmentUpdate(id: $id, query: "city IN (Karachi, lhr)") {
         segment { ${SEGMENT_FIELDS} } userErrors { code } } }`,
      { id },
    );
    expect(updated.segment).toMatchObject({
      name: 'Repeat buyers',
      version: 2,
      memberCount: 2,
      members: { nodes: [{ name: 'Bilal Ahmed' }, { name: 'Ayesha Khan' }] },
    });

    expect(await call(tokens.a, '{ segments(first: 5) { nodes { name memberCount } } }')).toEqual({
      nodes: [{ name: 'Repeat buyers', memberCount: 2 }],
    });
    expect(await call(tokens.a, 'query ($id: ID!) { segment(id: $id) { name } }', { id })).toEqual({
      name: 'Repeat buyers',
    });

    const deleted = await call(
      tokens.a,
      'mutation ($id: ID!) { segmentDelete(id: $id) { deletedSegmentId userErrors { code } } }',
      { id },
    );
    expect(deleted).toEqual({ deletedSegmentId: id, userErrors: [] });
    expect(
      await call(tokens.a, 'query ($id: ID!) { segment(id: $id) { name } }', { id }),
    ).toBeNull();
  });

  it('previews a query before it is saved', async () => {
    const preview = await call(
      tokens.a,
      '{ segmentPreview(query: "number_of_orders = 0 OR city = Lahore") { memberCount members { name } } }',
    );
    expect(preview).toEqual({
      memberCount: 2,
      members: [{ name: 'Fatima' }, { name: 'Bilal Ahmed' }],
    });
    const bad = await gql(tokens.a, '{ segmentPreview(query: "city >") { memberCount } }');
    expect(bad.errors?.[0]).toMatchObject({
      message: 'Expected a value, found the end of the query (at character 7)',
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('lets marketers build segments without changing customers', async () => {
    const created = await call(
      tokens.marketer,
      `mutation { segmentCreate(name: "Karachi", query: "city = khi") {
         segment { memberCount } userErrors { code } } }`,
    );
    expect(created).toEqual({ segment: { memberCount: 1 }, userErrors: [] });
    const edit = await gql(
      tokens.marketer,
      'mutation { blocklistAdd(input: { phone: "03001234567", reason: OTHER }) { userErrors { code } } }',
    );
    expect(edit.errors?.[0]?.message).toContain('write_customers');

    // Seeing segments is not seeing their customers. The count can't be null, so the whole
    // answer is.
    const names = await gql(
      tokens.segmentsOnly,
      '{ segments(first: 5) { nodes { name memberCount } } }',
    );
    expect(names.data).toBeNull();
    expect(names.errors?.[0]?.message).toContain('read_customers');
    expect(await call(tokens.segmentsOnly, '{ segments(first: 5) { nodes { name } } }')).toEqual({
      nodes: [{ name: 'Karachi' }],
    });
    const write = await gql(
      tokens.customersOnly,
      'mutation { segmentCreate(name: "X", query: "blocked = true") { userErrors { code } } }',
    );
    expect(write.errors?.[0]?.message).toContain('write_segments');
  });

  it("keeps each shop's segments to itself", async () => {
    const created = await call(
      tokens.a,
      'mutation { segmentCreate(name: "Everyone", query: "blocked = false") { segment { id } } }',
    );
    const id = created.segment.id as string;
    expect(
      await call(tokens.b, 'query ($id: ID!) { segment(id: $id) { name } }', { id }),
    ).toBeNull();
    expect(await call(tokens.b, '{ segments(first: 5) { nodes { id } } }')).toEqual({ nodes: [] });
    expect(
      await call(tokens.b, '{ segmentPreview(query: "blocked = false") { memberCount } }'),
    ).toEqual({ memberCount: 0 });
    const deleted = await call(
      tokens.b,
      'mutation ($id: ID!) { segmentDelete(id: $id) { userErrors { code } } }',
      { id },
    );
    expect(deleted.userErrors).toEqual([{ code: 'NOT_FOUND' }]);
  });
});
