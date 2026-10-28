import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { pagedQuery } from './bulk-operations.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe('Bulk queries as each page runs them (DEV-10, ADR-843)', () => {
  it('pages one list itself, and refuses what it cannot page', () => {
    const paged = pagedQuery('{ products(query: "status:active") { nodes { id title } } }');
    expect(paged).toMatchObject({ ok: true, key: 'products' });
    expect(paged.ok && paged.document.replace(/\s+/g, ' ')).toBe(
      'query ($bulkAfter: String) { products(query: "status:active", first: 250, after: ' +
        '$bulkAfter) { nodes { id title } bulkPageInfo: pageInfo { hasNextPage endCursor } } }',
    );
    expect(pagedQuery('{ all: orders { edges { node { id } } } }')).toMatchObject({
      ok: true,
      key: 'all',
    });
    for (const [query, wrong] of [
      ['{ products(first: 10) { nodes { id } } }', 'Leave out first'],
      ['{ products { nodes { id } } orders { nodes { id } } }', 'Ask for one list'],
      ['mutation { productDelete(id: "x") { deletedProductId } }', 'not a mutation'],
      ['query ($q: String) { products(query: $q) { nodes { id } } }', 'takes no variables'],
      ['{ shop { name } }', 'nodes'],
      ['{ products { nodes { id }', "doesn't parse"],
    ] as const) {
      const refused = pagedQuery(query);
      expect(!refused.ok && refused.message, query).toContain(wrong);
    }
  });
});

describe.skipIf(!server)('Bulk operations through the Admin API (DEV-10, ADR-843)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { products: '', reader: '' };

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
      headers: { 'x-hatti-access-token': token, 'idempotency-key': newId() },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  const RUN = `mutation ($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status } userErrors { field code message }
    }
  }`;
  const CURRENT = '{ currentBulkOperation { id status objectCount fileSize url errorCode } }';

  /** The caller's operation once it has ended. */
  async function ended(token: string) {
    for (let tries = 0; tries < 100; tries++) {
      const current = (await gql(token, CURRENT)).data?.currentBulkOperation;
      if (current && current.status !== 'RUNNING') return current;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('The bulk operation never ended');
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    tokens.products = await issueToken(['write_products']);
    tokens.reader = await issueToken(['read_products']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("writes all of a list to a file, a line a node, refusing what the caller can't read", async () => {
    for (const title of ['Lawn suit', 'Khussa', 'Dupatta']) {
      await gql(
        tokens.products,
        `mutation { productCreate(input: { title: "${title}" }) { product { id } } }`,
      );
    }
    expect((await gql(tokens.reader, CURRENT)).data?.currentBulkOperation).toBeNull();
    const started = (await gql(tokens.reader, RUN, { query: '{ products { nodes { title } } }' }))
      .data?.bulkOperationRunQuery;
    expect(started).toEqual({
      bulkOperation: { id: expect.stringMatching(/^bulk_/), status: 'RUNNING' },
      userErrors: [],
    });
    const done = await ended(tokens.reader);
    expect(done).toMatchObject({ status: 'COMPLETED', objectCount: 3, errorCode: null });
    expect(done.url).toMatch(/^http:\/\/localhost:4000\/storage\//);
    const file = await app.inject({
      method: 'GET',
      url: new URL(done.url).pathname + new URL(done.url).search,
    });
    expect(file.statusCode).toBe(200);
    expect(
      file.body
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { title: string }).title)
        .sort(),
    ).toEqual(['Dupatta', 'Khussa', 'Lawn suit']);
    expect(done.fileSize).toBe(Buffer.byteLength(file.body));

    // A list the caller can't read fails, as the query would.
    unwrapRun(await gql(tokens.reader, RUN, { query: '{ orders { nodes { id } } }' }));
    expect(await ended(tokens.reader)).toMatchObject({
      status: 'FAILED',
      errorCode: 'ACCESS_DENIED',
      url: null,
    });
    // A query it cannot page, or the API cannot run, is refused at once.
    expect(
      (await gql(tokens.reader, RUN, { query: '{ products(sortKey: TITLE) { nodes { id } } }' }))
        .data?.bulkOperationRunQuery.userErrors[0].message,
    ).toBe('Unknown argument "sortKey" on field "Query.products".');
    expect(
      (await gql(tokens.reader, RUN, { query: '{ products(first: 5) { nodes { id } } }' })).data
        ?.bulkOperationRunQuery.userErrors,
    ).toEqual([
      {
        field: ['query'],
        code: 'INVALID',
        message: 'Leave out first, last, after and before: it pages the list itself',
      },
    ]);
    // Each caller sees their own.
    expect((await gql(tokens.products, CURRENT)).data?.currentBulkOperation).toBeNull();
  });
});

function unwrapRun(answer: { data?: Record<string, Json> | null }) {
  const payload = answer.data?.bulkOperationRunQuery;
  if (!payload?.bulkOperation) throw new Error(JSON.stringify(answer));
  return payload.bulkOperation;
}
