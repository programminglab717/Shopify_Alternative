import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { generateAccessToken, type StaffRole } from '@hatti/api';
import { base32Decode, totp } from '@hatti/crypto';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();
const PASSWORD = 'correct horse battery staple';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

describe.skipIf(!server)('staff sign-in and Admin API access', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  const shopA = newId();
  const shopB = newId();

  const post = (url: string, payload: unknown, token?: string) =>
    api.app.inject({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  const get = (url: string, token: string) =>
    api.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  async function signUp(): Promise<Tokens & { email: string; userId: string }> {
    const email = `staff-${randomBytes(4).toString('hex')}@example.pk`;
    const response = await post('/auth/sign-up', { email, password: PASSWORD, name: 'Sana Iqbal' });
    expect(response.statusCode).toBe(201);
    const body = response.json() as Tokens & { user: { id: string } };
    return { ...body, email, userId: fromPublicId(body.user.id, 'user') };
  }

  const grant = (userId: string, shopId: string, role: StaffRole) =>
    admin.query('INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)', [
      userId,
      shopId,
      role,
    ]);

  const graphql = (token: string, shopId: string | null, query: string) =>
    api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: {
        authorization: `Bearer ${token}`,
        ...(shopId ? { 'x-hatti-shop-id': toPublicId('shop', shopId) } : {}),
      },
      payload: { query },
    });

  const code = (secret: string, offsetMs = 0) => totp(base32Decode(secret), Date.now() + offsetMs);

  async function enableTwoStep(accessToken: string): Promise<string> {
    const setup = await post('/auth/two-step/totp/setup', {}, accessToken);
    expect(setup.statusCode).toBe(200);
    const { secret } = setup.json() as { secret: string };
    const confirm = await post('/auth/two-step/totp/confirm', { code: code(secret) }, accessToken);
    expect(confirm.statusCode).toBe(200);
    expect((confirm.json() as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);
    return secret;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    api = await startTestApi(testDb);
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  describe('/auth', () => {
    it('signs up and never lets tokens be cached', async () => {
      const email = `new-${randomBytes(4).toString('hex')}@example.pk`;
      const response = await post('/auth/sign-up', { email, password: PASSWORD, name: 'Sana' });
      expect(response.statusCode).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({
        user: { email, name: 'Sana', mfaEnabled: false },
        accessToken: expect.stringMatching(/^hsa_/),
        refreshToken: expect.stringMatching(/^hsr_/),
        session: { id: expect.stringMatching(/^ses_/), mfaVerified: false },
      });
    });

    it('explains invalid input field by field', async () => {
      const invalid = await post('/auth/sign-up', { email: 'nope', password: 'short', name: 'X' });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json()).toMatchObject({
        error: { code: 'INVALID_INPUT', fields: { email: expect.any(String) } },
      });
      const malformed = await post('/auth/sign-up', { email: 'a@b.pk', password: 12, name: 'X' });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({
        error: { code: 'INVALID_INPUT', fields: { password: expect.any(String) } },
      });
    });

    it('refuses a wrong password with 401', async () => {
      const { email } = await signUp();
      const response = await post('/auth/sign-in', { email, password: 'not my password' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password' },
      });
    });

    it('lists the shops a staff member works in', async () => {
      const { userId, accessToken } = await signUp();
      await grant(userId, shopA, 'confirmation_agent');
      const me = await get('/auth/me', accessToken);
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        shops: [
          {
            id: toPublicId('shop', shopA),
            name: 'Shop A',
            role: 'confirmation_agent',
            mfaRequired: false,
          },
        ],
      });
    });

    it('rotates tokens on refresh', async () => {
      const { refreshToken, accessToken } = await signUp();
      const response = await post('/auth/refresh', { refreshToken });
      expect(response.statusCode).toBe(200);
      const next = response.json() as Tokens;
      expect(next.refreshToken).not.toBe(refreshToken);
      expect((await get('/auth/me', accessToken)).statusCode).toBe(401);
      expect((await get('/auth/me', next.accessToken)).statusCode).toBe(200);
    });
  });

  describe('Admin API', () => {
    it('gives staff the scopes of their role in the shop they name', async () => {
      const { userId, accessToken } = await signUp();
      await grant(userId, shopA, 'packer');

      const read = await graphql(
        accessToken,
        shopA,
        '{ shop { name } products(first: 5) { nodes { id } } }',
      );
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ data: { shop: { name: 'Shop A' }, products: { nodes: [] } } });

      const write = await graphql(
        accessToken,
        shopA,
        'mutation { productCreate(input: { title: "Nope" }) { product { id } } }',
      );
      expect(write.json().errors[0].extensions.code).toBe('ACCESS_DENIED');

      const otherShop = await graphql(accessToken, shopB, '{ shop { name } }');
      expect(otherShop.statusCode).toBe(403);
      expect(otherShop.json().errors[0].extensions.code).toBe('NO_SHOP_ACCESS');

      const noShop = await graphql(accessToken, null, '{ shop { name } }');
      expect(noShop.statusCode).toBe(400);
      expect(noShop.json().errors[0].extensions.code).toBe('SHOP_REQUIRED');
    });

    it('requires two-step verification for owners, then lets them in', async () => {
      const { userId, email, accessToken } = await signUp();
      await grant(userId, shopB, 'owner');

      const blocked = await graphql(accessToken, shopB, '{ shop { name } }');
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().errors[0].extensions.code).toBe('MFA_REQUIRED');

      const secret = await enableTwoStep(accessToken);
      const created = await graphql(
        accessToken,
        shopB,
        'mutation { productCreate(input: { title: "Ajrak" }) { product { handle } } }',
      );
      expect(created.json()).toEqual({ data: { productCreate: { product: { handle: 'ajrak' } } } });

      // The next sign-in asks for a code. The code from set-up was used, so take the next one.
      const signIn = await post('/auth/sign-in', { email, password: PASSWORD });
      const challenge = signIn.json() as { status: string; challengeToken: string };
      expect(challenge.status).toBe('mfa_required');
      const verified = await post('/auth/sign-in/verify', {
        challengeToken: challenge.challengeToken,
        code: code(secret, 30_000),
      });
      expect(verified.statusCode).toBe(200);
      const tokens = verified.json() as Tokens & { session: { mfaVerified: boolean } };
      expect(tokens.session.mfaVerified).toBe(true);
      expect((await graphql(tokens.accessToken, shopB, '{ shop { name } }')).statusCode).toBe(200);
    });

    it('stops accepting a session as soon as it signs out', async () => {
      const { userId, accessToken } = await signUp();
      await grant(userId, shopA, 'marketer');
      expect((await graphql(accessToken, shopA, '{ shop { name } }')).statusCode).toBe(200);
      expect((await post('/auth/sign-out', {}, accessToken)).statusCode).toBe(204);
      const after = await graphql(accessToken, shopA, '{ shop { name } }');
      expect(after.statusCode).toBe(401);
      expect(after.json().errors[0].extensions.code).toBe('UNAUTHENTICATED');
    });

    it("masks customers' numbers for agents, who reveal one on a log owners read", async () => {
      // An app places the order and reads the log, as an owner would.
      const { token, hash, hint } = generateAccessToken();
      await admin.query(
        `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
         VALUES ($1, 'test', $2, $3, $4)`,
        [shopA, hash, hint, ['write_products', 'write_orders', 'read_settings']],
      );
      const app = async (query: string) => {
        const response = await api.app.inject({
          method: 'POST',
          url: ADMIN_GRAPHQL_PATH,
          headers: { 'x-hatti-access-token': token },
          payload: { query },
        });
        const body = response.json();
        expect(body.errors).toBeUndefined();
        return body.data;
      };
      const product = await app(
        'mutation { productCreate(input: { title: "Kurta", status: ACTIVE, ' +
          'variants: [{ price: "2,000" }] }) { product { variants { id } } } }',
      );
      const placed = await app(
        `mutation { orderCreate(input: {
           lineItems: [{ variantId: "${product.productCreate.product.variants[0].id}", quantity: 1 }]
           shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                              address1: "House 12, Street 4", city: "Karachi" } }) {
           order { id } } }`,
      );
      const orderId = placed.orderCreate.order.id as string;

      const agent = await signUp();
      await grant(agent.userId, shopA, 'confirmation_agent');
      const seen = await graphql(
        agent.accessToken,
        shopA,
        `{ order(id: "${orderId}") { phone shippingAddress { phone } } }`,
      );
      expect(seen.json().data.order).toEqual({
        phone: '0300 ••••567',
        shippingAddress: { phone: '0300 ••••567' },
      });
      const revealed = await graphql(
        agent.accessToken,
        shopA,
        `mutation { orderPhoneReveal(id: "${orderId}") { phone userErrors { code } } }`,
      );
      expect(revealed.json().data.orderPhoneReveal).toEqual({
        phone: '+923001234567',
        userErrors: [],
      });

      // Packers see numbers masked, and cannot reveal them.
      const packer = await signUp();
      await grant(packer.userId, shopA, 'packer');
      const denied = await graphql(
        packer.accessToken,
        shopA,
        `mutation { orderPhoneReveal(id: "${orderId}") { phone } }`,
      );
      expect(denied.json().errors[0].extensions.code).toBe('ACCESS_DENIED');

      const log = await app(
        '{ auditLog(first: 5) { nodes { action subjectId actor { kind id role } } } }',
      );
      expect(log.auditLog.nodes).toEqual([
        {
          action: 'order.phone_revealed',
          subjectId: orderId,
          actor: {
            kind: 'STAFF',
            id: toPublicId('user', agent.userId),
            role: 'confirmation_agent',
          },
        },
      ]);
    });
  });
});
