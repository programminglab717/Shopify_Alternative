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

const SET = `mutation ($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id ownerId ownerType namespace key type value }
    userErrors { field code }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: metafields (CAT-06, ADR-489)', () => {
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

  it("sets products', variants' and collections' metafields, reads them, and keeps definitions", async () => {
    const created = await data(
      tokens.write,
      `mutation ($input: ProductCreateInput!) {
         productCreate(input: $input) { product { id variants { id } } } }`,
      { input: { title: 'Lawn kurta', status: 'ACTIVE' } },
    );
    const productId = created.product.id as string;
    const variantId = created.product.variants[0].id as string;
    const definition = await data(
      tokens.write,
      `mutation ($definition: MetafieldDefinitionInput!) {
         metafieldDefinitionCreate(definition: $definition) {
           createdDefinition { id ownerType namespace key type name metafieldsCount }
           userErrors { field code } } }`,
      {
        definition: {
          ownerType: 'PRODUCT',
          namespace: 'custom',
          key: 'care',
          type: 'multi_line_text_field',
          name: 'Care instructions',
        },
      },
    );
    expect(definition.createdDefinition).toMatchObject({
      id: expect.stringMatching(/^mfd_/),
      ownerType: 'PRODUCT',
      metafieldsCount: 0,
    });

    const set = await data(tokens.write, SET, {
      metafields: [
        // Its type its definition's.
        { ownerId: productId, namespace: 'custom', key: 'care', value: 'Hand wash' },
        {
          ownerId: variantId,
          namespace: 'custom',
          key: 'length_in',
          type: 'number_decimal',
          value: '42',
        },
      ],
    });
    expect(set.userErrors).toEqual([]);
    expect(set.metafields).toEqual([
      {
        id: expect.stringMatching(/^mtf_/),
        ownerId: productId,
        ownerType: 'PRODUCT',
        namespace: 'custom',
        key: 'care',
        type: 'multi_line_text_field',
        value: 'Hand wash',
      },
      expect.objectContaining({ ownerId: variantId, ownerType: 'PRODUCTVARIANT', value: '42.0' }),
    ]);
    const refused = await data(tokens.write, SET, {
      metafields: [
        { ownerId: 'ord_nope', namespace: 'custom', key: 'x1', value: 'y', type: 'json' },
      ],
    });
    expect(refused).toEqual({
      metafields: null,
      userErrors: [{ field: ['metafields', '0', 'ownerId'], code: 'NOT_FOUND' }],
    });

    const read = await data(
      tokens.read,
      `query ($id: ID!) { product(id: $id) {
         metafields { key value }
         care: metafield(namespace: "custom", key: "care") { value }
         variants { metafields(namespace: "custom") { key type value } } } }`,
      { id: productId },
    );
    expect(read).toEqual({
      metafields: [{ key: 'care', value: 'Hand wash' }],
      care: { value: 'Hand wash' },
      variants: [{ metafields: [{ key: 'length_in', type: 'number_decimal', value: '42.0' }] }],
    });
    const definitions = await data(
      tokens.read,
      '{ metafieldDefinitions(ownerType: PRODUCT) { name metafieldsCount } }',
    );
    expect(definitions).toEqual([{ name: 'Care instructions', metafieldsCount: 1 }]);

    // Deleted by owner, namespace and key; and the scopes stand.
    const deleted = await data(
      tokens.write,
      `mutation ($metafields: [MetafieldIdentifierInput!]!) {
         metafieldsDelete(metafields: $metafields) {
           deletedMetafields { ownerId key } userErrors { field } } }`,
      { metafields: [{ ownerId: productId, namespace: 'custom', key: 'care' }] },
    );
    expect(deleted.deletedMetafields).toEqual([{ ownerId: productId, key: 'care' }]);
    const denied = await gql(tokens.read, SET, {
      metafields: [{ ownerId: productId, namespace: 'custom', key: 'care', value: 'x' }],
    });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    expect((await gql(tokens.orders, '{ metafieldDefinitions { id } }')).errors).toBeDefined();
  });
});
