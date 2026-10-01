import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { generateAccessToken } from '@hatti/api';
import { CollectionService } from '@hatti/catalog/public';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { printSchema } from 'graphql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();
const SCHEMA_FILE = new URL('../../schema.graphql', import.meta.url);

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface GraphQLResponse {
  data?: Record<string, Json> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

const PRODUCT_FIELDS = `
  id title handle status vendor tags version createdAt updatedAt
  options { id name position optionValues { id name hasVariants } }
  variants {
    id title sku price { amount currencyCode formatted } compareAtPrice { formatted }
    selectedOptions { name value } media { id }
  }
  media { id alt position status sourceUrl }
  priceRange { minVariantPrice { formatted } maxVariantPrice { formatted } }
`;

describe.skipIf(!server)('Admin GraphQL API', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', aReadOnly: '', b: '', revoked: '' };

  async function issueToken(shopId: string, scopes: string[], revoked = false): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes, revoked_at)
       VALUES ($1, 'test', $2, $3, $4, $5)`,
      [shopId, hash, hint, scopes, revoked ? new Date() : null],
    );
    return token;
  }

  async function gql(
    token: string | undefined,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ status: number; body: GraphQLResponse }> {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: token ? { 'x-hatti-access-token': token } : {},
      payload: { query, variables },
    });
    return { status: response.statusCode, body: response.json() as GraphQLResponse };
  }

  async function createProduct(token: string, input: Record<string, unknown>) {
    const { body } = await gql(
      token,
      `mutation ($input: ProductCreateInput!) {
         productCreate(input: $input) { product { ${PRODUCT_FIELDS} } userErrors { field code message } }
       }`,
      { input },
    );
    return body.data?.productCreate as {
      product: Record<string, Json> | null;
      userErrors: { field: string[]; code: string; message: string }[];
    };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Shop A', 'shop-a'), ($2, 'Shop B', 'shop-b')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, ['write_products']);
    tokens.aReadOnly = await issueToken(shopA, ['read_products']);
    tokens.b = await issueToken(shopB, ['write_products']);
    tokens.revoked = await issueToken(shopA, ['write_products'], true);

    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  describe('health', () => {
    it('reports liveness without checking dependencies', async () => {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });

    it('reports readiness with dependency checks', async () => {
      const response = await app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
    });

    it('echoes a well-formed request id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-request-id': 'req-123' },
      });
      expect(response.headers['x-request-id']).toBe('req-123');
    });
  });

  describe('authentication', () => {
    it.each([
      ['no token', undefined],
      ['a malformed token', 'not-a-token'],
      ['an unknown token', generateAccessToken().token],
      ['a revoked token', 'revoked'],
    ])('rejects %s with 401', async (_label, token) => {
      const { status, body } = await gql(
        token === 'revoked' ? tokens.revoked : token,
        '{ shop { name } }',
      );
      expect(status).toBe(401);
      expect(body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    });

    it('rejects tokens of a suspended shop', async () => {
      await admin.query(`UPDATE control.shops SET status = 'suspended' WHERE id = $1`, [shopB]);
      try {
        expect((await gql(tokens.b, '{ shop { name } }')).status).toBe(401);
      } finally {
        await admin.query(`UPDATE control.shops SET status = 'active' WHERE id = $1`, [shopB]);
      }
    });

    it("returns the token's shop, with its storefront's address", async () => {
      const { status, body } = await gql(
        tokens.a,
        '{ shop { id name handle url currencyCode timezone } }',
      );
      expect(status).toBe(200);
      expect(body.data?.shop).toMatchObject({
        name: 'Shop A',
        handle: 'shop-a',
        url: 'http://shop-a.localhost:4100',
        currencyCode: 'PKR',
        timezone: 'Asia/Karachi',
      });
      expect(body.data?.shop.id).toMatch(/^shop_[0-9a-z]{26}$/);
    });
  });

  describe('products', () => {
    it('creates a product with variants and formatted prices', async () => {
      const result = await createProduct(tokens.a, {
        title: 'Peshawari Chappal',
        status: 'ACTIVE',
        vendor: 'Qissa Khwani Footwear',
        tags: ['chappal'],
        options: [{ name: 'Size', values: ['9', '10'] }],
        variants: [
          { optionValues: ['9'], price: '3,499', compareAtPrice: '4200', sku: 'PC-09' },
          { optionValues: ['10'], price: '3699.50' },
        ],
      });
      expect(result.userErrors).toEqual([]);
      expect(result.product).toMatchObject({
        title: 'Peshawari Chappal',
        handle: 'peshawari-chappal',
        status: 'ACTIVE',
        version: 1,
        priceRange: {
          minVariantPrice: { formatted: 'Rs 3,499' },
          maxVariantPrice: { formatted: 'Rs 3,699.50' },
        },
      });
      expect(result.product?.id).toMatch(/^prod_[0-9a-z]{26}$/);
      expect(result.product?.variants[0]).toMatchObject({
        title: '9',
        sku: 'PC-09',
        price: { amount: '3499.00', currencyCode: 'PKR', formatted: 'Rs 3,499' },
        compareAtPrice: { formatted: 'Rs 4,200' },
        selectedOptions: [{ name: 'Size', value: '9' }],
      });
      expect(result.product?.variants[0].id).toMatch(/^var_/);
      expect(result.product?.options[0]).toMatchObject({ name: 'Size', position: 1 });
      expect(result.product?.options[0].id).toMatch(/^opt_/);
      expect(result.product?.options[0].optionValues[0].id).toMatch(/^optv_/);
    });

    it('records a product.created event in the same transaction', async () => {
      const result = await createProduct(tokens.a, { title: 'Sindhi Ajrak' });
      const { rows } = await admin.query(
        `SELECT shop_id, event_type FROM platform.outbox_events WHERE aggregate_id = (
           SELECT id FROM catalog.products WHERE shop_id = $1 AND handle = $2)`,
        [shopA, result.product?.handle],
      );
      expect(rows).toEqual([{ shop_id: shopA, event_type: 'product.created' }]);
    });

    it('returns user errors for invalid input', async () => {
      const result = await createProduct(tokens.a, {
        title: ' ',
        variants: [{ price: 'free' }],
      });
      expect(result.product).toBeNull();
      expect(result.userErrors).toEqual([
        { field: ['input', 'title'], code: 'BLANK', message: "Title can't be blank" },
        {
          field: ['input', 'variants', '0', 'price'],
          code: 'INVALID',
          message: 'Price must be an amount of zero or more, like 2499 or 2499.50',
        },
      ]);
    });

    it('enforces access scopes', async () => {
      const { status, body } = await gql(
        tokens.aReadOnly,
        'mutation { productCreate(input: { title: "Nope" }) { product { id } } }',
      );
      expect(status).toBe(200);
      expect(body.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
      expect(body.errors?.[0]?.message).toContain('write_products');
      const read = await gql(tokens.aReadOnly, '{ products(first: 1) { nodes { id } } }');
      expect(read.body.errors).toBeUndefined();
    });

    it('updates a product and bumps its version', async () => {
      const created = await createProduct(tokens.a, { title: 'Multani Khussa' });
      const { body } = await gql(
        tokens.a,
        `mutation ($input: ProductUpdateInput!) {
           productUpdate(input: $input) { product { title status version } userErrors { code } }
         }`,
        { input: { id: created.product?.id, title: 'Multani Khussa (Gold)', status: 'ACTIVE' } },
      );
      expect(body.data?.productUpdate).toEqual({
        product: { title: 'Multani Khussa (Gold)', status: 'ACTIVE', version: 2 },
        userErrors: [],
      });
    });

    it('searches with Roman Urdu spelling variants and pages through results', async () => {
      await createProduct(tokens.a, { title: 'Qameez Shalwar, Wash & Wear' });
      await createProduct(tokens.a, { title: 'Kurta Kameez' });
      const search = `query ($after: String) {
        products(first: 1, after: $after, query: "kamiz") {
          nodes { title } pageInfo { hasNextPage endCursor }
        }
      }`;
      const page1 = (await gql(tokens.a, search)).body.data?.products;
      expect(page1.nodes).toEqual([{ title: 'Kurta Kameez' }]);
      expect(page1.pageInfo.hasNextPage).toBe(true);
      const page2 = (await gql(tokens.a, search, { after: page1.pageInfo.endCursor })).body.data
        ?.products;
      expect(page2.nodes).toEqual([{ title: 'Qameez Shalwar, Wash & Wear' }]);
      expect(page2.pageInfo.hasNextPage).toBe(false);
    });

    it("filters products as Shopify's search syntax writes them (ADR-120)", async () => {
      await createProduct(tokens.a, {
        title: 'Chikankari Kurta',
        status: 'ACTIVE',
        vendor: 'Gul Ahmed',
        tags: ['eid'],
        variants: [{ price: '2,500', sku: 'KRT-001' }],
      });
      await createProduct(tokens.a, { title: 'Chikankari Suit', vendor: 'Khaadi' });
      const titles = async (query: string) => {
        const { body } = await gql(
          tokens.a,
          'query ($query: String) { products(first: 10, query: $query) { nodes { title } } }',
          { query },
        );
        return (body.data?.products as { nodes: { title: string }[] }).nodes.map((n) => n.title);
      };
      expect(await titles('chikankari status:active')).toEqual(['Chikankari Kurta']);
      expect(await titles('chikankari -vendor:"gul ahmed"')).toEqual(['Chikankari Suit']);
      expect(await titles('sku:KRT-001 tag:EID')).toEqual(['Chikankari Kurta']);

      const refused = await gql(
        tokens.a,
        '{ products(first: 5, query: "status:live") { nodes { id } } }',
      );
      expect(refused.body.errors?.[0]).toMatchObject({
        message: 'status is one of draft, active, archived, not live',
        extensions: { code: 'BAD_USER_INPUT' },
      });
    });

    it("answers a request it cannot read with 400, as the client's to fix", async () => {
      for (const payload of ['{"query": "{ shop { name } }",', '']) {
        const response = await app.inject({
          method: 'POST',
          url: ADMIN_GRAPHQL_PATH,
          headers: { 'x-hatti-access-token': tokens.a, 'content-type': 'application/json' },
          payload,
        });
        expect(response.statusCode, payload).toBe(400);
        const [error] = response.json<{ errors: { message: string; extensions: Json }[] }>().errors;
        expect(error!.extensions.code, payload).toBe('BAD_REQUEST');
        expect(error!.message, payload).toMatch(/json/i);
      }
    });

    it('rejects malformed ids and cursors', async () => {
      const badId = await gql(tokens.a, '{ product(id: "ord_123") { id } }');
      expect(badId.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      const badCursor = await gql(
        tokens.a,
        '{ products(first: 5, after: "abc") { nodes { id } } }',
      );
      expect(badCursor.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      const badPage = await gql(tokens.a, '{ products(first: 500) { nodes { id } } }');
      expect(badPage.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    });
  });

  describe('product options, variants and media', () => {
    it('changes variants in bulk and adds images', async () => {
      const created = await createProduct(tokens.a, {
        title: 'Lawn Kurta',
        options: [
          { name: 'Size', values: ['S', 'M'] },
          { name: 'Colour', values: ['Maroon'] },
        ],
      });
      const product = created.product!;
      expect(product.variants.map((v: Json) => v.title)).toEqual(['S / Maroon', 'M / Maroon']);

      const media = await gql(
        tokens.a,
        `mutation ($id: ID!, $media: [CreateMediaInput!]!) {
           productCreateMedia(productId: $id, media: $media) {
             media { id alt status } userErrors { field code }
           }
         }`,
        {
          id: product.id,
          media: [{ originalSource: 'https://cdn.example.com/kurta.jpg', alt: 'Front' }],
        },
      );
      const image = media.body.data?.productCreateMedia.media[0];
      expect(image).toMatchObject({ alt: 'Front', status: 'UPLOADED' });
      expect(image.id).toMatch(/^med_/);

      const update = await gql(
        tokens.a,
        `mutation ($id: ID!, $variants: [ProductVariantsBulkUpdateInput!]!) {
           productVariantsBulkUpdate(productId: $id, variants: $variants) {
             product { version }
             productVariants { title price { formatted } cost { formatted } weightGrams media { id } }
             userErrors { field code }
           }
         }`,
        {
          id: product.id,
          variants: [
            {
              id: product.variants[1].id,
              price: '2,650',
              cost: '1,300',
              weightGrams: 320,
              mediaId: image.id,
            },
          ],
        },
      );
      expect(update.body.data?.productVariantsBulkUpdate).toEqual({
        product: { version: 3 },
        productVariants: [
          {
            title: 'M / Maroon',
            price: { formatted: 'Rs 2,650' },
            cost: { formatted: 'Rs 1,300' },
            weightGrams: 320,
            media: { id: image.id },
          },
        ],
        userErrors: [],
      });

      const options = await gql(
        tokens.a,
        `mutation ($id: ID!) {
           productOptionsCreate(productId: $id, options: [{ name: "Fabric", values: ["Lawn"] }]) {
             product { options { name } variants { title } } userErrors { code }
           }
         }`,
        { id: product.id },
      );
      expect(options.body.data?.productOptionsCreate.product.variants).toEqual([
        { title: 'S / Maroon / Lawn' },
        { title: 'M / Maroon / Lawn' },
      ]);
    });

    it('deletes a product', async () => {
      const created = await createProduct(tokens.a, { title: 'Short-lived' });
      const { body } = await gql(
        tokens.a,
        `mutation ($id: ID!) {
           productDelete(input: { id: $id }) { deletedProductId userErrors { code } }
         }`,
        { id: created.product?.id },
      );
      expect(body.data?.productDelete).toEqual({
        deletedProductId: created.product?.id,
        userErrors: [],
      });
      const read = await gql(tokens.a, `query ($id: ID!) { product(id: $id) { id } }`, {
        id: created.product?.id,
      });
      expect(read.body.data?.product).toBeNull();
    });
  });

  describe('collections', () => {
    it('keeps a smart collection filled and pages through it in its sort order', async () => {
      for (const [title, price] of [
        ['Wedding Khussa', '4,500'],
        ['Wedding Clutch', '2,800'],
        ['Wedding Dupatta', '3,100'],
      ]) {
        await createProduct(tokens.a, { title, tags: ['wedding'], variants: [{ price }] });
      }
      const created = await gql(
        tokens.a,
        `mutation ($input: CollectionCreateInput!) {
           collectionCreate(input: $input) {
             collection { id handle sortOrder productsCount ruleSet { appliedDisjunctively rules { column relation condition } } }
             userErrors { field code message }
           }
         }`,
        {
          input: {
            title: 'Wedding',
            sortOrder: 'PRICE_ASC',
            ruleSet: { rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'wedding' }] },
          },
        },
      );
      const collection = created.body.data?.collectionCreate.collection;
      expect(collection).toMatchObject({
        handle: 'wedding',
        sortOrder: 'PRICE_ASC',
        productsCount: 3,
        ruleSet: {
          appliedDisjunctively: false,
          rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'wedding' }],
        },
      });
      expect(collection.id).toMatch(/^col_/);

      const page = `query ($handle: String!, $after: String) {
        collectionByHandle(handle: $handle) {
          products(first: 2, after: $after) { nodes { title } pageInfo { hasNextPage endCursor } }
        }
      }`;
      const first = (await gql(tokens.a, page, { handle: 'wedding' })).body.data?.collectionByHandle
        .products;
      expect(first.nodes.map((n: Json) => n.title)).toEqual(['Wedding Clutch', 'Wedding Dupatta']);
      const second = (
        await gql(tokens.a, page, { handle: 'wedding', after: first.pageInfo.endCursor })
      ).body.data?.collectionByHandle.products;
      expect(second.nodes.map((n: Json) => n.title)).toEqual(['Wedding Khussa']);
      expect(second.pageInfo.hasNextPage).toBe(false);
      // A real cursor with its price key edited by hand.
      const decoded = JSON.parse(Buffer.from(first.pageInfo.endCursor, 'base64url').toString());
      const tampered = Buffer.from(JSON.stringify({ ...decoded, k: '1; drop' })).toString(
        'base64url',
      );
      const bad = await gql(tokens.a, page, { handle: 'wedding', after: tampered });
      expect(bad.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

      const tags = await gql(tokens.a, '{ productTags(first: 5) }');
      expect(tags.body.data?.productTags).toContain('wedding');
    });

    it('lists the collections a product is in', async () => {
      const created = await createProduct(tokens.a, { title: 'Chunri Dupatta' });
      const collection = await gql(
        tokens.a,
        `mutation ($ids: [ID!]) {
           collectionCreate(input: { title: "Picks", products: $ids }) { collection { id } }
         }`,
        { ids: [created.product?.id] },
      );
      const { body } = await gql(
        tokens.a,
        `query ($id: ID!) { product(id: $id) { collections(first: 5) { nodes { id title } } } }`,
        { id: created.product?.id },
      );
      expect(body.data?.product.collections.nodes).toEqual([
        { id: collection.body.data?.collectionCreate.collection.id, title: 'Picks' },
      ]);
    });

    it('loads the collections of a page of products with one query', async () => {
      const ids: unknown[] = [];
      for (const title of ['Lawn Suit', 'Khussa', 'Ajrak']) {
        ids.push((await createProduct(tokens.a, { title })).product?.id);
      }
      await gql(
        tokens.a,
        `mutation ($ids: [ID!]) {
           collectionCreate(input: { title: "Eid Edit", products: $ids }) { collection { id } }
         }`,
        { ids },
      );
      const collectionsOf = vi.spyOn(app.get(CollectionService), 'collectionsOfProducts');
      try {
        const { body } = await gql(
          tokens.a,
          '{ products(first: 50) { nodes { title collections(first: 5) { nodes { title } } } } }',
        );
        expect(body.errors).toBeUndefined();
        const lawn = body.data?.products.nodes.find(
          (node: { title: string }) => node.title === 'Lawn Suit',
        );
        expect(lawn.collections.nodes).toEqual([{ title: 'Eid Edit' }]);
        expect(collectionsOf).toHaveBeenCalledTimes(1);
      } finally {
        collectionsOf.mockRestore();
      }
    });
  });

  describe('tenant isolation', () => {
    it("never exposes or changes another shop's products", async () => {
      const secret = await createProduct(tokens.a, { title: 'Shop A Secret Product' });
      const id = secret.product?.id as string;

      const read = await gql(tokens.b, `query ($id: ID!) { product(id: $id) { id title } }`, {
        id,
      });
      expect(read.body.data?.product).toBeNull();

      const list = await gql(tokens.b, '{ products(first: 250) { nodes { id } } }');
      expect(list.body.data?.products.nodes).toEqual([]);

      const search = await gql(
        tokens.b,
        '{ products(first: 5, query: "secret") { nodes { id } } }',
      );
      expect(search.body.data?.products.nodes).toEqual([]);

      const update = await gql(
        tokens.b,
        `mutation ($input: ProductUpdateInput!) {
           productUpdate(input: $input) { product { id } userErrors { code } }
         }`,
        { input: { id, title: 'Hijacked' } },
      );
      expect(update.body.data?.productUpdate).toEqual({
        product: null,
        userErrors: [{ code: 'NOT_FOUND' }],
      });

      const own = await gql(tokens.a, `query ($id: ID!) { product(id: $id) { title } }`, { id });
      expect(own.body.data?.product).toEqual({ title: 'Shop A Secret Product' });
    });

    it("never changes another shop's product parts or collections", async () => {
      const secret = await createProduct(tokens.a, {
        title: 'Shop A Kurta',
        options: [{ name: 'Size', values: ['S'] }],
      });
      const productId = secret.product?.id as string;
      const variantId = secret.product?.variants[0].id as string;
      const collection = await gql(
        tokens.a,
        `mutation ($ids: [ID!]) {
           collectionCreate(input: { title: "A only", products: $ids }) { collection { id } }
         }`,
        { ids: [productId] },
      );
      const collectionId = collection.body.data?.collectionCreate.collection.id as string;

      const attempts: [string, string, Record<string, unknown>][] = [
        [
          'productVariantsBulkUpdate',
          `mutation ($p: ID!, $v: ID!) { productVariantsBulkUpdate(productId: $p, variants: [{ id: $v, price: "1" }]) { userErrors { code } } }`,
          { p: productId, v: variantId },
        ],
        [
          'productVariantsBulkDelete',
          `mutation ($p: ID!, $v: ID!) { productVariantsBulkDelete(productId: $p, variantsIds: [$v]) { userErrors { code } } }`,
          { p: productId, v: variantId },
        ],
        [
          'productOptionsCreate',
          `mutation ($p: ID!) { productOptionsCreate(productId: $p, options: [{ name: "X", values: ["Y"] }]) { userErrors { code } } }`,
          { p: productId },
        ],
        [
          'productCreateMedia',
          `mutation ($p: ID!) { productCreateMedia(productId: $p, media: [{ originalSource: "https://x.example.com/a.jpg" }]) { userErrors { code } } }`,
          { p: productId },
        ],
        [
          'productDelete',
          `mutation ($p: ID!) { productDelete(input: { id: $p }) { userErrors { code } } }`,
          { p: productId },
        ],
        [
          'collectionAddProducts',
          `mutation ($c: ID!, $p: ID!) { collectionAddProducts(id: $c, productIds: [$p]) { userErrors { code } } }`,
          { c: collectionId, p: productId },
        ],
        [
          'collectionDelete',
          `mutation ($c: ID!) { collectionDelete(input: { id: $c }) { userErrors { code } } }`,
          { c: collectionId },
        ],
      ];
      for (const [name, query, variables] of attempts) {
        const { body } = await gql(tokens.b, query, variables);
        expect(body.data?.[name].userErrors, name).toEqual([{ code: 'NOT_FOUND' }]);
      }
      const read = await gql(tokens.b, `query ($c: ID!) { collection(id: $c) { id } }`, {
        c: collectionId,
      });
      expect(read.body.data?.collection).toBeNull();
      const own = await gql(
        tokens.a,
        `query ($p: ID!) { product(id: $p) { version variants { price { amount } } } }`,
        { p: productId },
      );
      expect(own.body.data?.product).toEqual({
        version: 1,
        variants: [{ price: { amount: '0.00' } }],
      });
    });
  });

  describe('schema', () => {
    it('matches the committed schema.graphql (UPDATE_SCHEMA=1 to accept changes)', async () => {
      const printed = `${printSchema(app.get(GraphQLSchemaHost).schema)}\n`;
      if (process.env.UPDATE_SCHEMA) await writeFile(SCHEMA_FILE, printed);
      const committed = await readFile(SCHEMA_FILE, 'utf8').catch(() => '');
      expect(printed).toBe(committed);
    });
  });
});
