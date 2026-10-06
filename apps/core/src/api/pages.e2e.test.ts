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

const PAGE_FIELDS =
  'id title handle body isPublished publishedAt templateSuffix createdAt updatedAt';

describe.skipIf(!server)('Admin GraphQL API: online store pages', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', reader: '', navigation: '', b: '' };

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

  const create = (token: string, page: Record<string, unknown>) =>
    call(
      token,
      `mutation ($page: PageCreateInput!) {
        pageCreate(page: $page) { page { ${PAGE_FIELDS} } userErrors { field code message } }
      }`,
      { page },
    );

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, [
      'write_online_store_pages',
      'write_online_store_navigation',
    ]);
    tokens.reader = await issueToken(shopA, ['read_online_store_pages']);
    tokens.navigation = await issueToken(shopA, ['write_online_store_navigation']);
    tokens.b = await issueToken(shopB, ['write_online_store_pages']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('makes, changes, lists and deletes pages, their bodies cleaned', async () => {
    const created = await create(tokens.a, {
      title: 'About us',
      body: '<h2>Since 1998</h2><p>Hand-made in <b>Multan</b>.<script>steal()</script></p>',
    });
    expect(created.userErrors).toEqual([]);
    expect(created.page).toMatchObject({
      id: expect.stringMatching(/^pg_[0-9a-z]{26}$/),
      title: 'About us',
      handle: 'about-us',
      body: '<h2>Since 1998</h2><p>Hand-made in <b>Multan</b>.</p>',
      isPublished: true,
      publishedAt: expect.any(String),
      templateSuffix: null,
    });
    const hidden = await create(tokens.a, {
      title: 'Contact',
      handle: 'Contact Us',
      isPublished: false,
      templateSuffix: 'contact',
    });
    expect(hidden.page).toMatchObject({
      handle: 'contact-us',
      isPublished: false,
      publishedAt: null,
      templateSuffix: 'contact',
    });

    const updated = await call(
      tokens.a,
      `mutation ($id: ID!, $page: PageUpdateInput!) {
        pageUpdate(id: $id, page: $page) { page { handle body isPublished } userErrors { field code } }
      }`,
      { id: hidden.page.id, page: { isPublished: true, body: '<p>0300 1234567</p>' } },
    );
    expect(updated).toEqual({
      page: { handle: 'contact-us', body: '<p>0300 1234567</p>', isPublished: true },
      userErrors: [],
    });

    const first = await call(
      tokens.reader,
      `{ pages(first: 1) { nodes { title } pageInfo { hasNextPage endCursor } } }`,
    );
    expect(first.nodes).toEqual([{ title: 'About us' }]);
    expect(first.pageInfo.hasNextPage).toBe(true);
    const rest = await call(
      tokens.reader,
      `query ($after: String) { pages(first: 5, after: $after) { nodes { title } } }`,
      { after: first.pageInfo.endCursor },
    );
    expect(rest.nodes).toEqual([{ title: 'Contact' }]);
    expect(
      await call(tokens.reader, `{ page(id: "${created.page.id}") { title handle } }`),
    ).toEqual({ title: 'About us', handle: 'about-us' });

    const deleted = await call(
      tokens.a,
      `mutation ($id: ID!) { pageDelete(id: $id) { deletedPageId userErrors { field code } } }`,
      { id: hidden.page.id },
    );
    expect(deleted).toEqual({ deletedPageId: hidden.page.id, userErrors: [] });
    expect(await call(tokens.reader, `{ page(id: "${hidden.page.id}") { id } }`)).toBeNull();
  });

  it("says what is wrong under the page's fields", async () => {
    const refused = await create(tokens.a, {
      title: ' ',
      handle: '!!!',
      templateSuffix: 'Contact Page',
    });
    expect(refused).toEqual({
      page: null,
      userErrors: [
        { field: ['page', 'title'], code: 'BLANK', message: "Title can't be blank" },
        {
          field: ['page', 'handle'],
          code: 'INVALID',
          message: 'Handle must contain letters or digits',
        },
        {
          field: ['page', 'templateSuffix'],
          code: 'INVALID',
          message: expect.stringContaining('may have only lower-case letters'),
        },
      ],
    });
    // A time ahead within the year: published then, hidden until it comes (ADR-217).
    const tomorrow = new Date(Math.ceil(Date.now() / 1000) * 1000 + 86_400_000).toISOString();
    expect(await create(tokens.a, { title: 'Eid sale', publishDate: tomorrow })).toMatchObject({
      page: { isPublished: false, publishedAt: tomorrow },
      userErrors: [],
    });
    expect(
      await create(tokens.a, {
        title: 'Later',
        publishDate: new Date(Date.now() + 400 * 86_400_000).toISOString(),
      }),
    ).toEqual({
      page: null,
      userErrors: [
        {
          field: ['page', 'publishDate'],
          code: 'INVALID',
          message: "Publish date can't be more than a year ahead",
        },
      ],
    });
  });

  it('lets menus link to pages', async () => {
    const page = (await create(tokens.a, { title: 'Delivery' })).page;
    const menu = await call(
      tokens.a,
      `mutation ($id: ID!) {
        menuCreate(title: "Help", handle: "help", items: [{ title: "Delivery", type: PAGE, resourceId: $id }]) {
          menu { items { type resourceId url } } userErrors { field code }
        }
      }`,
      { id: page.id },
    );
    expect(menu).toEqual({
      menu: { items: [{ type: 'PAGE', resourceId: page.id, url: '/pages/delivery' }] },
      userErrors: [],
    });
  });

  it('needs the pages scopes, and keeps each shop to its own pages', async () => {
    for (const [token, query] of [
      [tokens.navigation, '{ pages(first: 1) { nodes { id } } }'],
      [tokens.reader, 'mutation { pageCreate(page: { title: "x" }) { page { id } } }'],
    ] as const) {
      const body = await gql(token, query);
      expect(body.errors?.[0]?.extensions?.code, query).toBe('ACCESS_DENIED');
    }
    const theirs = (await create(tokens.b, { title: 'About us' })).page;
    expect(theirs.handle).toBe('about-us');
    expect(await call(tokens.reader, `{ page(id: "${theirs.id}") { id } }`)).toBeNull();
    const update = await call(
      tokens.a,
      `mutation ($id: ID!) {
        pageUpdate(id: $id, page: { title: "Mine" }) { page { id } userErrors { field code } }
      }`,
      { id: theirs.id },
    );
    expect(update).toEqual({ page: null, userErrors: [{ field: ['id'], code: 'NOT_FOUND' }] });
    // Nor may a menu link to another shop's page.
    const linked = await call(
      tokens.a,
      `mutation ($id: ID!) {
        menuCreate(title: "x", handle: "x", items: [{ title: "x", type: PAGE, resourceId: $id }]) {
          menu { id } userErrors { field code }
        }
      }`,
      { id: theirs.id },
    );
    expect(linked).toEqual({
      menu: null,
      userErrors: [{ field: ['items', '0', 'resourceId'], code: 'NOT_FOUND' }],
    });
  });
});
