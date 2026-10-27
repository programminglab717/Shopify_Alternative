import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { xlsxRows } from '@hatti/xlsx/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const RUN = `
  query ($id: ID!, $from: DateTime, $before: DateTime) {
    customReportRun(id: $id, placedFrom: $from, placedBefore: $before) {
      placedFrom placedBefore
      columns { key title kind trueProfit }
      rows { key label values }
      totals
    }
  }`;

describe.skipIf(!server)('Admin GraphQL API: custom reports (ANL-06, ADR-817)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { owner: '', products: '' };
  const now = Date.now();
  const period = {
    from: new Date(now - 3_600_000).toISOString(),
    before: new Date(now + 3_600_000).toISOString(),
  };

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

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    tokens.owner = await issueToken(['write_products', 'write_orders']);
    tokens.products = await issueToken(['write_products']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('saves a report, runs it over a period, exports it, and deletes it', async () => {
    const created = await gql(
      tokens.owner,
      `mutation {
        productCreate(input: {
          title: "Kurta", status: ACTIVE, variants: [{ price: "2,499", cost: "1,500" }]
        }) {
          product { id variants { id } }
        }
      }`,
    );
    const product = created.data?.productCreate.product;
    const placed = await gql(
      tokens.owner,
      `mutation ($variantId: ID!) {
        orderCreate(input: {
          lineItems: [{ variantId: $variantId, quantity: 2 }], discount: "498",
          shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                             address1: "House 12, Street 4", city: "Lahore" }
        }) { userErrors { code message } }
      }`,
      { variantId: product.variants[0].id },
    );
    expect(placed.data?.orderCreate.userErrors).toEqual([]);

    const columns = await gql(
      tokens.owner,
      `{ customReportColumns(breakdown: PRODUCT) { key title kind trueProfit } }`,
    );
    expect(columns.data?.customReportColumns.map((each: Json) => each.key)).toEqual([
      'units_sold',
      'orders',
      'gross_sales',
      'cost_of_goods',
      'gross_profit',
    ]);

    const save = `
      mutation ($input: CustomReportInput!) {
        customReportCreate(input: $input) {
          customReport { id name breakdown columns period }
          userErrors { field code message }
        }
      }`;
    const refused = await gql(tokens.owner, save, {
      input: { name: 'Best sellers', breakdown: 'PRODUCT', columns: ['profit'], period: 'TODAY' },
    });
    expect(refused.data?.customReportCreate.userErrors).toEqual([
      {
        field: ['input', 'columns', '0'],
        code: 'INVALID',
        message: 'A report of products has no column "profit"',
      },
    ]);
    const byProduct = (
      await gql(tokens.owner, save, {
        input: {
          name: 'Best sellers',
          breakdown: 'PRODUCT',
          columns: ['units_sold', 'gross_profit'],
          period: 'TODAY',
        },
      })
    ).data?.customReportCreate.customReport;
    expect(byProduct).toMatchObject({ id: expect.stringMatching(/^crep_/), period: 'TODAY' });
    const ran = (await gql(tokens.owner, RUN, { id: byProduct.id, ...period })).data
      ?.customReportRun;
    expect(ran).toEqual({
      placedFrom: period.from,
      placedBefore: period.before,
      columns: [
        { key: 'units_sold', title: 'Units sold', kind: 'NUMBER', trueProfit: false },
        { key: 'gross_profit', title: 'Gross profit', kind: 'AMOUNT', trueProfit: false },
      ],
      rows: [{ key: product.id, label: 'Kurta', values: ['2', '1998.00'] }],
      totals: null,
    });

    // By channel over today, on Free: profit is left out (ADR-529).
    const byChannel = (
      await gql(tokens.owner, save, {
        input: {
          name: 'Channels',
          breakdown: 'SOURCE',
          columns: ['orders', 'net_sales', 'profit', 'gross_margin'],
          period: 'TODAY',
        },
      })
    ).data?.customReportCreate.customReport;
    const channels = (await gql(tokens.owner, RUN, { id: byChannel.id, ...period })).data
      ?.customReportRun;
    expect(channels.columns.map((each: Json) => each.key)).toEqual([
      'orders',
      'net_sales',
      'gross_margin',
    ]);
    expect(channels.rows).toEqual([
      { key: 'API', label: 'Apps', values: ['1', '4500.00', '0.3333'] },
    ]);
    expect(channels.totals).toEqual(['1', '4500.00', '0.3333']);
    const half = await gql(tokens.owner, RUN, { id: byChannel.id, from: period.from });
    expect(half.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

    const listed = await gql(tokens.owner, `{ customReports { name } }`);
    expect(listed.data?.customReports).toEqual([{ name: 'Best sellers' }, { name: 'Channels' }]);

    const exported = await gql(
      tokens.owner,
      `mutation ($id: ID!, $from: DateTime, $before: DateTime) {
        customReportExport(id: $id, placedFrom: $from, placedBefore: $before) {
          file { filename contentType content }
          userErrors { code }
        }
      }`,
      { id: byProduct.id, ...period },
    );
    const file = exported.data?.customReportExport.file;
    expect(file.filename).toBe('best-sellers.xlsx');
    expect(xlsxRows(Buffer.from(file.content, 'base64'))).toEqual([
      ['Product', 'Units sold', 'Gross profit'],
      ['Kurta', 2, 1998],
    ]);

    // Those who read no orders see none.
    const denied = await gql(tokens.products, `{ customReports { id } }`);
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');

    const deleted = await gql(
      tokens.owner,
      `mutation ($id: ID!) { customReportDelete(id: $id) { deletedId } }`,
      { id: byProduct.id },
    );
    expect(deleted.data?.customReportDelete.deletedId).toBe(byProduct.id);
    expect((await gql(tokens.owner, RUN, { id: byProduct.id })).data?.customReportRun).toBeNull();
  });
});
