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

const APPLY = `mutation ($kit: StarterKit!) {
  starterKitApply(kit: $kit) { collectionsMade collectionsKept sizeChartsMade menuLinksAdded }
}`;

describe.skipIf(!server)('Admin GraphQL API: starter kits (ONB-13, ADR-486)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { owner: '', products: '' };

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

  async function data(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    tokens.owner = await issueToken(['write_products', 'write_online_store_navigation']);
    tokens.products = await issueToken(['write_products']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('sets up what a kind of shop sells by, and leaves what it has when applied again', async () => {
    const kits = await data(
      tokens.owner,
      '{ starterKits { kit collections { title handle tag } sizeCharts } }',
    );
    expect(kits.map((kit: Json) => kit.kit)).toEqual([
      'FASHION',
      'JEWELLERY',
      'BEAUTY',
      'ELECTRONICS',
      'GROCERY',
    ]);
    expect(kits[0].collections).toContainEqual({ title: 'Lawn', handle: 'lawn', tag: 'lawn' });
    expect(kits[0].sizeCharts).toEqual(['Kameez (women)', 'Kurta (men)']);

    expect(await data(tokens.owner, APPLY, { kit: 'FASHION' })).toEqual({
      collectionsMade: 7,
      collectionsKept: 0,
      sizeChartsMade: 2,
      menuLinksAdded: 7,
    });
    const lawn = await data(
      tokens.owner,
      '{ collectionByHandle(handle: "lawn") { title ruleSet { rules { condition } } } }',
    );
    expect(lawn).toEqual({ title: 'Lawn', ruleSet: { rules: [{ condition: 'lawn' }] } });
    const menus = await data(tokens.owner, '{ menus { nodes { handle items { title type } } } }');
    const main = menus.nodes.find((menu: Json) => menu.handle === 'main-menu');
    expect(main.items).toContainEqual({ title: 'Lawn', type: 'COLLECTION' });
    expect(main.items).toContainEqual({ title: 'Eid collection', type: 'COLLECTION' });
    const charts = await data(tokens.owner, '{ sizeCharts { name } }');
    expect(charts.map((chart: Json) => chart.name).sort()).toEqual([
      'Kameez (women)',
      'Kurta (men)',
    ]);

    // Another kit after it shares its new arrivals and sale.
    expect(await data(tokens.owner, APPLY, { kit: 'JEWELLERY' })).toEqual({
      collectionsMade: 5,
      collectionsKept: 2,
      sizeChartsMade: 0,
      menuLinksAdded: 5,
    });
    // The same kit again makes nothing.
    expect(await data(tokens.owner, APPLY, { kit: 'FASHION' })).toEqual({
      collectionsMade: 0,
      collectionsKept: 7,
      sizeChartsMade: 0,
      menuLinksAdded: 0,
    });
    const again = await data(tokens.owner, '{ menus { nodes { handle items { title } } } }');
    const titles = again.nodes
      .find((menu: Json) => menu.handle === 'main-menu')
      .items.map((item: Json) => item.title);
    expect(titles.filter((title: string) => title === 'Lawn')).toHaveLength(1);

    // It changes the menus too.
    const denied = await gql(tokens.products, APPLY, { kit: 'BEAUTY' });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });
});
