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

const CHART = 'id name unit columns rows { size values } note productsCount';

const CREATE = `mutation ($input: SizeChartInput!) {
  sizeChartCreate(input: $input) { sizeChart { ${CHART} } userErrors { field code } }
}`;

const SET = `mutation ($sizeChartId: ID, $productIds: [ID!], $collectionId: ID) {
  productsSizeChartSet(
    sizeChartId: $sizeChartId, productIds: $productIds, collectionId: $collectionId
  ) { productIds userErrors { field code } }
}`;

describe.skipIf(!server)('Admin GraphQL API: size charts (CAT-10, ADR-406)', () => {
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
      `mutation ($input: ProductCreateInput!) { productCreate(input: $input) { product { id } } }`,
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

  it('makes a chart, gives it to products and a collection, and shows it on each', async () => {
    const created = await data(tokens.write, CREATE, {
      input: {
        name: 'Kurtas',
        unit: 'INCHES',
        columns: ['Chest', 'Length'],
        rows: [
          { size: 'S', values: [36, 42] },
          { size: 'M', values: [38.5, null] },
        ],
        note: 'Measure a kurta that fits you well.',
      },
    });
    expect(created.userErrors).toEqual([]);
    const chart = created.sizeChart;
    expect(chart).toMatchObject({
      id: expect.stringMatching(/^szc_/),
      unit: 'INCHES',
      rows: [
        { size: 'S', values: [36, 42] },
        { size: 'M', values: [38.5, null] },
      ],
      productsCount: 0,
    });

    const lawn = await product('Lawn kurta');
    const silk = await product('Silk kurta');
    const collection = await data(
      tokens.write,
      `mutation ($input: CollectionCreateInput!) { collectionCreate(input: $input) { collection { id } } }`,
      { input: { title: 'Eid', products: [silk] } },
    );
    expect(await data(tokens.write, SET, { sizeChartId: chart.id, productIds: [lawn] })).toEqual({
      productIds: [lawn],
      userErrors: [],
    });
    expect(
      await data(tokens.write, SET, {
        sizeChartId: chart.id,
        collectionId: collection.collection.id,
      }),
    ).toEqual({ productIds: [silk], userErrors: [] });

    const read = await data(
      tokens.read,
      `query ($id: ID!) { product(id: $id) { title sizeChart { name productsCount } } }`,
      { id: lawn },
    );
    expect(read).toEqual({ title: 'Lawn kurta', sizeChart: { name: 'Kurtas', productsCount: 2 } });
    expect(await data(tokens.read, `{ sizeCharts { ${CHART} } }`)).toEqual([
      { ...chart, productsCount: 2 },
    ]);
    expect(
      await data(tokens.read, `query ($id: ID!) { sizeChart(id: $id) { name } }`, { id: chart.id }),
    ).toEqual({ name: 'Kurtas' });

    // Changed in centimetres; taken from one product; deleted.
    const updated = await data(
      tokens.write,
      `mutation ($id: ID!, $input: SizeChartInput!) {
        sizeChartUpdate(id: $id, input: $input) { sizeChart { unit note } userErrors { field } }
      }`,
      { id: chart.id, input: { unit: 'CENTIMETERS', note: null } },
    );
    expect(updated).toEqual({ sizeChart: { unit: 'CENTIMETERS', note: null }, userErrors: [] });
    expect(await data(tokens.write, SET, { sizeChartId: null, productIds: [silk] })).toEqual({
      productIds: [silk],
      userErrors: [],
    });
    expect(
      await data(
        tokens.write,
        `mutation ($id: ID!) {
          sizeChartDelete(id: $id) { deletedSizeChartId userErrors { code } }
        }`,
        { id: chart.id },
      ),
    ).toEqual({ deletedSizeChartId: chart.id, userErrors: [] });
    expect(
      await data(tokens.read, `query ($id: ID!) { product(id: $id) { sizeChart { id } } }`, {
        id: lawn,
      }),
    ).toEqual({ sizeChart: null });
    const { rows } = await admin.query<{ event_type: string; actor_id: string | null }>(
      `SELECT event_type FROM platform.outbox_events
        WHERE event_type LIKE 'size_chart.%' OR event_type LIKE 'product_size_chart.%'
        ORDER BY occurred_at, id`,
    );
    expect(rows.map((row) => row.event_type)).toEqual([
      'size_chart.created',
      'product_size_chart.updated',
      'product_size_chart.updated',
      'size_chart.updated',
      'product_size_chart.updated',
      'size_chart.deleted',
    ]);
  });

  it('says what is wrong, and asks the scopes products need', async () => {
    const refused = await data(tokens.write, CREATE, {
      input: {
        name: 'Shirts',
        unit: 'INCHES',
        columns: ['Chest'],
        rows: [{ size: 'M', values: [0] }],
      },
    });
    expect(refused).toEqual({
      sizeChart: null,
      userErrors: [{ field: ['rows', '0', 'values', '0'], code: 'INVALID' }],
    });
    expect(
      await data(tokens.write, SET, {
        sizeChartId: 'szc_00000000000000000000000000',
        productIds: [await product('Cotton shirt')],
      }),
    ).toEqual({ productIds: [], userErrors: [{ field: ['sizeChartId'], code: 'NOT_FOUND' }] });
    expect(
      await data(tokens.read, `query ($id: ID!) { sizeChart(id: $id) { id } }`, { id: 'prod_x' }),
    ).toBeNull();

    const denied = await gql(tokens.read, CREATE, {
      input: { name: 'Shirts', unit: 'INCHES', columns: ['Chest'], rows: [] },
    });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const unread = await gql(tokens.orders, '{ sizeCharts { id } }');
    expect(unread.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });
});
