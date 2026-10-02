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

const SALES = `
  fragment sales on Sales {
    orders
    grossSales { amount }
    discounts { amount }
    returns { amount }
    netSales { amount }
    shipping { amount }
    totalSales { amount currencyCode }
    taxes { amount }
    averageOrderValue { amount }
  }
  query ($from: DateTime!, $before: DateTime!, $interval: SalesInterval) {
    salesReport(placedFrom: $from, placedBefore: $before, interval: $interval) {
      totals { ...sales }
      periods { start sales { orders } }
      topProducts { productId title unitsSold orders grossSales { amount } }
    }
  }`;

describe.skipIf(!server)('Admin GraphQL API: sales analytics', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { owner: '', products: '' };
  const period = {
    from: new Date(Date.now() - 3_600_000).toISOString(),
    before: new Date(Date.now() + 3_600_000).toISOString(),
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

  it("says what a period's orders came to, and the products that sold most", async () => {
    const created = await gql(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,499" }] }) {
          product { id variants { id } }
        }
      }`,
    );
    const product = created.data?.productCreate.product;
    for (const [quantity, extra] of [
      [2, 'discount: "498", shippingPrice: "250"'],
      [1, ''],
    ] as const) {
      const placed = await gql(
        tokens.owner,
        `mutation ($variantId: ID!) {
          orderCreate(input: {
            lineItems: [{ variantId: $variantId, quantity: ${quantity} }], ${extra}
            shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                               address1: "House 12, Street 4", city: "Lahore" }
          }) { userErrors { code message } }
        }`,
        { variantId: product.variants[0].id },
      );
      expect(placed.data?.orderCreate.userErrors).toEqual([]);
    }

    const report = (await gql(tokens.owner, SALES, period)).data?.salesReport;
    expect(report.totals).toEqual({
      orders: 2,
      grossSales: { amount: '7497.00' },
      discounts: { amount: '498.00' },
      returns: { amount: '0.00' },
      netSales: { amount: '6999.00' },
      shipping: { amount: '250.00' },
      totalSales: { amount: '7249.00', currencyCode: 'PKR' },
      // The shop charges no sales tax.
      taxes: { amount: '0.00' },
      averageOrderValue: { amount: '3499.50' },
    });
    expect((report.periods as Json[]).reduce((sum, each) => sum + each.sales.orders, 0)).toBe(2);
    expect(report.topProducts).toEqual([
      {
        productId: product.id,
        title: 'Kurta',
        unitsSold: 3,
        orders: 2,
        grossSales: { amount: '7497.00' },
      },
    ]);

    const empty = await gql(tokens.owner, SALES, {
      from: '2026-01-01T00:00:00+05:00',
      before: '2026-02-01T00:00:00+05:00',
      interval: 'WEEK',
    });
    expect(empty.data?.salesReport.totals.averageOrderValue).toBeNull();
    expect(empty.data?.salesReport.periods[0].start).toBe('2025-12-28T19:00:00.000Z');

    const tooLong = await gql(tokens.owner, SALES, { ...period, from: '2025-01-01T00:00:00Z' });
    expect(tooLong.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

    const denied = await gql(tokens.products, SALES, period);
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });

  it('says where the orders came from, in sales and in COD health (ADR-140)', async () => {
    // The kurta alone came through the online store, from an Instagram ad's campaign.
    const visit = {
      at: new Date().toISOString(),
      source: 'instagram',
      utm: { source: 'ig', medium: 'paid_social', campaign: 'Eid', term: null, content: null },
    };
    await admin.query(
      `UPDATE orders.orders SET source = 'online_store', attribution = $2
        WHERE shop_id = $1 AND subtotal = 249900`,
      [shop, JSON.stringify({ first: visit, last: visit })],
    );
    const rows = async (by: string) =>
      (
        await gql(
          tokens.owner,
          `query ($from: DateTime!, $before: DateTime!, $by: SalesDimension) {
            salesReport(placedFrom: $from, placedBefore: $before, by: $by) {
              rows { key title sales { orders totalSales { amount } } }
            }
          }`,
          { ...period, by },
        )
      ).data?.salesReport.rows;
    expect(await rows('VISIT_SOURCE')).toEqual([
      {
        key: null,
        title: 'No visit known',
        sales: { orders: 1, totalSales: { amount: '4750.00' } },
      },
      {
        key: 'instagram',
        title: 'Instagram',
        sales: { orders: 1, totalSales: { amount: '2499.00' } },
      },
    ]);
    expect(await rows('SOURCE')).toEqual([
      { key: 'API', title: 'Apps', sales: { orders: 1, totalSales: { amount: '4750.00' } } },
      {
        key: 'ONLINE_STORE',
        title: 'Online store',
        sales: { orders: 1, totalSales: { amount: '2499.00' } },
      },
    ]);
    const health = await gql(
      tokens.owner,
      `query ($from: DateTime!, $before: DateTime!) {
        codHealth(placedFrom: $from, placedBefore: $before, by: CAMPAIGN) {
          rows { key title confirmation { placed } }
        }
      }`,
      period,
    );
    expect(health.data?.codHealth.rows).toEqual([
      { key: 'Eid', title: 'Eid', confirmation: { placed: 1 } },
      { key: null, title: 'No campaign', confirmation: { placed: 1 } },
    ]);
  });
});
