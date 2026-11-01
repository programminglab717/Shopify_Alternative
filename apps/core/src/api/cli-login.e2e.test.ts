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

const DESCRIBE = `query ($code: String!) {
  cliLogin(code: $code) { code device access requestedFrom status expiresAt } }`;
const APPROVE = `mutation ($code: String!, $access: CliLoginAccess!) {
  cliLoginApprove(code: $code, access: $access) { appName scopes userErrors { field code message } } }`;
const DENY = `mutation ($code: String!) { cliLoginDeny(code: $code) { denied } }`;

describe.skipIf(!server)("Admin API: a terminal's hatti login (DEV-08, ADR-990)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  const shop = newId();
  let owner: string;

  const post = (url: string, payload: unknown, token?: string) =>
    api.app.inject({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  async function account(role: StaffRole): Promise<string> {
    const email = `cli-${randomBytes(4).toString('hex')}@example.pk`;
    const signedUp = await post('/auth/sign-up', { email, password: PASSWORD, name: 'Sana Iqbal' });
    expect(signedUp.statusCode).toBe(201);
    const body = signedUp.json() as { accessToken: string; user: { id: string } };
    await admin.query(
      'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
      [fromPublicId(body.user.id, 'user'), shop, role],
    );
    const setup = await post('/auth/two-step/totp/setup', {}, body.accessToken);
    const { secret } = setup.json() as { secret: string };
    const code = totp(base32Decode(secret), Date.now());
    expect((await post('/auth/two-step/totp/confirm', { code }, body.accessToken)).statusCode).toBe(
      200,
    );
    return body.accessToken;
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
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  async function data(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  const begin = async (payload: Record<string, unknown> = {}) => {
    const response = await post('/cli/login', payload);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return response.json() as Json;
  };
  const poll = async (deviceCode: string) => {
    const response = await post('/cli/login/token', { device_code: deviceCode });
    return { status: response.statusCode, body: response.json() as Json };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    await admin.query(
      `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
       SELECT id, 'growth', 'monthly', now(), now() + interval '1 month' FROM control.shops`,
    );
    api = await startTestApi(testDb);
    owner = await account('owner');
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('lets a terminal in read-only once the owner approves it, its token given once, then gives it up', async () => {
    const begun = await begin({ device: 'sana-laptop', access: 'read' });
    expect(begun).toMatchObject({
      user_code: expect.stringMatching(/^[B-Z]{4}-[B-Z]{4}$/),
      device_code: expect.any(String),
      verification_uri: expect.stringMatching(/\/cli-login$/),
      expires_in: 600,
      interval: 5,
    });
    expect(begun.verification_uri_complete).toBe(
      `${begun.verification_uri}?code=${begun.user_code}`,
    );
    expect(await poll(begun.device_code)).toEqual({
      status: 400,
      body: { error: 'authorization_pending', error_description: expect.any(String) },
    });

    // As typed, in small letters and without its hyphen.
    const typed = begun.user_code.toLowerCase().replace('-', ' ');
    expect(await data(owner, DESCRIBE, { code: typed })).toMatchObject({
      code: begun.user_code,
      device: 'sana-laptop',
      access: 'READ',
      status: 'PENDING',
    });

    const approved = await data(owner, APPROVE, { code: begun.user_code, access: 'READ' });
    expect(approved.userErrors).toEqual([]);
    expect(approved.appName).toBe('Hatti CLI · sana-laptop');
    expect(approved.scopes.length).toBeGreaterThan(3);
    expect(approved.scopes.every((scope: string) => scope.startsWith('read_'))).toBe(true);
    // Approved once: a second approval makes no second app.
    expect(
      (await data(owner, APPROVE, { code: begun.user_code, access: 'WRITE' })).userErrors[0].code,
    ).toBe('NOT_FOUND');

    const fetched = await poll(begun.device_code);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual({
      access_token: expect.stringMatching(/^hat_/),
      shop_id: toPublicId('shop', shop),
      scope: approved.scopes.join(','),
    });
    expect((await poll(begun.device_code)).body.error).toBe('expired_token');

    const token = fetched.body.access_token as string;
    expect(await data(token, '{ shop { name } }')).toEqual({ name: 'Zari' });
    expect(await data(token, '{ accessScopes }')).toEqual(approved.scopes);
    // Read-only: it changes nothing.
    const refused = await gql(
      token,
      `mutation { productCreate(input: { title: "Lawn suit" }) { userErrors { message } } }`,
    );
    expect(refused.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    // The shop's apps list it, as any custom app.
    const apps = await data(owner, '{ customApps { name scopes } }');
    expect(apps).toContainEqual({ name: 'Hatti CLI · sana-laptop', scopes: approved.scopes });

    // hatti logout: the token gives itself up, and stops working.
    const revoked = await data(
      token,
      'mutation { accessTokenRevoke { deletedCustomAppId userErrors { message } } }',
    );
    expect(revoked.userErrors).toEqual([]);
    expect((await gql(token, '{ shop { name } }')).errors?.[0]?.extensions?.code).toBe(
      'UNAUTHENTICATED',
    );
    expect(await data(owner, '{ customApps { name } }')).not.toContainEqual({
      name: 'Hatti CLI · sana-laptop',
    });
  });

  it("gives read and write as the approver's role holds them", async () => {
    const begun = await begin({ device: 'build box' });
    const approved = await data(owner, APPROVE, { code: begun.user_code, access: 'WRITE' });
    expect(approved.scopes).toContain('write_products');
    const token = (await poll(begun.device_code)).body.access_token as string;
    const made = await data(
      token,
      `mutation { productCreate(input: { title: "Lawn suit" }) { product { title } userErrors { message } } }`,
    );
    expect(made).toEqual({ product: { title: 'Lawn suit' }, userErrors: [] });
  });

  it('tells a refused terminal so, and gives it nothing', async () => {
    const begun = await begin();
    expect(await data(owner, DENY, { code: begun.user_code })).toEqual({ denied: true });
    expect((await poll(begun.device_code)).body.error).toBe('access_denied');
    expect((await poll(begun.device_code)).body.error).toBe('expired_token');
    expect(await data(owner, DESCRIBE, { code: begun.user_code })).toBeNull();
  });

  it('is approved by the owner and managers alone, and not for a code it never gave', async () => {
    const begun = await begin();
    const packer = await account('packer');
    const refused = await gql(packer, APPROVE, { code: begun.user_code, access: 'READ' });
    expect(refused.errors?.[0]?.message).toMatch(/owner or a manager|Access denied/);
    expect(
      (await data(owner, APPROVE, { code: 'BCDF-GHJK', access: 'READ' })).userErrors[0].code,
    ).toBe('NOT_FOUND');
    expect(await data(owner, DESCRIBE, { code: 'not a code' })).toBeNull();
    expect((await poll('no-such-device')).body.error).toBe('expired_token');
    expect((await post('/cli/login/token', {})).statusCode).toBe(400);
  });

  it("refuses a staff member's session giving up a token it does not have", async () => {
    const answer = await data(
      owner,
      'mutation { accessTokenRevoke { deletedCustomAppId userErrors { message } } }',
    );
    expect(answer.deletedCustomAppId).toBeNull();
    expect(answer.userErrors[0].message).toMatch(/Only an app/);
  });
});
