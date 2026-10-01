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

const IMPORT = `mutation ($csv: String!, $dryRun: Boolean, $overwrite: Boolean) {
  productsImport(csv: $csv, dryRun: $dryRun, overwrite: $overwrite) {
    rows created updated variants images skipped stocked rowErrorCount dryRun
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
  /** Another shop, which a file exported from the first moves products to. */
  const other = newId();
  const tokens = { importer: '', productsOnly: '', other: '' };

  async function issueToken(scopes: string[], shopId = shop): Promise<string> {
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
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'Zari II')`, [
      shop,
      other,
    ]);
    tokens.importer = await issueToken(['write_products', 'write_inventory']);
    tokens.productsOnly = await issueToken(['write_products']);
    tokens.other = await issueToken(['write_products', 'write_inventory'], other);
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
      updated: 0,
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

  it("exports the shop's products as Shopify's CSV, which moves them to another shop", async () => {
    const EXPORT = '{ productsExport { csv productCount rowCount } }';
    const exported = (await gql(tokens.importer, EXPORT)).data?.productsExport;
    expect(exported).toMatchObject({ productCount: 2, rowCount: 3 });
    const lines = String(exported.csv).trim().split('\r\n');
    expect(lines[0]).toMatch(/^.?Handle,Title,Body \(HTML\),Vendor,Type,Tags,Published,/);
    // Each tracked variant's stock for sale online, oldest product first.
    expect(
      lines.slice(1).map((line) =>
        line
          .split(',')
          .slice(0, 1)
          .concat(line.match(/shopify,\d+,\w+/)?.[0] ?? ''),
      ),
    ).toEqual([
      ['cotton-kurta', 'shopify,7,deny'],
      ['cotton-kurta', 'shopify,2,continue'],
      ['chai-mug', ''],
    ]);
    // Without read_inventory, no stock: an import leaves stock alone.
    const productsOnly = (await gql(tokens.productsOnly, EXPORT)).data?.productsExport;
    expect(String(productsOnly.csv)).not.toContain('shopify,');

    const moved = await gql(tokens.other, IMPORT, { csv: exported.csv });
    expect(moved.data?.productsImport).toMatchObject({
      created: 2,
      variants: 3,
      images: 1,
      stocked: 2,
      rowErrorCount: 0,
    });
    const PRODUCTS = `{ products(first: 10) { nodes {
        handle title description tags vendor productType
        variants { sku price { amount } inventoryItem { tracked inventoryPolicy inventoryLevels { onHand } } }
        media { sourceUrl alt position }
      } } }`;
    const byHandle = (a: Json, b: Json) => String(a.handle).localeCompare(String(b.handle));
    const original = (await gql(tokens.importer, PRODUCTS)).data?.products.nodes;
    const copy = (await gql(tokens.other, PRODUCTS)).data?.products.nodes;
    expect([...copy].sort(byHandle)).toEqual([...original].sort(byHandle));

    // Filtered as the list is, and a search it doesn't take refused.
    const mugs = (
      await gql(
        tokens.importer,
        '{ productsExport(query: "product_type:mugs") { productCount rowCount } }',
      )
    ).data?.productsExport;
    expect(mugs).toEqual({ productCount: 1, rowCount: 1 });
    const refused = await gql(
      tokens.importer,
      '{ productsExport(query: "colour:red") { rowCount } }',
    );
    expect(refused.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it("updates the shop's products from its edited export with overwrite, keeping their stock", async () => {
    const csv = String(
      (await gql(tokens.importer, '{ productsExport { csv } }')).data?.productsExport.csv,
    )
      .replace('2499.00', '2599.00')
      .replace('Cotton Kurta', 'Cotton Kurta (Eid)');
    const updated = await gql(tokens.importer, IMPORT, { csv, overwrite: true });
    expect(updated.data?.productsImport).toMatchObject({
      created: 0,
      updated: 2,
      variants: 0,
      skipped: 0,
      stocked: 0,
      rowErrorCount: 0,
    });
    const { data } = await gql(
      tokens.importer,
      `{ products(first: 10, query: "handle:cotton-kurta") { nodes {
          title variants { sku price { amount } inventoryItem { inventoryLevels { onHand } } }
        } } }`,
    );
    // The first size's price changed; both keep the stock they had, whatever the file says.
    expect(data?.products.nodes).toEqual([
      {
        title: 'Cotton Kurta (Eid)',
        variants: [
          {
            sku: 'KUR-M',
            price: { amount: '2599.00' },
            inventoryItem: { inventoryLevels: [{ onHand: 7 }] },
          },
          {
            sku: 'KUR-L',
            price: { amount: '2499.00' },
            inventoryItem: { inventoryLevels: [{ onHand: 2 }] },
          },
        ],
      },
    ]);
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
