import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { StaffRole } from '@hatti/api';
import { base32Decode, totp } from '@hatti/crypto';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();
const PASSWORD = 'correct horse battery staple';

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const APP = 'id name scopes tokenHint secretHint createdById';

const CREATE = `mutation ($input: CustomAppInput!) {
  customAppCreate(input: $input) {
    customApp { ${APP} } accessToken webhookSecret userErrors { field code message } } }`;

describe.skipIf(!server)('Admin GraphQL API: custom apps (DEV-04, ADR-395)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  const shop = newId();

  const post = (url: string, payload: unknown, token?: string) =>
    api.app.inject({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  /** An account in the shop in `role`, signed in with a second factor where the role needs one. */
  async function account(role: StaffRole): Promise<{ token: string; userId: string }> {
    const email = `apps-${randomBytes(4).toString('hex')}@example.pk`;
    const signedUp = await post('/auth/sign-up', { email, password: PASSWORD, name: 'Sana Iqbal' });
    expect(signedUp.statusCode).toBe(201);
    const body = signedUp.json() as { accessToken: string; user: { id: string } };
    const userId = fromPublicId(body.user.id, 'user');
    await admin.query(
      'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
      [userId, shop, role],
    );
    const setup = await post('/auth/two-step/totp/setup', {}, body.accessToken);
    const { secret } = setup.json() as { secret: string };
    const code = totp(base32Decode(secret), Date.now());
    expect((await post('/auth/two-step/totp/confirm', { code }, body.accessToken)).statusCode).toBe(
      200,
    );
    return { token: body.accessToken, userId };
  }

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: token.startsWith('hat_')
        ? { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() }
        : {
            authorization: `Bearer ${token}`,
            'x-hatti-shop-id': toPublicId('shop', shop),
            'idempotency-key': randomUUID(),
          },
      payload: { query, variables },
    });
    return {
      status: response.statusCode,
      ...(response.json() as { data?: Record<string, Json> | null; errors?: Json[] }),
    };
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
    api = await startTestApi(testDb);
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('is made by the owner, its token acting for the shop, and removed', async () => {
    const owner = await account('owner');
    const made = await data(owner.token, CREATE, {
      input: { name: 'Accounting sync', scopes: ['read_locations', 'read_orders'] },
    });
    expect(made.userErrors).toEqual([]);
    expect(made.customApp).toMatchObject({
      name: 'Accounting sync',
      scopes: ['read_locations', 'read_orders'],
      tokenHint: made.accessToken.slice(-4),
      secretHint: made.webhookSecret.slice(-4),
      createdById: toPublicId('user', owner.userId),
    });
    expect(made.customApp.id).toMatch(/^tok_/);

    // Its token reads what its scopes allow, and manages no apps.
    expect((await gql(made.accessToken, '{ location { id } }')).errors).toBeUndefined();
    const denied = await gql(made.accessToken, `{ customApps { id } }`);
    expect(denied.errors?.[0].extensions.code).toBe('ACCESS_DENIED');
    expect((await gql(made.accessToken, '{ products(first: 1) { nodes { id } } }')).errors).toEqual(
      [expect.objectContaining({ extensions: expect.objectContaining({ code: 'ACCESS_DENIED' }) })],
    );

    expect(await data(owner.token, `{ customApps { ${APP} } }`)).toEqual([made.customApp]);

    // A new token: the old one stops working.
    const rotated = await data(
      owner.token,
      `mutation ($id: ID!) { customAppTokenRotate(id: $id) {
         accessToken userErrors { code } } }`,
      { id: made.customApp.id },
    );
    expect((await gql(made.accessToken, '{ location { id } }')).status).toBe(401);
    expect((await gql(rotated.accessToken, '{ location { id } }')).errors).toBeUndefined();

    const deleted = await data(
      owner.token,
      `mutation ($id: ID!) { customAppDelete(id: $id) { deletedCustomAppId userErrors { code } } }`,
      { id: made.customApp.id },
    );
    expect(deleted).toEqual({ deletedCustomAppId: made.customApp.id, userErrors: [] });
    expect((await gql(rotated.accessToken, '{ location { id } }')).status).toBe(401);
    expect(await data(owner.token, `{ customApps { id } }`)).toEqual([]);
  });

  it('is for the owner and managers alone, who give no scope their role lacks', async () => {
    const marketer = await account('marketer');
    const denied = await gql(marketer.token, CREATE, {
      input: { name: 'Ads', scopes: ['read_orders'] },
    });
    expect(denied.errors?.[0].extensions.code).toBe('ACCESS_DENIED');

    const manager = await account('manager');
    const refused = await data(manager.token, CREATE, {
      input: { name: 'Everything', scopes: ['write_orders', 'read_everything'] },
    });
    expect(refused).toMatchObject({
      customApp: null,
      accessToken: null,
      webhookSecret: null,
      userErrors: [{ field: ['input', 'scopes'], code: 'INVALID' }],
    });
  });
});
