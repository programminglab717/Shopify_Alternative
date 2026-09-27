import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { generateAccessToken } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { createLogger } from '@hatti/logger';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { printSchema } from 'graphql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { createApi } from './create-api.js';

const server = testDatabaseServer();
const SCHEMA_FILE = new URL('../../schema.graphql', import.meta.url);

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface GraphQLResponse {
  data?: Record<string, Json> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

const PRODUCT_FIELDS = `
  id title handle status vendor tags version
  variants { id title sku price { amount currencyCode formatted } compareAtPrice { formatted } }
  priceRange { minVariantPrice { formatted } maxVariantPrice { formatted } }
`;

describe.skipIf(!server)('Admin GraphQL API', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let database: Database;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', aReadOnly: '', b: '', revoked: '' };

  async function issueToken(shopId: string, scopes: string[], revoked = false): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes, revoked_at)
       VALUES ($1, 'test', $2, $3, $4, $5)`,
      [shopId, hash, hint, scopes, revoked ? new Date() : null],
    );
    return token;
  }

  async function gql(
    token: string | undefined,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ status: number; body: GraphQLResponse }> {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: token ? { 'x-hatti-access-token': token } : {},
      payload: { query, variables },
    });
    return { status: response.statusCode, body: response.json() as GraphQLResponse };
  }

  async function createProduct(token: string, input: Record<string, unknown>) {
    const { body } = await gql(
      token,
      `mutation ($input: ProductCreateInput!) {
         productCreate(input: $input) { product { ${PRODUCT_FIELDS} } userErrors { field code message } }
       }`,
      { input },
    );
    return body.data?.productCreate as {
      product: Record<string, Json> | null;
      userErrors: { field: string[]; code: string; message: string }[];
    };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, ['write_products']);
    tokens.aReadOnly = await issueToken(shopA, ['read_products']);
    tokens.b = await issueToken(shopB, ['write_products']);
    tokens.revoked = await issueToken(shopA, ['write_products'], true);

    database = new Database({ appUrl: testDb.appUrl, applicationName: 'api-test' });
    app = await createApi({
      database,
      logger: createLogger({ name: 'api-test', level: 'silent' }),
      maskInternalErrors: true,
    });
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
    await admin?.end();
    await testDb?.drop();
  });

  describe('health', () => {
    it('reports liveness without checking dependencies', async () => {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });

    it('reports readiness with dependency checks', async () => {
      const response = await app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
    });

    it('echoes a well-formed request id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-request-id': 'req-123' },
      });
      expect(response.headers['x-request-id']).toBe('req-123');
    });
  });

  describe('authentication', () => {
    it.each([
      ['no token', undefined],
      ['a malformed token', 'not-a-token'],
      ['an unknown token', generateAccessToken().token],
      ['a revoked token', 'revoked'],
    ])('rejects %s with 401', async (_label, token) => {
      const { status, body } = await gql(
        token === 'revoked' ? tokens.revoked : token,
        '{ shop { name } }',
      );
      expect(status).toBe(401);
      expect(body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    });

    it('rejects tokens of a suspended shop', async () => {
      await admin.query(`UPDATE control.shops SET status = 'suspended' WHERE id = $1`, [shopB]);
      try {
        expect((await gql(tokens.b, '{ shop { name } }')).status).toBe(401);
      } finally {
        await admin.query(`UPDATE control.shops SET status = 'active' WHERE id = $1`, [shopB]);
      }
    });

    it("returns the token's shop", async () => {
      const { status, body } = await gql(tokens.a, '{ shop { id name currencyCode timezone } }');
      expect(status).toBe(200);
      expect(body.data?.shop).toMatchObject({
        name: 'Shop A',
        currencyCode: 'PKR',
        timezone: 'Asia/Karachi',
      });
      expect(body.data?.shop.id).toMatch(/^shop_[0-9a-z]{26}$/);
    });
  });

  describe('products', () => {
    it('creates a product with variants and formatted prices', async () => {
      const result = await createProduct(tokens.a, {
        title: 'Peshawari Chappal',
        status: 'ACTIVE',
        vendor: 'Qissa Khwani Footwear',
        tags: ['chappal'],
        variants: [
          { title: 'Size 9', price: '3,499', compareAtPrice: '4200', sku: 'PC-09' },
          { title: 'Size 10', price: '3699.50' },
        ],
      });
      expect(result.userErrors).toEqual([]);
      expect(result.product).toMatchObject({
        title: 'Peshawari Chappal',
        handle: 'peshawari-chappal',
        status: 'ACTIVE',
        version: 1,
        priceRange: {
          minVariantPrice: { formatted: 'Rs 3,499' },
          maxVariantPrice: { formatted: 'Rs 3,699.50' },
        },
      });
      expect(result.product?.id).toMatch(/^prod_[0-9a-z]{26}$/);
      expect(result.product?.variants[0]).toMatchObject({
        title: 'Size 9',
        sku: 'PC-09',
        price: { amount: '3499.00', currencyCode: 'PKR', formatted: 'Rs 3,499' },
        compareAtPrice: { formatted: 'Rs 4,200' },
      });
      expect(result.product?.variants[0].id).toMatch(/^var_/);
    });

    it('records a product.created event in the same transaction', async () => {
      const result = await createProduct(tokens.a, { title: 'Sindhi Ajrak' });
      const { rows } = await admin.query(
        `SELECT shop_id, event_type FROM platform.outbox_events WHERE aggregate_id = (
           SELECT id FROM catalog.products WHERE shop_id = $1 AND handle = $2)`,
        [shopA, result.product?.handle],
      );
      expect(rows).toEqual([{ shop_id: shopA, event_type: 'product.created' }]);
    });

    it('returns user errors for invalid input', async () => {
      const result = await createProduct(tokens.a, {
        title: ' ',
        variants: [{ price: 'free' }],
      });
      expect(result.product).toBeNull();
      expect(result.userErrors).toEqual([
        { field: ['input', 'title'], code: 'BLANK', message: "Title can't be blank" },
        {
          field: ['input', 'variants', '0', 'price'],
          code: 'INVALID',
          message: 'Price must be an amount of zero or more, like 2499 or 2499.50',
        },
      ]);
    });

    it('enforces access scopes', async () => {
      const { status, body } = await gql(
        tokens.aReadOnly,
        'mutation { productCreate(input: { title: "Nope" }) { product { id } } }',
      );
      expect(status).toBe(200);
      expect(body.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
      expect(body.errors?.[0]?.message).toContain('write_products');
      const read = await gql(tokens.aReadOnly, '{ products(first: 1) { nodes { id } } }');
      expect(read.body.errors).toBeUndefined();
    });

    it('updates a product and bumps its version', async () => {
      const created = await createProduct(tokens.a, { title: 'Multani Khussa' });
      const { body } = await gql(
        tokens.a,
        `mutation ($input: ProductUpdateInput!) {
           productUpdate(input: $input) { product { title status version } userErrors { code } }
         }`,
        { input: { id: created.product?.id, title: 'Multani Khussa (Gold)', status: 'ACTIVE' } },
      );
      expect(body.data?.productUpdate).toEqual({
        product: { title: 'Multani Khussa (Gold)', status: 'ACTIVE', version: 2 },
        userErrors: [],
      });
    });

    it('searches with Roman Urdu spelling variants and pages through results', async () => {
      await createProduct(tokens.a, { title: 'Qameez Shalwar, Wash & Wear' });
      await createProduct(tokens.a, { title: 'Kurta Kameez' });
      const search = `query ($after: String) {
        products(first: 1, after: $after, query: "kamiz") {
          nodes { title } pageInfo { hasNextPage endCursor }
        }
      }`;
      const page1 = (await gql(tokens.a, search)).body.data?.products;
      expect(page1.nodes).toEqual([{ title: 'Kurta Kameez' }]);
      expect(page1.pageInfo.hasNextPage).toBe(true);
      const page2 = (await gql(tokens.a, search, { after: page1.pageInfo.endCursor })).body.data
        ?.products;
      expect(page2.nodes).toEqual([{ title: 'Qameez Shalwar, Wash & Wear' }]);
      expect(page2.pageInfo.hasNextPage).toBe(false);
    });

    it('rejects malformed ids and cursors', async () => {
      const badId = await gql(tokens.a, '{ product(id: "ord_123") { id } }');
      expect(badId.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      const badCursor = await gql(
        tokens.a,
        '{ products(first: 5, after: "abc") { nodes { id } } }',
      );
      expect(badCursor.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      const badPage = await gql(tokens.a, '{ products(first: 500) { nodes { id } } }');
      expect(badPage.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    });
  });

  describe('tenant isolation', () => {
    it("never exposes or changes another shop's products", async () => {
      const secret = await createProduct(tokens.a, { title: 'Shop A Secret Product' });
      const id = secret.product?.id as string;

      const read = await gql(tokens.b, `query ($id: ID!) { product(id: $id) { id title } }`, {
        id,
      });
      expect(read.body.data?.product).toBeNull();

      const list = await gql(tokens.b, '{ products(first: 250) { nodes { id } } }');
      expect(list.body.data?.products.nodes).toEqual([]);

      const search = await gql(
        tokens.b,
        '{ products(first: 5, query: "secret") { nodes { id } } }',
      );
      expect(search.body.data?.products.nodes).toEqual([]);

      const update = await gql(
        tokens.b,
        `mutation ($input: ProductUpdateInput!) {
           productUpdate(input: $input) { product { id } userErrors { code } }
         }`,
        { input: { id, title: 'Hijacked' } },
      );
      expect(update.body.data?.productUpdate).toEqual({
        product: null,
        userErrors: [{ code: 'NOT_FOUND' }],
      });

      const own = await gql(tokens.a, `query ($id: ID!) { product(id: $id) { title } }`, { id });
      expect(own.body.data?.product).toEqual({ title: 'Shop A Secret Product' });
    });
  });

  describe('schema', () => {
    it('matches the committed schema.graphql (UPDATE_SCHEMA=1 to accept changes)', async () => {
      const printed = `${printSchema(app.get(GraphQLSchemaHost).schema)}\n`;
      if (process.env.UPDATE_SCHEMA) await writeFile(SCHEMA_FILE, printed);
      const committed = await readFile(SCHEMA_FILE, 'utf8').catch(() => '');
      expect(printed).toBe(committed);
    });
  });
});
