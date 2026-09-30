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

const IMPORT = `mutation ($csv: String!, $dryRun: Boolean) {
  productsImport(csv: $csv, dryRun: $dryRun) {
    rows created variants images skipped stocked rowErrorCount dryRun
    rowErrors { row column message }
    userErrors { field code message }
  }
}`;

/** Two products as Shopify exports them: a kurta in two sizes, stock tracked, and a mug. */
const CSV = [
  'Handle,Title,Body (HTML),Vendor,Type,Tags,Published,Option1 Name,Option1 Value,' +
    'Variant SKU,Variant Grams,Variant Inventory Tracker,Variant Inventory Qty,' +
    'Variant Inventory Policy,Variant Price,Image Src,Image Position,Status',
  'cotton-kurta,Cotton Kurta,<p>Soft cotton.</p>,Zari,Kurtas,"Men, Eid",TRUE,Size,M,KUR-M,' +
    '300,shopify,7,deny,2499.00,https://cdn.shopify.com/kurta.jpg,1,active',
  'cotton-kurta,,,,,,,,L,KUR-L,300,shopify,2,continue,2499.00,,,',
  'chai-mug,Chai Mug,,,Mugs,,TRUE,Title,Default Title,MUG-1,350,,,deny,1200.00,,,active',
].join('\r\n');

describe.skipIf(!server)('Admin GraphQL API: products from a Shopify export', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { importer: '', productsOnly: '' };

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
    tokens.importer = await issueToken(['write_products', 'write_inventory']);
    tokens.productsOnly = await issueToken(['write_products']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('checks the file in a dry run, then makes the products with the stock Shopify tracked', async () => {
    const dry = await gql(tokens.importer, IMPORT, { csv: CSV, dryRun: true });
    expect(dry.data?.productsImport).toMatchObject({
      rows: 3,
      created: 2,
      variants: 3,
      images: 1,
      stocked: 0,
      dryRun: true,
      userErrors: [],
    });

    const done = await gql(tokens.importer, IMPORT, { csv: CSV });
    expect(done.data?.productsImport).toEqual({
      rows: 3,
      created: 2,
      variants: 3,
      images: 1,
      skipped: 0,
      stocked: 2,
      rowErrorCount: 0,
      dryRun: false,
      rowErrors: [],
      userErrors: [],
    });
    const { data } = await gql(
      tokens.importer,
      `{ products(first: 10) { nodes {
          handle title status description tags
          variants {
            sku price { amount }
            inventoryItem { tracked inventoryPolicy inventoryLevels { onHand } }
          }
        } } }`,
    );
    const byHandle = (a: Json, b: Json) => String(a.handle).localeCompare(String(b.handle));
    expect([...(data?.products.nodes ?? [])].sort(byHandle)).toEqual([
      {
        handle: 'chai-mug',
        title: 'Chai Mug',
        status: 'ACTIVE',
        description: '',
        tags: [],
        variants: [
          {
            sku: 'MUG-1',
            price: { amount: '1200.00' },
            inventoryItem: { tracked: false, inventoryPolicy: 'DENY', inventoryLevels: [] },
          },
        ],
      },
      {
        handle: 'cotton-kurta',
        title: 'Cotton Kurta',
        status: 'ACTIVE',
        description: 'Soft cotton.',
        tags: ['Men', 'Eid'],
        variants: [
          {
            sku: 'KUR-M',
            price: { amount: '2499.00' },
            inventoryItem: {
              tracked: true,
              inventoryPolicy: 'DENY',
              inventoryLevels: [{ onHand: 7 }],
            },
          },
          {
            sku: 'KUR-L',
            price: { amount: '2499.00' },
            inventoryItem: {
              tracked: true,
              inventoryPolicy: 'CONTINUE',
              inventoryLevels: [{ onHand: 2 }],
            },
          },
        ],
      },
    ]);

    // Again, nothing more: the shop has those handles.
    const again = await gql(tokens.importer, IMPORT, { csv: CSV });
    expect(again.data?.productsImport).toMatchObject({ created: 0, skipped: 2, stocked: 0 });
  });

  it('needs the products and inventory scopes, and says what is wrong with a file', async () => {
    const denied = await gql(tokens.productsOnly, IMPORT, { csv: CSV });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const wrong = await gql(tokens.importer, IMPORT, { csv: 'Phone,Name\n+923001234567,Ayesha' });
    expect(wrong.data?.productsImport.userErrors).toEqual([
      {
        field: ['csv'],
        code: 'INVALID',
        message: expect.stringContaining('The file needs Handle and Title columns'),
      },
    ]);
  });
});
