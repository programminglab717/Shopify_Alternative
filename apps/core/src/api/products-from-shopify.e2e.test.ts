import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { ShopifyStores } from './shopify-stores.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const IMPORT = `mutation ($store: String!, $accessToken: String, $clientId: String,
    $clientSecret: String, $dryRun: Boolean) {
  productsImportFromShopify(store: $store, accessToken: $accessToken, clientId: $clientId,
      clientSecret: $clientSecret, dryRun: $dryRun) {
    rows created variants images stocked rowErrorCount dryRun
    rowErrors { row column handle message }
    userErrors { field code message }
  }
}`;

/** A kurta in two sizes, stock tracked, with a photo and one at an http address; and a mug. */
const LINES = [
  {
    id: 'gid://shopify/Product/1',
    handle: 'cotton-kurta',
    title: 'Cotton Kurta',
    descriptionHtml: '<p>Soft cotton.</p>',
    vendor: 'Zari',
    productType: 'Kurtas',
    tags: ['Men', 'Eid'],
    status: 'ACTIVE',
    isGiftCard: false,
    seo: { title: null, description: null },
    category: null,
    options: [{ name: 'Size', position: 1 }],
  },
  {
    id: 'gid://shopify/MediaImage/11',
    image: { url: 'https://cdn.shopify.com/kurta.jpg', altText: 'Kurta' },
    __parentId: 'gid://shopify/Product/1',
  },
  {
    id: 'gid://shopify/MediaImage/12',
    image: { url: 'http://old.example/kurta-back.jpg', altText: null },
    __parentId: 'gid://shopify/Product/1',
  },
  ...[
    ['M', 'KUR-M', 7, 'DENY'],
    ['L', 'KUR-L', 2, 'CONTINUE'],
  ].map(([size, sku, quantity, policy], index) => ({
    id: `gid://shopify/ProductVariant/10${index}`,
    sku,
    price: '2499.00',
    compareAtPrice: null,
    barcode: null,
    taxable: true,
    inventoryPolicy: policy,
    inventoryQuantity: quantity,
    selectedOptions: [{ name: 'Size', value: size }],
    image: null,
    inventoryItem: {
      tracked: true,
      unitCost: null,
      measurement: { weight: { unit: 'GRAMS', value: 300 } },
    },
    __parentId: 'gid://shopify/Product/1',
  })),
  {
    id: 'gid://shopify/Product/2',
    handle: 'chai-mug',
    title: 'Chai Mug',
    descriptionHtml: '',
    vendor: '',
    productType: 'Mugs',
    tags: [],
    status: 'ACTIVE',
    isGiftCard: false,
    seo: { title: null, description: null },
    category: null,
    options: [{ name: 'Title', position: 1 }],
  },
  {
    id: 'gid://shopify/ProductVariant/201',
    sku: 'MUG-1',
    price: '1200.00',
    compareAtPrice: null,
    barcode: null,
    taxable: true,
    inventoryPolicy: 'DENY',
    inventoryQuantity: 0,
    selectedOptions: [{ name: 'Title', value: 'Default Title' }],
    image: null,
    inventoryItem: { tracked: false, unitCost: null, measurement: null },
    __parentId: 'gid://shopify/Product/2',
  },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

/** The store as Shopify would answer it, and what it was asked with. */
const store = {
  currency: 'PKR',
  status: 200,
  lines: LINES,
  tokens: [] as string[],
};

const shopify = new ShopifyStores(
  async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://storage.googleapis.com/')) return new Response(store.lines);
    if (url === 'https://zari-kurtas.myshopify.com/admin/oauth/access_token') {
      return Response.json({ access_token: 'shpat_from_client', expires_in: 86_399 });
    }
    store.tokens.push(new Headers(init?.headers).get('x-shopify-access-token') ?? '');
    if (store.status !== 200) return new Response('{}', { status: store.status });
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const data = query.includes('shop {')
      ? { shop: { name: 'Zari Kurtas', currencyCode: store.currency } }
      : query.includes('bulkOperationRunQuery')
        ? {
            bulkOperationRunQuery: {
              bulkOperation: { id: 'gid://shopify/BulkOperation/1', status: 'CREATED' },
              userErrors: [],
            },
          }
        : {
            node: {
              id: 'gid://shopify/BulkOperation/1',
              status: 'COMPLETED',
              url: 'https://storage.googleapis.com/shopify/products.jsonl',
            },
          };
    return Response.json({ data });
  },
  { sleep: async () => {} },
);

describe.skipIf(!server)("Admin GraphQL API: products from a Shopify store's Admin API", () => {
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
      [shop, hash, hint, ['write_products', 'write_inventory', 'read_products', 'read_inventory']],
    );
    token = issued;
    api = await startTestApi(testDb, { shopifyStores: shopify });
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(() => {
    Object.assign(store, { currency: 'PKR', status: 200, lines: LINES, tokens: [] });
  });

  it("reads the store's products, counts them in a dry run, then makes them with their stock (ADR-749)", async () => {
    const variables = { store: 'zari-kurtas', accessToken: ' shpat_owner ' };
    const dry = await gql(IMPORT, { ...variables, dryRun: true });
    expect(dry.data?.productsImportFromShopify).toMatchObject({
      created: 2,
      variants: 3,
      images: 1,
      stocked: 0,
      dryRun: true,
      userErrors: [],
    });
    expect(store.tokens.every((sent) => sent === 'shpat_owner')).toBe(true);

    const done = await gql(IMPORT, variables);
    expect(done.data?.productsImportFromShopify).toEqual({
      rows: 3,
      created: 2,
      variants: 3,
      images: 1,
      stocked: 2,
      rowErrorCount: 1,
      dryRun: false,
      // No file to look the row up in: the row's product is named.
      rowErrors: [
        {
          row: 3,
          column: 'Image Src',
          handle: 'cotton-kurta',
          message:
            'http://old.example/kurta-back.jpg is not an https address; the image is left out',
        },
      ],
      userErrors: [],
    });
    const { data } = await gql(
      `{ products(first: 10) { nodes {
          handle title description productType
          variants {
            sku
            inventoryItem { tracked inventoryPolicy inventoryLevels { onHand } } }
        } } }`,
    );
    const byHandle = (a: Json, b: Json) => String(a.handle).localeCompare(String(b.handle));
    expect([...(data?.products.nodes ?? [])].sort(byHandle)).toEqual([
      {
        handle: 'chai-mug',
        title: 'Chai Mug',
        description: '',
        productType: 'Mugs',
        variants: [
          {
            sku: 'MUG-1',
            inventoryItem: { tracked: false, inventoryPolicy: 'DENY', inventoryLevels: [] },
          },
        ],
      },
      {
        handle: 'cotton-kurta',
        title: 'Cotton Kurta',
        description: 'Soft cotton.',
        productType: 'Kurtas',
        variants: [
          {
            sku: 'KUR-M',
            inventoryItem: {
              tracked: true,
              inventoryPolicy: 'DENY',
              inventoryLevels: [{ onHand: 7 }],
            },
          },
          {
            sku: 'KUR-L',
            inventoryItem: {
              tracked: true,
              inventoryPolicy: 'CONTINUE',
              inventoryLevels: [{ onHand: 2 }],
            },
          },
        ],
      },
    ]);

    // Again, with a Dev Dashboard app's client ID and secret: the products are there already.
    store.tokens = [];
    const again = await gql(IMPORT, {
      store: 'https://admin.shopify.com/store/zari-kurtas',
      clientId: 'client',
      clientSecret: 'secret',
    });
    expect(again.data?.productsImportFromShopify).toMatchObject({ created: 0, userErrors: [] });
    expect(store.tokens).toEqual(['shpat_from_client', 'shpat_from_client', 'shpat_from_client']);
  });

  it('refuses what is not a Shopify store, no credentials, a store in another currency, or one that refuses', async () => {
    const errors = async (variables: Record<string, unknown>) =>
      (await gql(IMPORT, variables)).data?.productsImportFromShopify.userErrors;
    expect(await errors({ store: 'zari.pk', accessToken: 'shpat_1' })).toMatchObject([
      { field: ['store'], code: 'INVALID' },
    ]);
    expect(await errors({ store: 'zari-kurtas', clientId: 'only-the-id' })).toMatchObject([
      { field: ['accessToken'], code: 'BLANK' },
    ]);
    expect(store.tokens).toEqual([]);

    store.currency = 'USD';
    expect(await errors({ store: 'zari-kurtas', accessToken: 'shpat_1' })).toEqual([
      {
        field: ['store'],
        code: 'INVALID',
        message:
          "Zari Kurtas prices in USD, and Hatti's shops in rupees: export its products as a " +
          'CSV, change their prices to rupees and import the file',
      },
    ]);
    store.currency = 'PKR';
    store.lines = '';
    expect(await errors({ store: 'zari-kurtas', accessToken: 'shpat_1' })).toEqual([
      { field: ['store'], code: 'BLANK', message: 'Zari Kurtas has no products' },
    ]);
    store.status = 401;
    expect(await errors({ store: 'zari-kurtas', accessToken: 'shpat_wrong' })).toMatchObject([
      { field: ['accessToken'], code: 'INVALID' },
    ]);
    store.status = 503;
    expect(await errors({ store: 'zari-kurtas', accessToken: 'shpat_1' })).toMatchObject([
      { field: null, code: 'UNAVAILABLE' },
    ]);
  });
});
