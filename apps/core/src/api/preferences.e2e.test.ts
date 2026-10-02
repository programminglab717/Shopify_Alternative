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

const UPDATE = `mutation ($input: OnlineStorePreferencesInput!) {
  onlineStorePreferencesUpdate(input: $input) {
    preferences { whatsappNumber } userErrors { field code message }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: online store preferences', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', reader: '', themes: '', b: '', products: '' };

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
    tokens.themes = await issueToken(shopA, ['write_themes']);
    tokens.b = await issueToken(shopB, ['write_settings']);
    tokens.products = await issueToken(shopA, ['write_products']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("sets the shop's WhatsApp number, as the settings scopes allow", async () => {
    const read = async (token: string) =>
      (await gql(token, '{ onlineStorePreferences { whatsappNumber } }')).data
        ?.onlineStorePreferences;
    expect(await read(tokens.reader)).toEqual({ whatsappNumber: null });

    const set = await gql(tokens.a, UPDATE, { input: { whatsappNumber: '0300-1234567' } });
    expect(set.data?.onlineStorePreferencesUpdate).toEqual({
      preferences: { whatsappNumber: '+923001234567' },
      userErrors: [],
    });
    const refused = await gql(tokens.a, UPDATE, { input: { whatsappNumber: '1234' } });
    expect(refused.data?.onlineStorePreferencesUpdate).toEqual({
      preferences: null,
      userErrors: [
        {
          field: ['whatsappNumber'],
          code: 'INVALID',
          message: 'WhatsApp number must be a Pakistani mobile number, like 0300 1234567',
        },
      ],
    });
    expect(await read(tokens.reader)).toEqual({ whatsappNumber: '+923001234567' });
    // Another shop's are its own.
    expect(await read(tokens.b)).toEqual({ whatsappNumber: null });

    for (const [token, query] of [
      [tokens.themes, '{ onlineStorePreferences { whatsappNumber } }'],
      [
        tokens.reader,
        'mutation { onlineStorePreferencesUpdate(input: {}) { userErrors { code } } }',
      ],
    ] as const) {
      const body = await gql(token, query);
      expect(body.errors?.[0]?.extensions?.code, query).toBe('ACCESS_DENIED');
    }
  });

  it("closes the shop's storefront behind a password its staff can see again, and opens it", async () => {
    const PASSWORD = `mutation ($input: OnlineStorePreferencesInput!) {
      onlineStorePreferencesUpdate(input: $input) {
        preferences { passwordEnabled password passwordMessage } userErrors { field code message }
      }
    }`;
    const refused = await gql(tokens.a, PASSWORD, { input: { passwordEnabled: true } });
    expect(refused.data?.onlineStorePreferencesUpdate).toEqual({
      preferences: null,
      userErrors: [
        {
          field: ['password'],
          code: 'BLANK',
          message: 'Set a password before closing the storefront behind it',
        },
      ],
    });
    const closed = await gql(tokens.a, PASSWORD, {
      input: { passwordEnabled: true, password: 'eid-2026', passwordMessage: 'Opening soon.' },
    });
    expect(closed.data?.onlineStorePreferencesUpdate).toEqual({
      preferences: {
        passwordEnabled: true,
        password: 'eid-2026',
        passwordMessage: 'Opening soon.',
      },
      userErrors: [],
    });
    expect(
      (await gql(tokens.reader, '{ onlineStorePreferences { passwordEnabled password } }')).data
        ?.onlineStorePreferences,
    ).toEqual({ passwordEnabled: true, password: 'eid-2026' });
    const rules = await gql(
      tokens.a,
      `mutation ($input: OnlineStorePreferencesInput!) {
        onlineStorePreferencesUpdate(input: $input) {
          preferences { robotsTxtRules } userErrors { field code }
        }
      }`,
      { input: { robotsTxtRules: 'disallow: /collections/sale\nnoindex: /x' } },
    );
    expect(rules.data?.onlineStorePreferencesUpdate).toEqual({
      preferences: null,
      userErrors: [{ field: ['robotsTxtRules'], code: 'INVALID' }],
    });
    const opened = await gql(tokens.a, PASSWORD, { input: { passwordEnabled: false } });
    expect(opened.data?.onlineStorePreferencesUpdate.preferences).toEqual({
      passwordEnabled: false,
      password: 'eid-2026',
      passwordMessage: 'Opening soon.',
    });
  });

  it("sets the shop's link page, its products by their IDs (ADR-161)", async () => {
    const LINK_PAGE = `mutation ($input: OnlineStorePreferencesInput!) {
      onlineStorePreferencesUpdate(input: $input) {
        preferences { linkPage { bio links { title url } productIds } }
        userErrors { field code message }
      }
    }`;
    const created = await gql(
      tokens.products,
      `mutation {
        productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,499" }] }) {
          product { id }
        }
      }`,
    );
    const productId = created.data?.productCreate.product.id as string;
    expect(productId).toMatch(/^prod_/);
    const set = await gql(tokens.a, LINK_PAGE, {
      input: {
        linkPage: {
          bio: 'Kurtas for Eid.',
          links: [{ title: 'Eid', url: '/collections/eid' }],
          productIds: [productId],
        },
      },
    });
    expect(set.data?.onlineStorePreferencesUpdate).toEqual({
      preferences: {
        linkPage: {
          bio: 'Kurtas for Eid.',
          links: [{ title: 'Eid', url: '/collections/eid' }],
          productIds: [productId],
        },
      },
      userErrors: [],
    });
    const refused = await gql(tokens.a, LINK_PAGE, {
      input: { linkPage: { links: [{ title: 'Old site', url: 'http://zari.pk' }] } },
    });
    expect(refused.data?.onlineStorePreferencesUpdate.userErrors).toEqual([
      {
        field: ['linkPage', 'links', '0', 'url'],
        code: 'INVALID',
        message: 'Link must be a path on the store, like /collections/sale, or an https:// address',
      },
    ]);
    // Another shop's product is not one it may show.
    const theirs = await gql(tokens.b, LINK_PAGE, {
      input: { linkPage: { productIds: [productId] } },
    });
    expect(theirs.data?.onlineStorePreferencesUpdate.userErrors).toEqual([
      { field: ['linkPage', 'productIds', '0'], code: 'NOT_FOUND', message: 'Product not found' },
    ]);
    const malformed = await gql(tokens.a, LINK_PAGE, {
      input: { linkPage: { productIds: ['not-an-id'] } },
    });
    expect(malformed.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });
});
