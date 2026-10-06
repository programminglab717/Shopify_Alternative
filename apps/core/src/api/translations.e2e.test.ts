import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import { digestOf } from '@hatti/online-store/public';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface GraphQLResponse {
  data?: Record<string, Json> | null;
  errors?: { message: string; path?: string[]; extensions?: { code?: string } }[];
}

const RESOURCE = `resourceId
  translatableContent { key value digest locale type }
  translations(locale: "ur") { key value locale outdated }`;

describe.skipIf(!server)('Admin GraphQL API: translations', () => {
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

  async function gql(
    token: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<GraphQLResponse> {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
      payload: { query, variables },
    });
    return response.json() as GraphQLResponse;
  }

  /** Runs a query or mutation and returns its first field, failing the test on GraphQL errors. */
  async function call(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  const register = (token: string, resourceId: string, translations: unknown[]) =>
    call(
      token,
      `mutation ($id: ID!, $translations: [TranslationInput!]!) {
        translationsRegister(resourceId: $id, translations: $translations) {
          translations { key value locale outdated } userErrors { field code message }
        }
      }`,
      { id: resourceId, translations },
    );

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, [
      'write_translations',
      'write_products',
      'write_online_store_navigation',
    ]);
    tokens.reader = await issueToken(shopA, ['read_translations']);
    tokens.products = await issueToken(shopA, ['write_products']);
    tokens.b = await issueToken(shopB, ['write_translations']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("gives a product's fields to translate, keeps their Urdu, and removes it", async () => {
    const { product } = await call(
      tokens.a,
      `mutation {
        productCreate(input: { title: "Lawn Suit", description: "Soft lawn." }) {
          product { id } userErrors { field }
        }
      }`,
    );
    const own = await call(
      tokens.reader,
      `query ($id: ID!) { translatableResource(resourceId: $id) { ${RESOURCE} } }`,
      { id: product.id },
    );
    expect(own).toEqual({
      resourceId: product.id,
      translatableContent: [
        {
          key: 'title',
          value: 'Lawn Suit',
          digest: digestOf('Lawn Suit'),
          locale: 'en',
          type: 'SINGLE_LINE_TEXT_FIELD',
        },
        {
          key: 'body_html',
          value: '<p>Soft lawn.</p>',
          digest: digestOf('<p>Soft lawn.</p>'),
          locale: 'en',
          type: 'HTML',
        },
      ],
      translations: [],
    });

    expect(
      await register(tokens.a, product.id, [
        {
          locale: 'ur',
          key: 'title',
          value: 'لان سوٹ',
          translatableContentDigest: digestOf('Lawn Suit'),
        },
      ]),
    ).toEqual({
      translations: [{ key: 'title', value: 'لان سوٹ', locale: 'ur', outdated: false }],
      userErrors: [],
    });
    expect(
      await register(tokens.a, product.id, [
        { locale: 'ur', key: 'title', value: 'x', translatableContentDigest: digestOf('Lawn') },
      ]),
    ).toEqual({
      translations: null,
      userErrors: [
        {
          field: ['translations', '0', 'translatableContentDigest'],
          code: 'STALE',
          message: "The product's title has changed since it was read: read it again",
        },
      ],
    });

    // The product's title changes: its Urdu is outdated, and still kept.
    await call(
      tokens.a,
      `mutation ($id: ID!) {
        productUpdate(input: { id: $id, title: "Lawn Suit, 3 piece" }) { userErrors { field } }
      }`,
      { id: product.id },
    );
    const outdated = await call(
      tokens.reader,
      `query ($id: ID!) {
        translatableResource(resourceId: $id) {
          translations(locale: "ur", outdated: true) { key outdated }
          current: translations(locale: "ur", outdated: false) { key }
        }
      }`,
      { id: product.id },
    );
    expect(outdated).toEqual({ translations: [{ key: 'title', outdated: true }], current: [] });

    // Listed with the shop's other products, the newest first.
    const listed = await call(
      tokens.reader,
      `{ translatableResources(resourceType: PRODUCT, first: 5) {
          nodes { resourceId translations(locale: "ur") { value } }
          pageInfo { hasNextPage }
      } }`,
    );
    expect(listed).toEqual({
      nodes: [{ resourceId: product.id, translations: [{ value: 'لان سوٹ' }] }],
      pageInfo: { hasNextPage: false },
    });

    const removed = await call(
      tokens.a,
      `mutation ($id: ID!) {
        translationsRemove(resourceId: $id, translationKeys: ["title"], locales: ["ur"]) {
          translations { key value } userErrors { field }
        }
      }`,
      { id: product.id },
    );
    expect(removed).toEqual({ translations: [{ key: 'title', value: 'لان سوٹ' }], userErrors: [] });

    // Another shop's token finds nothing of it.
    expect(
      await call(
        tokens.b,
        `query ($id: ID!) { translatableResource(resourceId: $id) { resourceId } }`,
        { id: product.id },
      ),
    ).toBeNull();
  });

  it("translates a menu's items, refuses what is not translatable, and asks for the scopes", async () => {
    const { menu } = await call(
      tokens.a,
      `mutation {
        menuCreate(title: "Help", handle: "help", items: [{ title: "Track order", type: HTTP, url: "/pages/track" }]) {
          menu { id items { id } } userErrors { field }
        }
      }`,
    );
    const item = menu.items[0].id as string;
    expect(item).toMatch(/^mni_/);
    expect(
      await register(tokens.a, item, [
        {
          locale: 'ur',
          key: 'title',
          value: 'آرڈر ٹریک کریں',
          translatableContentDigest: digestOf('Track order'),
        },
      ]),
    ).toMatchObject({ translations: [{ key: 'title', value: 'آرڈر ٹریک کریں' }] });
    const links = await call(
      tokens.reader,
      `{ translatableResources(resourceType: LINK) { nodes { resourceId translatableContent { value } } } }`,
    );
    // The default menus' items too, which every shop has.
    expect(links.nodes).toContainEqual({
      resourceId: item,
      translatableContent: [{ value: 'Track order' }],
    });
    expect((links.nodes as Json[]).map((node) => node.translatableContent[0].value).sort()).toEqual(
      ['All products', 'Track order'],
    );

    // An order is not translated; nor is an ID that names nothing.
    for (const id of ['ord_01j9zk3m8q5v7w2x4y6z8a0b1c', 'nonsense']) {
      const body = await gql(
        tokens.reader,
        `query ($id: ID!) { translatableResource(resourceId: $id) { resourceId } }`,
        { id },
      );
      expect(body.errors?.[0]?.extensions?.code, id).toBe('BAD_USER_INPUT');
    }

    // Reading takes read_translations, and writing write_translations.
    for (const [token, query] of [
      [
        tokens.products,
        `{ translatableResources(resourceType: PRODUCT) { nodes { resourceId } } }`,
      ],
      [
        tokens.reader,
        `mutation { translationsRemove(resourceId: "${item}", translationKeys: ["title"], locales: ["ur"]) { userErrors { field } } }`,
      ],
    ] as const) {
      const body = await gql(token, query);
      expect(body.errors?.[0]?.extensions?.code, query).toBe('ACCESS_DENIED');
    }
  });

  it("translates a product's options and their values, by their own IDs (ADR-241)", async () => {
    const { product } = await call(
      tokens.a,
      `mutation {
        productCreate(input: {
          title: "Khussa", options: [{ name: "Size", values: ["38", "39"] }],
          variants: [{ optionValues: ["38"], price: "2,500" }, { optionValues: ["39"], price: "2,500" }]
        }) { product { options { id optionValues { id name } } } userErrors { field } }
      }`,
    );
    const [size] = product.options;
    expect(
      await register(tokens.a, size.id, [
        { locale: 'ur', key: 'name', value: 'سائز', translatableContentDigest: digestOf('Size') },
      ]),
    ).toEqual({
      translations: [{ key: 'name', value: 'سائز', locale: 'ur', outdated: false }],
      userErrors: [],
    });
    const values = await call(
      tokens.reader,
      `{ translatableResources(resourceType: PRODUCT_OPTION_VALUE) {
          nodes { resourceId translatableContent { key value type } }
      } }`,
    );
    expect(
      (values.nodes as Json[]).sort((a, b) =>
        a.translatableContent[0].value.localeCompare(b.translatableContent[0].value),
      ),
    ).toEqual(
      (size.optionValues as Json[]).map((value) => ({
        resourceId: value.id,
        translatableContent: [{ key: 'name', value: value.name, type: 'SINGLE_LINE_TEXT_FIELD' }],
      })),
    );
    const option = await call(
      tokens.reader,
      `query ($id: ID!) { translatableResource(resourceId: $id) { ${RESOURCE} } }`,
      { id: size.id },
    );
    expect(option).toMatchObject({
      resourceId: size.id,
      translatableContent: [{ key: 'name', value: 'Size', type: 'SINGLE_LINE_TEXT_FIELD' }],
      translations: [{ key: 'name', value: 'سائز', locale: 'ur', outdated: false }],
    });
  });

  it("translates the shop's own words for its home page, by the shop's ID (ADR-245)", async () => {
    await admin.query(
      `INSERT INTO online_store.preferences (shop_id, seo_title, seo_description)
       VALUES ($1, 'Zari Fashions: lawn in Lahore', 'Lawn and bridal, delivered.')`,
      [shopA],
    );
    const id = toPublicId('shop', shopA);
    const shops = await call(
      tokens.reader,
      `{ translatableResources(resourceType: SHOP) {
          nodes { resourceId translatableContent { key value type } }
      } }`,
    );
    expect(shops.nodes).toEqual([
      {
        resourceId: id,
        translatableContent: [
          {
            key: 'meta_title',
            value: 'Zari Fashions: lawn in Lahore',
            type: 'SINGLE_LINE_TEXT_FIELD',
          },
          {
            key: 'meta_description',
            value: 'Lawn and bridal, delivered.',
            type: 'MULTI_LINE_TEXT_FIELD',
          },
        ],
      },
    ]);
    const title = {
      locale: 'ur',
      key: 'meta_title',
      value: 'زری فیشنز: لاہور کی لان',
      translatableContentDigest: digestOf('Zari Fashions: lawn in Lahore'),
    };
    expect(await register(tokens.a, id, [title])).toEqual({
      translations: [
        { key: 'meta_title', value: 'زری فیشنز: لاہور کی لان', locale: 'ur', outdated: false },
      ],
      userErrors: [],
    });
    // Another shop is not its own to translate.
    expect(await register(tokens.b, id, [title])).toEqual({
      translations: null,
      userErrors: [{ field: ['resourceId'], code: 'NOT_FOUND', message: 'No such shop' }],
    });
  });
});
