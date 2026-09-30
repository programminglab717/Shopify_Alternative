import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface GraphQLResponse {
  data?: Record<string, Json> | null;
  errors?: { message: string; path?: string[]; extensions?: { code?: string } }[];
}

const THEME_FIELDS = 'id name role base version files { filename body size }';

const INDEX = JSON.stringify({
  sections: { featured: { type: 'featured-collection', settings: { collection: 'eid-edit' } } },
  order: ['featured'],
});

describe.skipIf(!server)('Admin GraphQL API: online store themes', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', reader: '', products: '', b: '' };

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
    headers: Record<string, string> = { 'idempotency-key': randomUUID() },
  ): Promise<GraphQLResponse> {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, ...headers },
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
    tokens.a = await issueToken(shopA, ['write_themes']);
    tokens.reader = await issueToken(shopA, ['read_themes']);
    tokens.products = await issueToken(shopA, ['write_products']);
    tokens.b = await issueToken(shopB, ['write_themes']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('lists the main theme, saves its files and prepares another to publish', async () => {
    const list = await call(tokens.reader, `{ themes(first: 5) { nodes { ${THEME_FIELDS} } } }`);
    const main = list.nodes[0];
    expect(list.nodes).toHaveLength(1);
    expect(main).toMatchObject({
      name: 'Hatti Base',
      role: 'MAIN',
      base: 'hatti-base',
      version: 1,
      files: [],
    });
    expect(main.id).toMatch(/^thm_[0-9a-z]{26}$/);

    const saved = await call(
      tokens.a,
      `mutation ($id: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
        themeFilesUpsert(themeId: $id, files: $files) {
          theme { version } upsertedThemeFiles { filename size } userErrors { field code message }
        }
      }`,
      { id: main.id, files: [{ filename: 'templates/index.json', body: INDEX }] },
    );
    expect(saved).toEqual({
      theme: { version: 2 },
      upsertedThemeFiles: [{ filename: 'templates/index.json', size: INDEX.length }],
      userErrors: [],
    });
    const refused = await call(
      tokens.a,
      `mutation ($id: ID!) {
        themeFilesUpsert(themeId: $id, files: [{ filename: "layout/theme.liquid", body: "x" }]) {
          theme { version } userErrors { field code message }
        }
      }`,
      { id: main.id },
    );
    expect(refused.theme).toBeNull();
    expect(refused.userErrors).toEqual([
      {
        field: ['files', '0', 'filename'],
        code: 'INVALID',
        message: expect.stringContaining("isn't a file a theme can keep"),
      },
    ]);

    // Making a theme is not safe to repeat, so it takes an idempotency key.
    const CREATE = `mutation ($copyFrom: ID) {
      themeCreate(name: "Eid look", copyFrom: $copyFrom) {
        theme { ${THEME_FIELDS} } userErrors { field code }
      }
    }`;
    const withoutKey = await gql(tokens.a, CREATE, { copyFrom: main.id }, {});
    expect(withoutKey.errors?.[0]?.extensions?.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const created = await call(tokens.a, CREATE, { copyFrom: main.id });
    expect(created.theme).toMatchObject({
      name: 'Eid look',
      role: 'UNPUBLISHED',
      files: [{ filename: 'templates/index.json', body: INDEX }],
    });
    const published = await call(
      tokens.a,
      `mutation ($id: ID!) { themePublish(id: $id) { theme { role version } userErrors { code } } }`,
      { id: created.theme.id },
    );
    expect(published).toEqual({ theme: { role: 'MAIN', version: 2 }, userErrors: [] });
    const deleted = await call(
      tokens.a,
      `mutation ($id: ID!) { themeDelete(id: $id) { deletedThemeId userErrors { code } } }`,
      { id: main.id },
    );
    expect(deleted).toEqual({ deletedThemeId: main.id, userErrors: [] });
  });

  it("links to a theme's preview, whose files storefronts fetch with the link's token", async () => {
    const created = await call(
      tokens.a,
      'mutation { themeCreate(name: "Winter look") { theme { id previewUrl } userErrors { code } } }',
    );
    const link = new URL(created.theme.previewUrl);
    const { rows } = await admin.query('SELECT handle FROM control.shops WHERE id = $1', [shopA]);
    expect([link.origin, link.pathname]).toEqual([`http://${rows[0].handle}.localhost:4100`, '/']);
    const token = link.searchParams.get('preview')!;

    const fetchPreview = (shopId: string, headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: `/storefront/shops/${shopId}/theme-preview`, headers });
    const asStorefront = { authorization: `Bearer ${TEST_STOREFRONT_KEY}` };
    const found = await fetchPreview(shopA, { ...asStorefront, 'x-hatti-preview': token });
    expect([found.statusCode, found.headers['cache-control']]).toEqual([200, 'no-store']);
    const body = found.json() as Json;
    expect(body.theme).toEqual({
      id: expect.any(String),
      name: 'Winter look',
      version: 1,
      base: 'hatti-base',
      files: {},
    });
    expect(toPublicId('theme', body.theme.id)).toBe(created.theme.id);
    const days = (Date.parse(body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.99);
    expect(days).toBeLessThanOrEqual(14);

    // Not for another shop's storefront, without the token, or without the storefront key.
    const other = await fetchPreview(shopB, { ...asStorefront, 'x-hatti-preview': token });
    expect(other.statusCode).toBe(404);
    expect((await fetchPreview(shopA, asStorefront)).statusCode).toBe(404);
    expect((await fetchPreview(shopA, { 'x-hatti-preview': token })).statusCode).toBe(401);
    // Readers get links too.
    const read = await call(tokens.reader, `{ theme(id: "${created.theme.id}") { previewUrl } }`);
    expect(new URL(read.previewUrl).searchParams.get('preview')).toMatch(/^v1\./);
  });

  it('needs the themes scopes, and keeps each shop to its own themes', async () => {
    for (const [token, query] of [
      [tokens.products, '{ themes(first: 1) { nodes { id } } }'],
      [tokens.reader, 'mutation { themeCreate(name: "x") { userErrors { code } } }'],
    ] as const) {
      const body = await gql(token, query);
      expect(body.errors?.[0]?.extensions?.code, query).toBe('ACCESS_DENIED');
    }
    const theirs = (await call(tokens.b, '{ themes(first: 1) { nodes { id } } }')).nodes[0].id;
    expect(await call(tokens.reader, `{ theme(id: "${theirs}") { id } }`)).toBeNull();
    const publish = await call(
      tokens.a,
      `mutation ($id: ID!) { themePublish(id: $id) { theme { id } userErrors { field code } } }`,
      { id: theirs },
    );
    expect(publish).toEqual({ theme: null, userErrors: [{ field: ['id'], code: 'NOT_FOUND' }] });
  });
});
