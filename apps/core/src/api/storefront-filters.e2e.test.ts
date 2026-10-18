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

const READ = `{
  onlineStoreFilters {
    filters { kind key label labelUr defaultLabel metafieldType }
    availableFilters { kind key defaultLabel metafieldType }
  }
}`;

const UPDATE = `mutation ($input: OnlineStoreFiltersInput!) {
  onlineStoreFiltersUpdate(input: $input) {
    onlineStoreFilters { filters { kind key label labelUr defaultLabel } }
    userErrors { field code message }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: the filters a shop chooses (ADR-568)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', reader: '', products: '', b: '' };

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
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
    return response.json() as {
      data?: Record<string, Json> | null;
      errors?: { extensions?: { code?: string } }[];
    };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, ['write_settings']);
    tokens.reader = await issueToken(shopA, ['read_settings']);
    tokens.products = await issueToken(shopA, ['write_products']);
    tokens.b = await issueToken(shopB, ['write_settings']);
    api = await startTestApi(testDb);
    app = api.app;

    const product = await gql(
      tokens.products,
      `mutation ($input: ProductCreateInput!) {
         productCreate(input: $input) { userErrors { field } } }`,
      {
        input: {
          title: 'Lawn kurta',
          options: [{ name: 'Size', values: ['S', 'M'] }],
          variants: [
            { optionValues: ['S'], price: '2,500' },
            { optionValues: ['M'], price: '2,500' },
          ],
        },
      },
    );
    expect(product.data?.productCreate.userErrors).toEqual([]);
    for (const [ownerType, key, type, name] of [
      ['PRODUCT', 'material', 'single_line_text_field', 'Material'],
      ['PRODUCTVARIANT', 'handmade', 'boolean', 'Handmade'],
      ['PRODUCT', 'care', 'multi_line_text_field', 'Care'],
    ]) {
      const definition = await gql(
        tokens.products,
        `mutation ($definition: MetafieldDefinitionInput!) {
           metafieldDefinitionCreate(definition: $definition) { userErrors { field } } }`,
        { definition: { ownerType, namespace: 'custom', key, type, name } },
      );
      expect(definition.errors ?? definition.data?.metafieldDefinitionCreate.userErrors).toEqual(
        [],
      );
    }
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('reads none chosen and those the shop could choose, as the settings scopes allow', async () => {
    const read = (await gql(tokens.reader, READ)).data?.onlineStoreFilters;
    expect(read.filters).toBeNull();
    expect(read.availableFilters.map((each: Json) => [each.kind, each.key])).toEqual([
      ['AVAILABILITY', null],
      ['PRICE', null],
      ['PRODUCT_TYPE', null],
      ['VENDOR', null],
      ['OPTION', 'Size'],
      ['STITCHING', null],
      ['PIECES', null],
      ['FABRIC', null],
      ['SEASON', null],
      ['PRODUCT_METAFIELD', 'custom.material'],
      ['VARIANT_METAFIELD', 'custom.handmade'],
    ]);
    expect(read.availableFilters.at(-1)).toEqual({
      kind: 'VARIANT_METAFIELD',
      key: 'custom.handmade',
      defaultLabel: 'Handmade',
      metafieldType: 'boolean',
    });
    const refused = await gql(tokens.products, READ);
    expect(refused.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const write = await gql(tokens.reader, UPDATE, { input: { filters: [] } });
    expect(write.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });

  it('chooses the filters in their order and words, refuses what it cannot show, and resets', async () => {
    const set = await gql(tokens.a, UPDATE, {
      input: {
        filters: [
          { kind: 'VARIANT_METAFIELD', key: 'custom.handmade', labelUr: 'ہاتھ سے بنا' },
          { kind: 'OPTION', key: 'size' },
          { kind: 'PRICE', label: 'Budget' },
        ],
      },
    });
    expect(set.data?.onlineStoreFiltersUpdate).toEqual({
      onlineStoreFilters: {
        filters: [
          {
            kind: 'VARIANT_METAFIELD',
            key: 'custom.handmade',
            label: null,
            labelUr: 'ہاتھ سے بنا',
            defaultLabel: 'Handmade',
          },
          { kind: 'OPTION', key: 'size', label: null, labelUr: null, defaultLabel: 'Size' },
          { kind: 'PRICE', key: null, label: 'Budget', labelUr: null, defaultLabel: 'Price' },
        ],
      },
      userErrors: [],
    });
    expect((await gql(tokens.reader, READ)).data?.onlineStoreFilters.filters).toHaveLength(3);
    // Another shop's are its own.
    expect((await gql(tokens.b, READ)).data?.onlineStoreFilters.filters).toBeNull();

    const refused = await gql(tokens.a, UPDATE, {
      input: {
        filters: [
          { kind: 'PRODUCT_METAFIELD', key: 'custom.care' },
          { kind: 'PRODUCT_METAFIELD', key: 'custom.missing' },
          { kind: 'VENDOR', key: 'Zari' },
          { kind: 'PRICE' },
          { kind: 'PRICE', label: 'x'.repeat(61) },
        ],
      },
    });
    expect(refused.data?.onlineStoreFiltersUpdate.onlineStoreFilters).toBeNull();
    expect(
      refused.data?.onlineStoreFiltersUpdate.userErrors.map((error: Json) => [
        error.field.join('.'),
        error.code,
      ]),
    ).toEqual([
      ['input.filters.2.key', 'INVALID'],
      ['input.filters.4.label', 'TOO_LONG'],
      ['input.filters.4.kind', 'TAKEN'],
    ]);
    const unknown = await gql(tokens.a, UPDATE, {
      input: {
        filters: [
          { kind: 'PRODUCT_METAFIELD', key: 'custom.care' },
          { kind: 'PRODUCT_METAFIELD', key: 'custom.missing' },
        ],
      },
    });
    expect(
      unknown.data?.onlineStoreFiltersUpdate.userErrors.map((error: Json) => [
        error.field.join('.'),
        error.code,
      ]),
    ).toEqual([
      ['input.filters.0.key', 'INVALID'],
      ['input.filters.1.key', 'NOT_FOUND'],
    ]);

    const reset = await gql(tokens.a, UPDATE, { input: { filters: null } });
    expect(reset.data?.onlineStoreFiltersUpdate).toEqual({
      onlineStoreFilters: { filters: null },
      userErrors: [],
    });
    const { rows } = await admin.query<{ action: string }>(
      `SELECT action FROM platform.audit_log WHERE shop_id = $1 ORDER BY occurred_at`,
      [shopA],
    );
    expect(rows.map((row) => row.action)).toEqual([
      'storefront_filters.updated',
      'storefront_filters.updated',
    ]);
  });
});
