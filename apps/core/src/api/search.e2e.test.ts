import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId } from '@hatti/ids';
import { StorefrontApiClient, searchPath, type SearchResponse } from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Storefront API: search', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const ids: Record<string, string> = {};

  const asStorefront = { authorization: `Bearer ${TEST_STOREFRONT_KEY}` };

  async function create(token: string, title: string, status: string, tags: string[] = []) {
    const created = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token },
      payload: {
        query: `mutation ($input: ProductCreateInput!) {
          productCreate(input: $input) { product { id } userErrors { message } }
        }`,
        variables: { input: { title, status, tags } },
      },
    });
    ids[title] = fromPublicId(created.json().data.productCreate.product.id, 'product')!;
  }

  const search = (
    shopId: string,
    query: string | Record<string, string>,
    headers: Record<string, string> = asStorefront,
  ) =>
    app.inject({
      method: 'GET',
      url: `${searchPath(shopId)}?${new URLSearchParams(typeof query === 'string' ? { q: query } : query)}`,
      headers,
    });

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'Other')`, [
      shopA,
      shopB,
    ]);
    const tokens: string[] = [];
    for (const shopId of [shopA, shopB]) {
      const { token, hash, hint } = generateAccessToken();
      await admin.query(
        `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
         VALUES ($1, 'test', $2, $3, $4)`,
        [shopId, hash, hint, ['write_products']],
      );
      tokens.push(token);
    }
    api = await startTestApi(testDb);
    app = api.app;
    await create(tokens[0]!, 'Qameez Shalwar', 'ACTIVE', ['eid']);
    await create(tokens[0]!, 'Peshawari Chappal', 'ACTIVE');
    await create(tokens[0]!, 'Kurta', 'ACTIVE', ['qameez']);
    await create(tokens[0]!, 'Qameez in draft', 'DRAFT');
    await create(tokens[1]!, 'Qameez elsewhere', 'ACTIVE');
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("finds a shop's active products for storefronts with the key, titles first", async () => {
    expect((await search(shopA, 'kamiz', {})).statusCode).toBe(401);
    expect((await search('not-a-shop', 'kamiz')).statusCode).toBe(404);
    const found = await search(shopA, 'kamiz');
    expect(found.statusCode).toBe(200);
    expect(found.headers['cache-control']).toBe('no-store');
    const { productIds } = found.json() as SearchResponse;
    expect(productIds[0]).toBe(ids['Qameez Shalwar']);
    expect([...productIds].sort()).toEqual([ids['Qameez Shalwar'], ids.Kurta].sort());
    expect((await search(shopA, 'qameez eid')).json()).toEqual({
      productIds: [ids['Qameez Shalwar']],
    });
    expect((await search(shopA, '   ')).json()).toEqual({ productIds: [] });
    expect((await search(shopB, 'shalwar')).json()).toEqual({ productIds: [] });

    // As a shopper types: the last word may be cut short, and fewer are wanted.
    expect((await search(shopA, 'kame')).json()).toEqual({ productIds: [] });
    const typing = (await search(shopA, { q: 'kame', prefix: 'last' })).json() as SearchResponse;
    expect([...typing.productIds].sort()).toEqual([ids['Qameez Shalwar'], ids.Kurta].sort());
    expect((await search(shopA, { q: 'kame', prefix: 'last', limit: '1' })).json()).toEqual({
      productIds: [ids['Qameez Shalwar']],
    });
  });

  it('is what StorefrontApiClient speaks', async () => {
    await app.listen(0, '127.0.0.1');
    const client = new StorefrontApiClient({
      baseUrl: await app.getUrl(),
      key: TEST_STOREFRONT_KEY,
    });
    expect(await client.search(shopA, 'peshawari')).toEqual([ids['Peshawari Chappal']]);
    expect(await client.search(shopB, 'kamiz')).toEqual([ids['Qameez elsewhere']]);
    expect(await client.search(shopA, 'kamee', { prefix: 'last', limit: 1 })).toEqual([
      ids['Qameez Shalwar'],
    ]);
  });
});
