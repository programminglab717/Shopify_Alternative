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

const PAYLOAD = 'urlRedirect { id path target } userErrors { field code message }';

describe.skipIf(!server)('Admin GraphQL API: URL redirects', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', reader: '', b: '', pages: '', editor: '' };

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
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
    return response.json() as { data?: Record<string, Json>; errors?: Json[] };
  }

  async function call(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  const create = (token: string, urlRedirect: Record<string, string>) =>
    call(
      token,
      `mutation ($urlRedirect: UrlRedirectInput!) {
        urlRedirectCreate(urlRedirect: $urlRedirect) { ${PAYLOAD} }
      }`,
      { urlRedirect },
    );

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari'), ($2, 'Other', 'other')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, ['write_online_store_navigation']);
    tokens.reader = await issueToken(shopA, ['read_online_store_navigation']);
    tokens.b = await issueToken(shopB, ['write_online_store_navigation']);
    tokens.pages = await issueToken(shopA, ['write_online_store_pages']);
    tokens.editor = await issueToken(shopA, [
      'write_online_store_pages',
      'write_products',
      'read_online_store_navigation',
    ]);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("keeps a shop's redirects from its old addresses, and changes and deletes them", async () => {
    const created = await create(tokens.a, {
      path: 'https://zari.myshopify.com/Products/Old-Lawn?variant=1',
      target: '/products/lawn-3-piece',
    });
    expect(created).toEqual({
      urlRedirect: {
        id: expect.stringMatching(/^rdr_[0-9A-Za-z]+$/),
        path: '/products/old-lawn',
        target: '/products/lawn-3-piece',
      },
      userErrors: [],
    });
    const id = created.urlRedirect.id as string;
    expect(
      (await create(tokens.a, { path: '/products/old-lawn/', target: '/' })).userErrors,
    ).toEqual([
      {
        field: ['urlRedirect', 'path'],
        code: 'TAKEN',
        message: '/products/old-lawn has a redirect already',
      },
    ]);
    expect((await create(tokens.a, { path: '/', target: '/products/lawn' })).userErrors).toEqual([
      {
        field: ['urlRedirect', 'path'],
        code: 'INVALID',
        message: 'Enter a path on the shop other than its home page, such as /products/old-lawn',
      },
    ]);
    // Another shop's paths are its own.
    const other = await create(tokens.b, {
      path: '/products/old-lawn',
      target: '/collections/all',
    });
    expect(other.userErrors).toEqual([]);

    await create(tokens.a, { path: '/pages/instagram', target: 'https://instagram.com/zari' });
    const listed = await call(
      tokens.reader,
      `{ urlRedirects(first: 1) {
          nodes { path target } pageInfo { hasNextPage endCursor }
        } }`,
    );
    expect(listed.nodes).toEqual([
      { path: '/products/old-lawn', target: '/products/lawn-3-piece' },
    ]);
    expect(listed.pageInfo.hasNextPage).toBe(true);
    const next = await call(
      tokens.reader,
      'query ($after: String) { urlRedirects(first: 5, after: $after) { nodes { path } } }',
      { after: listed.pageInfo.endCursor },
    );
    expect(next.nodes).toEqual([{ path: '/pages/instagram' }]);
    expect(
      await call(tokens.reader, '{ urlRedirects(query: "instagram.com") { nodes { path } } }'),
    ).toEqual({ nodes: [{ path: '/pages/instagram' }] });
    expect(
      await call(tokens.reader, 'query ($id: ID!) { urlRedirect(id: $id) { path } }', { id }),
    ).toEqual({ path: '/products/old-lawn' });
    expect(await call(tokens.b, 'query ($id: ID!) { urlRedirect(id: $id) { path } }', { id })).toBe(
      null,
    );

    const updated = await call(
      tokens.a,
      `mutation ($id: ID!, $urlRedirect: UrlRedirectInput!) {
        urlRedirectUpdate(id: $id, urlRedirect: $urlRedirect) { ${PAYLOAD} }
      }`,
      { id, urlRedirect: { target: '/collections/lawn' } },
    );
    expect(updated).toEqual({
      urlRedirect: { id, path: '/products/old-lawn', target: '/collections/lawn' },
      userErrors: [],
    });
    const deleteMutation =
      'mutation ($id: ID!) { urlRedirectDelete(id: $id) { deletedUrlRedirectId userErrors { field code } } }';
    expect(await call(tokens.b, deleteMutation, { id })).toEqual({
      deletedUrlRedirectId: null,
      userErrors: [{ field: ['id'], code: 'NOT_FOUND' }],
    });
    expect(await call(tokens.a, deleteMutation, { id })).toEqual({
      deletedUrlRedirectId: id,
      userErrors: [],
    });
    expect(await call(tokens.reader, '{ urlRedirects { nodes { path } } }')).toEqual({
      nodes: [{ path: '/pages/instagram' }],
    });
  });

  it("sends a page's old address on when its handle changes, and has the worker do it for a product's", async () => {
    const page = await call(
      tokens.editor,
      'mutation { pageCreate(page: { title: "Returns" }) { page { id handle } } }',
    );
    const moved = await call(
      tokens.editor,
      `mutation ($id: ID!) {
        pageUpdate(id: $id, page: { handle: "refunds", redirectNewHandle: true }) {
          page { handle } userErrors { code }
        }
      }`,
      { id: page.page.id },
    );
    expect(moved).toEqual({ page: { handle: 'refunds' }, userErrors: [] });
    // With the change itself, under the pages' scope alone.
    expect(
      await call(tokens.editor, '{ urlRedirects(query: "refunds") { nodes { path target } } }'),
    ).toEqual({ nodes: [{ path: '/pages/returns', target: '/pages/refunds' }] });

    const product = await call(
      tokens.editor,
      'mutation { productCreate(input: { title: "Lawn Suit" }) { product { id } } }',
    );
    const renamed = await call(
      tokens.editor,
      `mutation ($id: ID!) {
        productUpdate(input: { id: $id, handle: "lawn-2026", redirectNewHandle: true }) {
          product { handle } userErrors { code }
        }
      }`,
      { id: product.product.id },
    );
    expect(renamed).toEqual({ product: { handle: 'lawn-2026' }, userErrors: [] });
    const { rows } = await admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox_events
        WHERE shop_id = $1 AND event_type = 'product.updated'`,
      [shopA],
    );
    expect(rows.map((row) => row.payload)).toEqual([
      { changed: ['handle'], version: 2, previousHandle: 'lawn-suit', redirectNewHandle: true },
    ]);
  });

  it('needs the navigation scopes, as Shopify asks for them', async () => {
    const denied = async (token: string, query: string) =>
      (await gql(token, query)).errors?.[0]?.extensions?.code;
    expect(await denied(tokens.pages, '{ urlRedirects { nodes { path } } }')).toBe('ACCESS_DENIED');
    expect(
      await denied(
        tokens.reader,
        'mutation { urlRedirectCreate(urlRedirect: { path: "/a", target: "/" }) { userErrors { code } } }',
      ),
    ).toBe('ACCESS_DENIED');
  });
});
