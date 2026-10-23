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

describe.skipIf(!server)("Admin GraphQL API: products' barcodes and labels", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  let token = '';

  async function gql(query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    const { token: issued, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, hash, hint, ['write_products', 'read_products']],
    );
    token = issued;
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("gives variants without barcodes the shop's own, then prints their labels (ADR-757)", async () => {
    const { data } = await gql(
      `mutation ($input: ProductCreateInput!) {
         productCreate(input: $input) { product { id variants { id title } } userErrors { message } }
       }`,
      {
        input: {
          title: 'Peshawari Chappal',
          status: 'ACTIVE',
          options: [{ name: 'Size', values: ['9', '10'] }],
          variants: [
            { optionValues: ['9'], price: '3,499', compareAtPrice: '4200', sku: 'PC-09' },
            { optionValues: ['10'], price: '3699', barcode: '8964000123457' },
          ],
        },
      },
    );
    expect(data?.productCreate.userErrors).toEqual([]);
    const product = data?.productCreate.product;
    const [nine, ten] = product.variants as { id: string; title: string }[];

    const GIVE = `mutation ($ids: [ID!]!) {
      productVariantsBarcodesGive(productIds: $ids) { given had userErrors { message } }
    }`;
    expect((await gql(GIVE, { ids: [product.id] })).data?.productVariantsBarcodesGive).toEqual({
      given: 1,
      had: 1,
      userErrors: [],
    });
    const barcodes = await gql(`query ($id: ID!) { product(id: $id) { variants { barcode } } }`, {
      id: product.id,
    });
    const [given, kept] = (barcodes.data?.product.variants as { barcode: string }[]).map(
      (variant) => variant.barcode,
    );
    expect(given).toMatch(/^2\d{12}$/);
    expect(kept).toBe('8964000123457');
    // Again: each has one now, and keeps it.
    expect((await gql(GIVE, { ids: [product.id] })).data?.productVariantsBarcodesGive).toEqual({
      given: 0,
      had: 2,
      userErrors: [],
    });

    const LABELS = `query ($items: [ProductLabelItemInput!]!, $paper: ProductLabelPaper) {
      productLabels(items: $items, paper: $paper) { title html labels }
    }`;
    const printed = await gql(LABELS, {
      items: [
        { variantId: nine!.id, copies: 2 },
        { variantId: ten!.id, copies: 1 },
      ],
      paper: 'ROLL_50X25',
    });
    expect(printed.errors).toBeUndefined();
    const labels = printed.data?.productLabels;
    expect(labels).toMatchObject({ title: '3 labels', labels: 3 });
    expect(labels.html.match(/<article class="page">/g)).toHaveLength(3);
    expect(labels.html).toContain('Peshawari Chappal');
    expect(labels.html).toContain('<s>Rs 4,200</s>');
    expect(labels.html.match(new RegExp(`aria-label="${given}"`, 'g'))).toHaveLength(2);
    expect(labels.html).toContain('aria-label="8964000123457"');

    const refused = await gql(LABELS, { items: [{ variantId: nine!.id, copies: 0 }] });
    expect(refused.errors?.[0]?.message).toBe('must be at least 1');
  });
});
