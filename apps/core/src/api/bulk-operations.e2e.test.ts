import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { bulkMutation, pagedQuery } from './bulk-operations.js';
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

describe('Bulk mutations as given (DEV-10, ADR-897)', () => {
  it('takes one mutation of one field, with variables, and nothing else', () => {
    expect(
      bulkMutation(
        'mutation ($input: ProductCreateInput!) { productCreate(input: $input) { product { id } } }',
      ),
    ).toEqual({ ok: true });
    for (const [mutation, wrong] of [
      ['{ products { nodes { id } } }', 'Give a mutation'],
      [
        'mutation { a: productDelete(id: "1") { deletedProductId } b: productDelete(id: "2") { deletedProductId } }',
        'one mutation field',
      ],
      [
        'fragment F on Product { id } mutation { productCreate(input: {}) { product { ...F } } }',
        'without fragments',
      ],
      ['mutation {', "doesn't parse"],
    ] as const) {
      const refused = bulkMutation(mutation);
      expect(!refused.ok && refused.message, mutation).toContain(wrong);
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

  it('runs a mutation once a line of staged variables, each answer a line with its number (ADR-897)', async () => {
    const lines = [
      { input: { title: 'Chunri dupatta' } },
      'not json',
      { input: { title: '' } },
      { input: { title: 'Ajrak shawl' } },
    ];
    const body = Buffer.from(
      lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'),
    );
    const staged = (
      await gql(
        tokens.reader,
        `mutation ($input: [StagedUploadInput!]!) {
           stagedUploadsCreate(input: $input) {
             stagedTargets { url httpMethod parameters { name value } resourceUrl }
             userErrors { field code message }
           }
         }`,
        {
          input: [
            {
              filename: 'products.jsonl',
              mimeType: 'text/jsonl',
              fileSize: String(body.length),
              resource: 'BULK_MUTATION_VARIABLES',
            },
          ],
        },
      )
    ).data?.stagedUploadsCreate;
    expect(staged.userErrors).toEqual([]);
    const [target] = staged.stagedTargets;
    // A reader stages a shop's files no more than before.
    expect(
      (
        await gql(
          tokens.reader,
          `mutation { stagedUploadsCreate(input: [{ filename: "a.png", mimeType: "image/png", fileSize: "10" }]) { userErrors { code } } }`,
        )
      ).errors?.[0].extensions.code,
    ).toBe('ACCESS_DENIED');

    const MUTATION =
      'mutation ($input: ProductCreateInput!) { productCreate(input: $input) { product { title } userErrors { field message } } }';
    const RUN_MUTATION = `mutation ($mutation: String!, $path: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) {
        bulkOperation { id type status } userErrors { field code message }
      }
    }`;
    // Before the upload, and for another shop's path, it is refused.
    const notThere = (
      await gql(tokens.products, RUN_MUTATION, { mutation: MUTATION, path: target.resourceUrl })
    ).data?.bulkOperationRunMutation;
    expect(notThere.userErrors[0].message).toBe('Upload the variables to the staged target first');
    const elsewhere = (
      await gql(tokens.products, RUN_MUTATION, {
        mutation: MUTATION,
        path: `shops/${newId()}/bulk-variables/${newId()}.jsonl`,
      })
    ).data?.bulkOperationRunMutation;
    expect(elsewhere.userErrors[0].message).toMatch(/^Give the resourceUrl/);

    const put = await app.inject({
      method: 'PUT',
      url: target.url.replace('http://localhost:4000', ''),
      payload: body,
      headers: Object.fromEntries(
        target.parameters.map((each: { name: string; value: string }) => [each.name, each.value]),
      ),
    });
    expect(put.statusCode).toBeLessThan(300);
    const started = (
      await gql(tokens.products, RUN_MUTATION, { mutation: MUTATION, path: target.resourceUrl })
    ).data?.bulkOperationRunMutation;
    expect(started).toEqual({
      bulkOperation: { id: expect.stringMatching(/^bulk_/), type: 'MUTATION', status: 'RUNNING' },
      userErrors: [],
    });
    let done: Json = null;
    for (let tries = 0; tries < 200 && !done; tries++) {
      const current = (
        await gql(
          tokens.products,
          '{ currentBulkOperation(type: MUTATION) { type status objectCount url errorCode } }',
        )
      ).data?.currentBulkOperation;
      if (current?.status !== 'RUNNING') done = current;
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(done).toMatchObject({ type: 'MUTATION', status: 'COMPLETED', objectCount: 4 });
    const file = await app.inject({
      method: 'GET',
      url: new URL(done.url).pathname + new URL(done.url).search,
    });
    const answers = file.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Json);
    expect(answers.map((answer) => answer.__lineNumber)).toEqual([0, 1, 2, 3]);
    expect(answers[0].data.productCreate.product).toEqual({ title: 'Chunri dupatta' });
    expect(answers[1].errors[0].message).toBe('Line 2 is not a JSON object');
    expect(answers[2].data.productCreate.userErrors).not.toEqual([]);
    expect(answers[3].data.productCreate.product).toEqual({ title: 'Ajrak shawl' });
    // The variables are gone once run; the query's own operation is apart from it.
    const again = (
      await gql(tokens.products, RUN_MUTATION, { mutation: MUTATION, path: target.resourceUrl })
    ).data?.bulkOperationRunMutation;
    expect(again.userErrors[0].message).toBe('Upload the variables to the staged target first');
    expect((await gql(tokens.products, CURRENT)).data?.currentBulkOperation).toBeNull();
  });
});

function unwrapRun(answer: { data?: Record<string, Json> | null }) {
  const payload = answer.data?.bulkOperationRunQuery;
  if (!payload?.bulkOperation) throw new Error(JSON.stringify(answer));
  return payload.bulkOperation;
}
