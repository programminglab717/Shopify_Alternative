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

const CHECKLIST = '{ setupChecklist { steps { key done count } done total } }';

describe.skipIf(!server)('Admin GraphQL API: the setup checklist', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const other = newId();
  const tokens = { owner: '', products: '', other: '' };

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
      headers: { 'x-hatti-access-token': token, 'idempotency-key': newId() },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  /** Runs a mutation, failing the test on errors of any kind; its payload. */
  async function mutate(query: string, variables?: Record<string, unknown>) {
    const body = await gql(tokens.owner, query, variables);
    expect(body.errors).toBeUndefined();
    const payload = Object.values(body.data ?? {})[0] as Json;
    expect(payload.userErrors).toEqual([]);
    return payload;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'B')`, [
      shop,
      other,
    ]);
    tokens.owner = await issueToken(shop, [
      'write_products',
      'write_settings',
      'write_legal_policies',
    ]);
    tokens.products = await issueToken(shop, ['write_products']);
    tokens.other = await issueToken(other, ['read_settings']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('says what the shop has left to set up, from the shop as it is', async () => {
    const checklist = async (token = tokens.owner) =>
      (await gql(token, CHECKLIST)).data?.setupChecklist;
    const step = async (key: string) =>
      (await checklist()).steps.find((each: { key: string }) => each.key === key);
    // A new shop: open to shoppers, and nothing else yet.
    const fresh = {
      steps: [
        { key: 'PRODUCTS', done: false, count: 0 },
        { key: 'DELIVERY', done: false, count: null },
        { key: 'PAYMENTS', done: false, count: null },
        { key: 'POLICIES', done: false, count: 0 },
        { key: 'BRAND', done: false, count: null },
        { key: 'WHATSAPP', done: false, count: null },
        { key: 'OPEN', done: true, count: null },
      ],
      done: 1,
      total: 7,
    };
    expect(await checklist()).toEqual(fresh);

    // Products on sale: a draft isn't.
    const CREATE = `mutation ($input: ProductCreateInput!) {
      productCreate(input: $input) { product { id } userErrors { code } }
    }`;
    await mutate(CREATE, { input: { title: 'Ajrak draft', status: 'DRAFT' } });
    expect(await step('PRODUCTS')).toEqual({ key: 'PRODUCTS', done: false, count: 0 });
    const product = await mutate(CREATE, { input: { title: 'Sindhi Ajrak', status: 'ACTIVE' } });
    expect(await step('PRODUCTS')).toEqual({ key: 'PRODUCTS', done: true, count: 1 });

    await mutate(
      `mutation { deliverySettingsUpdate(input: { charge: "250" }) { userErrors { code } } }`,
    );
    await mutate(
      `mutation ($input: BankTransferSettingsInput!) {
        bankTransferSettingsUpdate(input: $input) { userErrors { code } }
      }`,
      {
        input: {
          account: { title: 'Zari', bankName: 'Meezan Bank', iban: 'PK36SCBL0000001123456702' },
        },
      },
    );
    // The four policies shoppers look for, a step of four.
    const POLICY = `mutation ($shopPolicy: ShopPolicyInput!) {
      shopPolicyUpdate(shopPolicy: $shopPolicy) { userErrors { code } }
    }`;
    for (const type of ['REFUND_POLICY', 'PRIVACY_POLICY']) {
      await mutate(POLICY, { shopPolicy: { type, body: '<p>Ours.</p>' } });
    }
    expect(await step('POLICIES')).toEqual({ key: 'POLICIES', done: false, count: 2 });
    for (const type of ['TERMS_OF_SERVICE', 'SHIPPING_POLICY']) {
      await mutate(POLICY, { shopPolicy: { type, body: '<p>Ours.</p>' } });
    }
    // Its logo, one of its files.
    const file = newId();
    await admin.query(
      `INSERT INTO files.files (shop_id, id, key, filename, content_type, size, status)
       VALUES ($1, $2, $3, 'logo.png', 'image/png', 2048, 'ready')`,
      [shop, file, `shops/${shop}/files/${file}/logo.png`],
    );
    await admin.query(`INSERT INTO files.brands (shop_id, logo_file_id) VALUES ($1, $2)`, [
      shop,
      file,
    ]);
    const PREFERENCES = `mutation ($input: OnlineStorePreferencesInput!) {
      onlineStorePreferencesUpdate(input: $input) { userErrors { code } }
    }`;
    await mutate(PREFERENCES, { input: { whatsappNumber: '0300 1234567' } });
    expect(await checklist()).toEqual({
      steps: fresh.steps.map((each) => ({
        ...each,
        done: true,
        count: each.key === 'PRODUCTS' ? 1 : each.key === 'POLICIES' ? 4 : null,
      })),
      done: 7,
      total: 7,
    });

    // Undone when it no longer holds: the store closed, its one product drafted again.
    await mutate(PREFERENCES, { input: { passwordEnabled: true, password: 'zari-2026' } });
    await mutate(
      `mutation ($input: ProductUpdateInput!) {
        productUpdate(input: $input) { userErrors { code } }
      }`,
      { input: { id: product.product.id, status: 'DRAFT' } },
    );
    expect(await checklist()).toMatchObject({
      steps: expect.arrayContaining([
        { key: 'PRODUCTS', done: false, count: 0 },
        { key: 'OPEN', done: false, count: null },
      ]),
      done: 5,
    });

    // The shop's settings' readers see it; each shop its own.
    const denied = await gql(tokens.products, CHECKLIST);
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    expect(await checklist(tokens.other)).toEqual(fresh);
  });
});
