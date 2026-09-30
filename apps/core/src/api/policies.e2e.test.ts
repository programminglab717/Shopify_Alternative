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

const UPDATE = `mutation ($shopPolicy: ShopPolicyInput!) {
  shopPolicyUpdate(shopPolicy: $shopPolicy) {
    shopPolicy { id type title body url } userErrors { field code message }
  }
}`;

describe.skipIf(!server)("Admin GraphQL API: the shop's policies", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', reader: '', b: '', pages: '' };

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
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  async function call(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari'), ($2, 'Other', 'other')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, ['write_legal_policies', 'write_settings']);
    tokens.reader = await issueToken(shopA, ['read_legal_policies']);
    tokens.b = await issueToken(shopB, ['write_legal_policies']);
    tokens.pages = await issueToken(shopA, ['write_online_store_pages']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('keeps the policies the shop sets, and lists them on the shop, where the storefront shows them', async () => {
    const set = await call(tokens.a, UPDATE, {
      shopPolicy: { type: 'REFUND_POLICY', body: '<p>7 days.</p><script>x()</script>' },
    });
    expect(set).toEqual({
      shopPolicy: {
        id: expect.stringMatching(/^pol_[0-9A-Za-z]+$/),
        type: 'REFUND_POLICY',
        title: 'Refund policy',
        body: '<p>7 days.</p>',
        url: 'http://zari.localhost:4100/policies/refund-policy',
      },
      userErrors: [],
    });
    await call(tokens.a, UPDATE, {
      shopPolicy: { type: 'PRIVACY_POLICY', body: '<p>Little.</p>' },
    });
    expect(await call(tokens.reader, '{ shop { shopPolicies { type url } } }')).toEqual({
      shopPolicies: [
        { type: 'REFUND_POLICY', url: 'http://zari.localhost:4100/policies/refund-policy' },
        { type: 'PRIVACY_POLICY', url: 'http://zari.localhost:4100/policies/privacy-policy' },
      ],
    });
    // Blank takes it away; another shop's are its own.
    expect(
      await call(tokens.a, UPDATE, { shopPolicy: { type: 'PRIVACY_POLICY', body: ' ' } }),
    ).toEqual({ shopPolicy: null, userErrors: [] });
    expect(await call(tokens.b, '{ shop { shopPolicies { type } } }')).toEqual({
      shopPolicies: [],
    });
  });

  it('drafts a policy from what the shop has set, in English or Urdu, saving nothing', async () => {
    await call(
      tokens.a,
      `mutation {
        deliverySettingsUpdate(input: { charge: "250", freeAbove: "5,000" }) { userErrors { code } }
      }`,
    );
    const draft = (type: string, locale?: string) =>
      gql(
        tokens.reader,
        `query ($type: ShopPolicyType!, $locale: String) {
          shopPolicyDraft(type: $type, locale: $locale) { type title body }
        }`,
        { type, ...(locale && { locale }) },
      );
    const shipping = (await draft('SHIPPING_POLICY')).data?.shopPolicyDraft;
    expect(shipping).toMatchObject({ type: 'SHIPPING_POLICY', title: 'Shipping policy' });
    expect(shipping.body).toContain('<p>Delivery is Rs 250 an order.</p>');
    expect(shipping.body).toContain('Delivery is free on orders of Rs 5,000 or more.');
    const urdu = (await draft('TERMS_OF_SERVICE', 'ur')).data?.shopPolicyDraft;
    expect(urdu).toMatchObject({ title: 'شرائط و ضوابط' });
    expect(urdu.body).toContain('http://zari.localhost:4100');
    expect((await draft('REFUND_POLICY', 'fr')).errors?.[0]?.extensions?.code).toBe(
      'BAD_USER_INPUT',
    );
    // Nothing was saved.
    expect(await call(tokens.reader, '{ shop { shopPolicies { type } } }')).toEqual({
      shopPolicies: [{ type: 'REFUND_POLICY' }],
    });
  });

  it('needs the legal policies scopes, as Shopify asks for them', async () => {
    const denied = async (token: string, query: string) =>
      (await gql(token, query)).errors?.[0]?.extensions?.code;
    expect(await denied(tokens.pages, '{ shop { shopPolicies { type } } }')).toBe('ACCESS_DENIED');
    expect(await denied(tokens.pages, '{ shopPolicyDraft(type: REFUND_POLICY) { body } }')).toBe(
      'ACCESS_DENIED',
    );
    expect(
      await denied(
        tokens.reader,
        'mutation { shopPolicyUpdate(shopPolicy: { type: REFUND_POLICY, body: "x" }) { userErrors { code } } }',
      ),
    ).toBe('ACCESS_DENIED');
  });
});
