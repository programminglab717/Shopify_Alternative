import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { StorefrontApiClient, spinsPath } from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe.skipIf(!server)("Spin to win: the shop's wheel and shoppers' spins", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { write: '', read: '' };

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

  const FIELDS = `enabled codeDays minimumSubtotal { amount } spins codesUsed
    slices { label kind percentage amount { amount } weight }`;

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    tokens.write = await issueToken(['write_discounts']);
    tokens.read = await issueToken(['read_discounts']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('is set through the Admin API and spun through the storefront', async () => {
    const off = await gql(tokens.read, `{ spinWheel { ${FIELDS} } }`);
    expect(off.data?.spinWheel).toMatchObject({ enabled: false, slices: [], spins: 0 });

    const update = (token: string, spinWheel: Record<string, unknown>) =>
      gql(
        token,
        `mutation ($spinWheel: SpinWheelInput!) {
          spinWheelUpdate(spinWheel: $spinWheel) {
            spinWheel { ${FIELDS} } userErrors { field code message }
          }
        }`,
        { spinWheel },
      );
    expect((await update(tokens.read, { enabled: true })).errors?.[0]?.extensions?.code).toBe(
      'ACCESS_DENIED',
    );
    const refused = await update(tokens.write, { enabled: true });
    expect(refused.data?.spinWheelUpdate.userErrors).toEqual([
      {
        field: ['spinWheel', 'slices'],
        code: 'BLANK',
        message: 'A wheel turned on has 2 to 8 slices',
      },
    ]);
    const set = await update(tokens.write, {
      enabled: true,
      slices: [
        { label: 'Rs 300 off', kind: 'FIXED_AMOUNT', amount: '300', weight: 1 },
        { label: 'Free delivery', kind: 'FREE_SHIPPING', weight: 1 },
      ],
      minimumSubtotal: '1000',
    });
    expect(set.data?.spinWheelUpdate).toEqual({
      spinWheel: {
        enabled: true,
        codeDays: 7,
        minimumSubtotal: { amount: '1000.00' },
        spins: 0,
        codesUsed: 0,
        slices: [
          {
            label: 'Rs 300 off',
            kind: 'FIXED_AMOUNT',
            percentage: null,
            amount: { amount: '300.00' },
            weight: 1,
          },
          {
            label: 'Free delivery',
            kind: 'FREE_SHIPPING',
            percentage: null,
            amount: null,
            weight: 1,
          },
        ],
      },
      userErrors: [],
    });

    // The storefront's key alone.
    expect((await app.inject({ method: 'GET', url: spinsPath(shop) })).statusCode).toBe(401);
    await app.listen(0, '127.0.0.1');
    const client = new StorefrontApiClient({
      baseUrl: await app.getUrl(),
      key: TEST_STOREFRONT_KEY,
    });
    expect(await client.spinWheel(shop)).toEqual({
      slices: [{ label: 'Rs 300 off' }, { label: 'Free delivery' }],
    });
    expect(await client.spinWheel(newId())).toBeNull();
    expect(await client.spin(shop, { phone: '0300 12' })).toEqual({
      ok: false,
      errors: [
        { field: 'phone', message: 'Phone must be a Pakistani mobile number, like 0300 1234567' },
      ],
    });
    const result = await client.spin(shop, { phone: '0300-7654321' });
    expect(result).toMatchObject({ ok: true, again: false, code: expect.stringMatching(/^SPIN-/) });
    if (!result?.ok) throw new Error('Expected a spin');
    expect(['Rs 300 off', 'Free delivery'][result.slice]).toBe(result.label);
    expect(new Date(result.endsAt!).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(await client.spin(shop, { phone: '03007654321' })).toEqual({ ...result, again: true });

    const after = await gql(tokens.read, `{ spinWheel { spins } }`);
    expect(after.data?.spinWheel).toEqual({ spins: 1 });

    // Off, shoppers see no wheel.
    await update(tokens.write, { enabled: false });
    expect(await client.spinWheel(shop)).toBeNull();
    expect(await client.spin(shop, { phone: '0300-1112223' })).toBeNull();
  });
});
