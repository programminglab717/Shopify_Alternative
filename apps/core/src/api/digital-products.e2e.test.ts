import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe.skipIf(!server)('Admin GraphQL API: digital products (CAT-13, ADR-813)', () => {
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
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
      payload: { query, variables },
    });
    return response.json<{ data?: Json; errors?: Json[] }>();
  }

  async function data(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  async function product(title: string): Promise<string> {
    const created = await data(
      tokens.write,
      `mutation ($input: ProductCreateInput!) {
        productCreate(input: $input) { product { id } }
      }`,
      { input: { title, status: 'ACTIVE' } },
    );
    return created.product.id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    tokens.write = await issueToken(['write_products']);
    tokens.read = await issueToken(['read_products']);
    tokens.orders = await issueToken(['read_orders']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('makes a product digital, stages its file and keeps its keys, never shown', async () => {
    const ebook = await product('Patterns (PDF)');
    const set = `mutation ($id: ID!, $input: DigitalProductInput!) {
      digitalProductSet(productId: $id, input: $input) {
        digitalProduct { downloadLimit linkDays licenceKeys keysLeft files { filename } }
        userErrors { field code }
      }
    }`;
    expect(await data(tokens.write, set, { id: ebook, input: { licenceKeys: true } })).toEqual({
      digitalProduct: { downloadLimit: 5, linkDays: 30, licenceKeys: true, keysLeft: 0, files: [] },
      userErrors: [],
    });
    const refused = await gql(tokens.read, set, { id: ebook, input: {} });
    expect(refused.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');

    const staged = await data(
      tokens.write,
      `mutation ($id: ID!) {
        digitalFileStage(productId: $id, input: { filename: "patterns.pdf", contentType: "application/pdf", size: 1024 }) {
          file { id filename ready }
          upload { url method headers { name value } }
          userErrors { field code }
        }
      }`,
      { id: ebook },
    );
    expect(staged).toMatchObject({
      file: { id: expect.stringMatching(/^dfile_/), filename: 'patterns.pdf', ready: false },
      upload: { url: expect.any(String), method: 'PUT' },
      userErrors: [],
    });

    expect(
      await data(
        tokens.write,
        `mutation ($id: ID!) {
          licenceKeysAdd(productId: $id, keys: ["K1-AAAA", "K2-BBBB", "K1-AAAA"]) {
            added already userErrors { field }
          }
        }`,
        { id: ebook },
      ),
    ).toEqual({ added: 2, already: 0, userErrors: [] });
    expect(
      await data(
        tokens.read,
        `query ($id: ID!) { licenceKeys(productId: $id) { id hint issuedAt } }`,
        {
          id: ebook,
        },
      ),
    ).toEqual([
      { id: expect.stringMatching(/^lkey_/), hint: 'BBBB', issuedAt: null },
      { id: expect.stringMatching(/^lkey_/), hint: 'AAAA', issuedAt: null },
    ]);
    expect(
      await data(
        tokens.read,
        `query ($id: ID!) { product(id: $id) { digital { keysLeft files { filename ready } } } }`,
        {
          id: ebook,
        },
      ),
    ).toEqual({ digital: { keysLeft: 2, files: [{ filename: 'patterns.pdf', ready: false }] } });
    expect(
      await data(
        tokens.write,
        `mutation ($id: ID!) { digitalProductRemove(productId: $id) { removed } }`,
        { id: ebook },
      ),
    ).toEqual({ removed: true });

    // The link page of a line, which no secret here names (ADR-814): private, and plain.
    const page = await app.inject({ method: 'GET', url: `/dl/${'x'.repeat(43)}` });
    expect([
      page.statusCode,
      page.headers['cache-control'],
      page.headers['referrer-policy'],
    ]).toEqual([404, 'no-store', 'no-referrer']);
    expect(page.body).toContain('There is nothing to download here');
    const file = await app.inject({ method: 'GET', url: `/dl/${'x'.repeat(43)}/${newId()}` });
    expect(file.statusCode).toBe(404);
  });
});
