import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { ROLE_SCOPES, generateAccessToken, type StaffRole } from '@hatti/api';
import { base32Decode, totp } from '@hatti/crypto';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import { AccountEmailSender, type AccountEmail } from '@hatti/identity/public';
import { SoftAuthenticator } from '@hatti/identity/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_PASSKEYS, startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();
const PASSWORD = 'correct horse battery staple';

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/** Keeps each email it is given to send. */
class EmailsSent extends AccountEmailSender {
  readonly sent: AccountEmail[] = [];

  async send(email: AccountEmail): Promise<boolean> {
    this.sent.push(email);
    return true;
  }
}

describe.skipIf(!server)('staff sign-in and Admin API access', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  const shopA = newId();
  const shopB = newId();
  const outbox = new EmailsSent();

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
        'idempotency-key': randomUUID(),
        ...(shopId ? { 'x-hatti-shop-id': toPublicId('shop', shopId) } : {}),
      },
      payload: { query },
    });

  const code = (secret: string, offsetMs = 0) => totp(base32Decode(secret), Date.now() + offsetMs);

  /** An app of shop A with the scopes, as a function that runs a query and returns its data. */
  async function appOfShopA(scopes: string[]): Promise<(query: string) => Promise<Json>> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopA, hash, hint, scopes],
    );
    return async (query: string) => {
      const response = await api.app.inject({
        method: 'POST',
        url: ADMIN_GRAPHQL_PATH,
        headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
        payload: { query },
      });
      const body = response.json() as { data?: Json; errors?: unknown };
      expect(body.errors).toBeUndefined();
      return body.data;
    };
  }

  /** Shop A's order, placed by `app`, for a kurta at Rs 2,000. */
  async function orderOfShopA(
    app: (query: string) => Promise<Json>,
    paymentMethod: 'CASH_ON_DELIVERY' | 'PREPAID',
  ): Promise<string> {
    const product = await app(
      'mutation { productCreate(input: { title: "Kurta", status: ACTIVE, ' +
        'variants: [{ price: "2,000" }] }) { product { variants { id } } } }',
    );
    const placed = await app(
      `mutation { orderCreate(input: {
         lineItems: [{ variantId: "${product.productCreate.product.variants[0].id}", quantity: 1 }]
         paymentMethod: ${paymentMethod}
         shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                            address1: "House 12, Street 4", city: "Karachi" } }) {
         order { id } } }`,
    );
    return placed.orderCreate.order.id as string;
  }

  async function enableTwoStep(accessToken: string): Promise<string> {
    const setup = await post('/auth/two-step/totp/setup', {}, accessToken);
    expect(setup.statusCode).toBe(200);
    const { secret } = setup.json() as { secret: string };
    const confirm = await post('/auth/two-step/totp/confirm', { code: code(secret) }, accessToken);
    expect(confirm.statusCode).toBe(200);
    expect((confirm.json() as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);
    return secret;
  }

  /** The versions of Hatti's terms a shop's owner agrees to. */
  let agreed: Record<string, string> = {};

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    api = await startTestApi(testDb, {
      emails: { sender: outbox, adminUrl: 'https://admin.hatti.pk' },
    });
    // Opening a shop agrees to Hatti's terms as they are (ADR-737).
    const asked = await api.app.inject({ method: 'GET', url: '/auth/agreement' });
    const { documents } = asked.json() as { documents: { handle: string; version: string }[] };
    agreed = Object.fromEntries(documents.map((document) => [document.handle, document.version]));
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
            // What they may do there, for the admin to show them (ADR-580).
            scopes: ROLE_SCOPES.confirmation_agent,
            capabilities: ['reveal_customer_numbers'],
            customRole: null,
          },
        ],
      });
    });

    it("opens a shop of the user's own, which its Admin API serves once they have a second factor (ADR-145)", async () => {
      const { accessToken } = await signUp();
      // What the owner agrees to, with where to read each (ADR-737).
      const asked = await get('/auth/agreement', accessToken);
      expect(asked.headers['cache-control']).toBe('public, max-age=300');
      const { documents } = asked.json() as {
        documents: { handle: string; version: string; url: string }[];
      };
      expect(documents.map((document) => [document.handle, document.url])).toEqual([
        ['terms', 'http://localhost:4000/legal/terms'],
        ['acceptable-use', 'http://localhost:4000/legal/acceptable-use'],
        ['data-processing', 'http://localhost:4000/legal/data-processing'],
      ]);
      const unagreed = await post('/auth/shops', { name: 'Sana Lawn' }, accessToken);
      expect([unagreed.statusCode, unagreed.json()]).toEqual([
        422,
        {
          error: {
            code: 'INVALID_INPUT',
            message: 'Some details need fixing',
            fields: {
              agreed:
                "Agree to Hatti's terms of service, acceptable use policy and data processing agreement",
            },
          },
        },
      ]);
      const stale = await post(
        '/auth/shops',
        { name: 'Sana Lawn', agreed: { ...agreed, terms: '2020-01-01' } },
        accessToken,
      );
      expect([stale.statusCode, (stale.json() as { error: { code: string } }).error.code]).toEqual([
        409,
        'TERMS_CHANGED',
      ]);
      expect(agreed).toEqual(
        Object.fromEntries(documents.map((document) => [document.handle, document.version])),
      );
      const opened = await post('/auth/shops', { name: 'Sana Lawn', agreed }, accessToken);
      expect([opened.statusCode, opened.headers['cache-control']]).toEqual([201, 'no-store']);
      const { shop } = opened.json() as { shop: { id: string } };
      const shopId = fromPublicId(shop.id, 'shop');
      expect(shop).toEqual({
        id: toPublicId('shop', shopId),
        name: 'Sana Lawn',
        handle: 'sana-lawn',
        role: 'owner',
        mfaRequired: true,
      });
      const query = '{ shop { name handle currencyCode } }';
      expect((await graphql(accessToken, shopId, query)).statusCode).toBe(403);
      await enableTwoStep(accessToken);
      expect((await graphql(accessToken, shopId, query)).json()).toEqual({
        data: { shop: { name: 'Sana Lawn', handle: 'sana-lawn', currencyCode: 'PKR' } },
      });
      // A handle is one shop's.
      const again = await post(
        '/auth/shops',
        { name: 'Copy', handle: 'sana-lawn', agreed },
        accessToken,
      );
      expect([again.statusCode, again.json()]).toEqual([
        409,
        {
          error: {
            code: 'HANDLE_TAKEN',
            message: 'Another shop has this handle',
            fields: { handle: 'Taken by another shop' },
          },
        },
      ]);
      expect((await post('/auth/shops', { name: 'Anyone' })).statusCode).toBe(401);
      expect((await post('/auth/shops', { handle: 7 }, accessToken)).statusCode).toBe(400);
      // Its owner agreed in opening it; one agrees again for it as the terms change (ADR-739).
      const shops = (await get('/auth/me', accessToken)).json().shops as Json[];
      expect(shops.find((each) => each.id === shop.id)).toMatchObject({ agreementDue: false });
      const path = `/auth/shops/${shop.id}/agreement`;
      const agreedAgain = await post(path, { agreed }, accessToken);
      expect([
        agreedAgain.statusCode,
        agreedAgain.headers['cache-control'],
        agreedAgain.json(),
      ]).toEqual([200, 'no-store', { agreementDue: false }]);
      expect((await post(path, {}, accessToken)).statusCode).toBe(422);
      const stranger = await signUp();
      expect((await post(path, { agreed }, stranger.accessToken)).statusCode).toBe(404);
      expect((await post(path, { agreed })).statusCode).toBe(401);
      const { rows: agreements } = await admin.query(
        'SELECT count(*)::int AS count FROM identity.shop_agreements WHERE shop_id = $1',
        [shopId],
      );
      expect(agreements).toEqual([{ count: 2 }]);
    });

    it('closes a shop for its owner, its Admin API refused, and reopens it while its data is kept (ADR-740)', async () => {
      const { accessToken } = await signUp();
      const opened = await post('/auth/shops', { name: 'Gul Bano', agreed }, accessToken);
      const { shop } = opened.json() as { shop: { id: string } };
      const shopId = fromPublicId(shop.id, 'shop');
      await enableTwoStep(accessToken);
      const query = '{ shop { name } }';
      expect((await graphql(accessToken, shopId, query)).json()).toEqual({
        data: { shop: { name: 'Gul Bano' } },
      });

      const misnamed = await post(`/auth/shops/${shop.id}/close`, { name: 'Gul' }, accessToken);
      expect([misnamed.statusCode, misnamed.json().error.code]).toEqual([422, 'INVALID_INPUT']);
      const closed = await post(`/auth/shops/${shop.id}/close`, { name: 'Gul Bano' }, accessToken);
      expect([closed.statusCode, closed.headers['cache-control']]).toEqual([200, 'no-store']);
      expect(closed.json().shop).toMatchObject({ id: shop.id, name: 'Gul Bano' });
      expect((await graphql(accessToken, shopId, query)).statusCode).toBe(403);
      const me = (await get('/auth/me', accessToken)).json();
      expect(me.shops).toEqual([]);
      expect(me.closedShops).toEqual([closed.json().shop]);
      const again = await post(`/auth/shops/${shop.id}/close`, { name: 'Gul Bano' }, accessToken);
      expect([again.statusCode, again.json().error.code]).toEqual([409, 'SHOP_NOT_OPEN']);
      const stranger = await signUp();
      expect(
        (await post(`/auth/shops/${shop.id}/reopen`, {}, stranger.accessToken)).statusCode,
      ).toBe(404);

      const reopened = await post(`/auth/shops/${shop.id}/reopen`, {}, accessToken);
      expect([reopened.statusCode, reopened.json()]).toEqual([
        200,
        { shop: { id: shop.id, name: 'Gul Bano', role: 'owner', mfaRequired: true } },
      ]);
      expect((await graphql(accessToken, shopId, query)).json()).toEqual({
        data: { shop: { name: 'Gul Bano' } },
      });
      expect((await post(`/auth/shops/${shop.id}/reopen`, {}, accessToken)).statusCode).toBe(409);
      expect((await post(`/auth/shops/${shop.id}/close`, { name: 'Gul Bano' })).statusCode).toBe(
        401,
      );
    });

    it('lets a partner open development stores and see them on its dashboard (PRT-01, ADR-504)', async () => {
      const { accessToken } = await signUp();
      expect((await get('/auth/partner', accessToken)).json()).toEqual({
        partner: null,
        stores: [],
        earnings: null,
      });
      expect((await post('/auth/partner/stores', { name: 'Zari' }, accessToken)).json()).toEqual({
        error: { code: 'NOT_PARTNER', message: "Join Hatti's partner programme first" },
      });
      const joined = await post(
        '/auth/partner',
        { businessName: 'Pixel Media', website: 'https://pixel.pk' },
        accessToken,
      );
      expect([joined.statusCode, joined.headers['cache-control']]).toEqual([200, 'no-store']);
      expect(joined.json()).toMatchObject({
        partner: { businessName: 'Pixel Media', website: 'https://pixel.pk' },
      });
      const opened = await post(
        '/auth/partner/stores',
        { name: 'Noor Jewels', agreed },
        accessToken,
      );
      expect(opened.statusCode).toBe(201);
      const { shop } = opened.json() as { shop: { id: string } };
      expect(shop).toMatchObject({ name: 'Noor Jewels', handle: 'noor-jewels', role: 'owner' });
      const dashboard = (await get('/auth/partner', accessToken)).json() as {
        stores: Record<string, unknown>[];
      };
      expect(dashboard.stores).toEqual([
        {
          id: shop.id,
          name: 'Noor Jewels',
          handle: 'noor-jewels',
          status: 'active',
          kind: 'development',
          role: 'owner',
          accessEndsAt: null,
          since: expect.any(String),
          transferredAt: null,
        },
      ]);
      expect((await post('/auth/partner', { businessName: 7 }, accessToken)).statusCode).toBe(400);

      // A merchant comes by the partner's link (ADR-505): the store is theirs, as referred.
      const { partner } = joined.json() as { partner: { referralCode: string } };
      const merchant = await signUp();
      const referred = await post(
        '/auth/shops',
        { name: 'Sana Prints', referralCode: partner.referralCode, agreed },
        merchant.accessToken,
      );
      expect(referred.statusCode).toBe(201);
      const after = (await get('/auth/partner', accessToken)).json() as {
        stores: { name: string; kind: string }[];
        earnings: Record<string, unknown>;
      };
      expect(after.stores.map((store) => [store.name, store.kind])).toEqual([
        ['Sana Prints', 'referred'],
        ['Noor Jewels', 'development'],
      ]);
      expect(after.earnings).toEqual({ earned: '0', paidOut: '0', owed: '0', entries: [] });
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

    it('adds a passkey, which signs a manager in alone or after the password (ADR-100)', async () => {
      const { userId, email, accessToken } = await signUp();
      await grant(userId, shopB, 'manager');
      const phone = new SoftAuthenticator(TEST_PASSKEYS.origins[0]!);
      const options = await post('/auth/passkeys/options', {}, accessToken);
      expect(options.statusCode).toBe(200);
      expect(options.headers['cache-control']).toBe('no-store');
      const added = await post(
        '/auth/passkeys',
        { response: phone.create(options.json().options), name: 'Phone' },
        accessToken,
      );
      expect(added.statusCode).toBe(201);
      const body = added.json() as Json;
      expect(body).toEqual({
        passkey: {
          id: expect.stringMatching(/^psk_/),
          name: 'Phone',
          multiDevice: false,
          backedUp: false,
          createdAt: expect.any(String),
          lastUsedAt: null,
        },
        recoveryCodes: expect.any(Array),
      });
      expect((await get('/auth/passkeys', accessToken)).json()).toEqual({
        passkeys: [body.passkey],
      });

      // Alone, it passes the second factor a manager needs.
      const begun = await post('/auth/sign-in/passkey/options', {});
      expect(begun.json().options).toMatchObject({
        rpId: 'localhost',
        userVerification: 'required',
      });
      const signedIn = await post('/auth/sign-in/passkey', {
        response: phone.get(begun.json().options),
      });
      expect(signedIn.statusCode).toBe(200);
      const tokens = signedIn.json() as Tokens & { status: string; session: Json };
      expect([tokens.status, tokens.session.mfaVerified]).toEqual(['signed_in', true]);
      expect((await graphql(tokens.accessToken, shopB, '{ shop { name } }')).statusCode).toBe(200);

      // After the password, it answers the second step.
      const challenge = (await post('/auth/sign-in', { email, password: PASSWORD })).json() as Json;
      expect(challenge).toMatchObject({
        status: 'mfa_required',
        methods: ['passkey', 'recovery_code'],
        passkeyOptions: { allowCredentials: [{ id: phone.passkeyIds[0] }] },
      });
      const verified = await post('/auth/sign-in/verify', {
        challengeToken: challenge.challengeToken,
        passkey: phone.get(challenge.passkeyOptions),
      });
      expect(verified.statusCode).toBe(200);
      expect(verified.json().session.mfaVerified).toBe(true);

      // Malformed, refused, or removed: never signed in.
      const malformed = await post('/auth/sign-in/passkey', { response: { id: 'x' } });
      expect([malformed.statusCode, malformed.json().error.code]).toEqual([400, 'INVALID_INPUT']);
      const both = await post('/auth/sign-in/verify', {
        challengeToken: challenge.challengeToken,
        code: '123456',
        passkey: phone.get(challenge.passkeyOptions),
      });
      expect(both.json().error.fields).toEqual({ code: 'Give a code or a passkey: one of them' });
      const elsewhere = phone.get(
        (await post('/auth/sign-in/passkey/options', {})).json().options,
        'https://hatti.example',
      );
      const refused = await post('/auth/sign-in/passkey', { response: elsewhere });
      expect([refused.statusCode, refused.json().error.code]).toEqual([401, 'INVALID_PASSKEY']);
      const remove = (token: string) =>
        api.app.inject({
          method: 'DELETE',
          url: `/auth/passkeys/${body.passkey.id}`,
          headers: { authorization: `Bearer ${token}` },
        });
      expect((await remove(accessToken)).statusCode).toBe(403);
      expect((await remove(tokens.accessToken)).statusCode).toBe(204);
      const gone = await post('/auth/sign-in/passkey', {
        response: phone.get((await post('/auth/sign-in/passkey/options', {})).json().options),
      });
      expect(gone.statusCode).toBe(401);
    });

    it('lets the owner invite staff by a link, change their roles and remove them (ADR-101)', async () => {
      const shopC = newId();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Shop C')`, [shopC]);
      // On Growth, which has room for its staff (ADR-154).
      await admin.query(
        `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
         VALUES ($1, 'growth', 'monthly', now(), now() + interval '1 month')`,
        [shopC],
      );
      const owner = await signUp();
      await grant(owner.userId, shopC, 'owner');
      await enableTwoStep(owner.accessToken);
      const as = (token: string, query: string) =>
        graphql(token, shopC, query).then((response) => response.json() as Json);
      const created = await as(
        owner.accessToken,
        `mutation { staffInvitationCreate(role: PACKER, note: "Bilal, for packing",
           email: "Bilal@Example.PK", language: UR) {
           invitation { id role note email invitedBy expiresAt } token emailed
           userErrors { field code } } }`,
      );
      const { invitation, token, emailed } = created.data.staffInvitationCreate;
      expect(invitation).toEqual({
        id: expect.stringMatching(/^sti_/),
        role: 'PACKER',
        note: 'Bilal, for packing',
        email: 'bilal@example.pk',
        invitedBy: 'Sana Iqbal',
        expiresAt: expect.any(String),
      });
      expect(token).toMatch(/^hsi_/);
      // Hatti emails the link there too, in Urdu as asked (ADR-167).
      expect(emailed).toBe(true);
      expect(outbox.sent.at(-1)).toMatchObject({
        to: 'bilal@example.pk',
        text: expect.stringContaining(`https://admin.hatti.pk/invitation#token=${token}`),
        html: expect.stringContaining('dir="rtl"'),
      });

      // Its link says what it is before anyone signs in; signed in, it is accepted once.
      const preview = await post('/auth/invitations/preview', { token });
      expect(preview.json()).toEqual({
        invitation: {
          shop: { name: 'Shop C' },
          role: 'packer',
          invitedBy: 'Sana Iqbal',
          expiresAt: invitation.expiresAt,
          accessDays: null,
        },
      });
      const bilal = await signUp();
      expect((await post('/auth/invitations/accept', { token })).statusCode).toBe(401);
      const accepted = await post('/auth/invitations/accept', { token }, bilal.accessToken);
      expect(accepted.json()).toEqual({
        shop: { id: toPublicId('shop', shopC), name: 'Shop C', role: 'packer', mfaRequired: false },
      });
      const spent = await post('/auth/invitations/accept', { token }, (await signUp()).accessToken);
      expect([spent.statusCode, spent.json().error.code]).toEqual([404, 'INVALID_INVITATION']);
      expect((await graphql(bilal.accessToken, shopC, '{ shop { name } }')).statusCode).toBe(200);

      // The owner and managers see and manage staff; a packer, and apps, don't.
      const STAFF = '{ staffMembers { id name role } staffInvitations { id } }';
      expect((await as(bilal.accessToken, STAFF)).errors[0].extensions.code).toBe('ACCESS_DENIED');
      const bilalId = toPublicId('user', bilal.userId);
      expect((await as(owner.accessToken, STAFF)).data).toEqual({
        staffMembers: [
          { id: toPublicId('user', owner.userId), name: 'Sana Iqbal', role: 'OWNER' },
          { id: bilalId, name: 'Sana Iqbal', role: 'PACKER' },
        ],
        staffInvitations: [],
      });
      const { token: appToken, hash, hint } = generateAccessToken();
      await admin.query(
        `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
         VALUES ($1, 'test', $2, $3, '{read_settings,write_settings}')`,
        [shopC, hash, hint],
      );
      const app = await api.app.inject({
        method: 'POST',
        url: ADMIN_GRAPHQL_PATH,
        headers: { 'x-hatti-access-token': appToken },
        payload: { query: STAFF },
      });
      expect(app.json().errors[0].message).toBe(
        'Access denied. Staff are managed by the owner and managers, not apps.',
      );
      const changed = await as(
        owner.accessToken,
        `mutation { staffMemberRoleUpdate(id: "${bilalId}", role: CONFIRMATION_AGENT) {
           staffMember { role } userErrors { field code } } }`,
      );
      expect(changed.data.staffMemberRoleUpdate).toEqual({
        staffMember: { role: 'CONFIRMATION_AGENT' },
        userErrors: [],
      });
      const crowned = await as(
        owner.accessToken,
        `mutation { staffMemberRoleUpdate(id: "${bilalId}", role: OWNER) {
           staffMember { role } userErrors { field code } } }`,
      );
      expect(crowned.data.staffMemberRoleUpdate.userErrors).toEqual([
        { field: ['role'], code: 'INVALID' },
      ]);
      const removed = await as(
        owner.accessToken,
        `mutation { staffMemberRemove(id: "${bilalId}") { removedStaffMemberId userErrors { code } } }`,
      );
      expect(removed.data.staffMemberRemove).toEqual({
        removedStaffMemberId: bilalId,
        userErrors: [],
      });
      const closed = await graphql(bilal.accessToken, shopC, '{ shop { name } }');
      expect(closed.json().errors[0].extensions.code).toBe('NO_SHOP_ACCESS');
      // Each change on the shop's audit log.
      const log = await as(
        owner.accessToken,
        '{ auditLog(first: 5) { nodes { action details } } }',
      );
      expect(log.data.auditLog.nodes).toEqual([
        { action: 'staff.removed', details: '{"role":"CONFIRMATION_AGENT"}' },
        { action: 'staff.role_changed', details: '{"to":"CONFIRMATION_AGENT","from":"PACKER"}' },
        { action: 'staff.invited', details: '{"role":"PACKER"}' },
      ]);

      // Asked in no language, an invitation goes in the inviter's own (ADR-194).
      const urdu = await post('/auth/language', { language: 'ur' }, owner.accessToken);
      expect(urdu.json().user.language).toBe('ur');
      const unasked = await as(
        owner.accessToken,
        `mutation { staffInvitationCreate(role: MARKETER, email: "imran@example.pk") {
           invitation { id } token emailed userErrors { field code } } }`,
      );
      expect(unasked.data.staffInvitationCreate).toMatchObject({ emailed: true, userErrors: [] });
      expect(outbox.sent.at(-1)).toMatchObject({
        to: 'imran@example.pk',
        html: expect.stringContaining('dir="rtl"'),
      });

      // Gone astray, it is emailed again by a new link, in English as asked (ADR-196).
      const first = unasked.data.staffInvitationCreate;
      const resent = await as(
        owner.accessToken,
        `mutation { staffInvitationResend(id: "${first.invitation.id}", language: EN) {
           invitation { id role email } token emailed userErrors { field code } } }`,
      );
      const renewed = resent.data.staffInvitationResend;
      expect(renewed).toEqual({
        invitation: {
          id: expect.stringMatching(/^sti_/),
          role: 'MARKETER',
          email: 'imran@example.pk',
        },
        token: expect.stringMatching(/^hsi_/),
        emailed: true,
        userErrors: [],
      });
      expect(renewed.invitation.id).not.toBe(first.invitation.id);
      expect(outbox.sent.at(-1)).toMatchObject({
        to: 'imran@example.pk',
        text: expect.stringContaining(`https://admin.hatti.pk/invitation#token=${renewed.token}`),
        html: expect.not.stringContaining('dir="rtl"'),
      });
      // The link before opens nothing, and the one taken back is not sent again.
      expect((await post('/auth/invitations/preview', { token: first.token })).statusCode).toBe(
        404,
      );
      const gone = await as(
        owner.accessToken,
        `mutation { staffInvitationResend(id: "${first.invitation.id}") {
           invitation { id } userErrors { field code } } }`,
      );
      expect(gone.data.staffInvitationResend).toEqual({
        invitation: null,
        userErrors: [{ field: ['id'], code: 'NOT_FOUND' }],
      });
      // On the audit log, naming the one it took the place of.
      const resentLog = await as(
        owner.accessToken,
        '{ auditLog(first: 1) { nodes { action subjectId details } } }',
      );
      expect(resentLog.data.auditLog.nodes).toEqual([
        {
          action: 'staff.invitation_resent',
          subjectId: renewed.invitation.id,
          details: JSON.stringify({ role: 'MARKETER', replaced: first.invitation.id }),
        },
      ]);
    });

    it('invites a collaborator for some days, whose access then ends by itself (ADR-487)', async () => {
      const shopD = newId();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Shop D')`, [shopD]);
      await admin.query(
        `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
         VALUES ($1, 'growth', 'monthly', now(), now() + interval '1 month')`,
        [shopD],
      );
      const owner = await signUp();
      await grant(owner.userId, shopD, 'owner');
      await enableTwoStep(owner.accessToken);
      const as = (token: string, query: string) =>
        graphql(token, shopD, query).then((response) => response.json() as Json);

      const tooLong = await as(
        owner.accessToken,
        `mutation { staffInvitationCreate(role: MARKETER, accessDays: 0) {
           invitation { id } userErrors { field code } } }`,
      );
      expect(tooLong.data.staffInvitationCreate).toEqual({
        invitation: null,
        userErrors: [{ field: ['accessDays'], code: 'INVALID' }],
      });
      const created = await as(
        owner.accessToken,
        `mutation { staffInvitationCreate(role: MARKETER, note: "Pixel agency", accessDays: 14) {
           invitation { accessDays } token userErrors { field code } } }`,
      );
      const { invitation, token } = created.data.staffInvitationCreate;
      expect(invitation).toEqual({ accessDays: 14 });
      const preview = await post('/auth/invitations/preview', { token });
      expect(preview.json().invitation.accessDays).toBe(14);

      const agency = await signUp();
      await post('/auth/invitations/accept', { token }, agency.accessToken);
      const staff = await as(owner.accessToken, '{ staffMembers { role expiresAt } }');
      const until = new Date(staff.data.staffMembers[1].expiresAt).getTime();
      expect(staff.data.staffMembers[0]).toEqual({ role: 'OWNER', expiresAt: null });
      expect(until - Date.now()).toBeGreaterThan(13.9 * 86_400_000);
      expect(until - Date.now()).toBeLessThanOrEqual(14 * 86_400_000);
      expect((await graphql(agency.accessToken, shopD, '{ shop { name } }')).statusCode).toBe(200);

      // When its days are up, the shop is closed to it, though no sweep has run yet.
      await admin.query(
        `UPDATE identity.memberships SET expires_at = now() - interval '1 minute'
         WHERE user_id = $1 AND shop_id = $2`,
        [agency.userId, shopD],
      );
      const ended = await graphql(agency.accessToken, shopD, '{ shop { name } }');
      expect(ended.statusCode).toBe(403);
      expect(ended.json().errors[0].extensions.code).toBe('NO_SHOP_ACCESS');
      expect((await as(owner.accessToken, '{ staffMembers { role } }')).data).toEqual({
        staffMembers: [{ role: 'OWNER' }],
      });
    });

    it('lets an agency ask a shop for access by its handle, for the owner to approve (ADR-488)', async () => {
      const shopE = newId();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Shop E', 'shop-e-lawn')`,
        [shopE],
      );
      await admin.query(
        `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
         VALUES ($1, 'growth', 'monthly', now(), now() + interval '1 month')`,
        [shopE],
      );
      const owner = await signUp();
      await grant(owner.userId, shopE, 'owner');
      await enableTwoStep(owner.accessToken);
      const as = (token: string, query: string) =>
        graphql(token, shopE, query).then((response) => response.json() as Json);

      const agency = await signUp();
      const ask = { shop: 'shop-e-lawn', role: 'marketer', accessDays: 30, message: 'Pixel Media' };
      expect((await post('/auth/access-requests', ask)).statusCode).toBe(401);
      const asked = await post('/auth/access-requests', ask, agency.accessToken);
      expect(asked.statusCode).toBe(201);
      expect(asked.json().request).toMatchObject({
        id: expect.stringMatching(/^acr_/),
        shop: { name: 'Shop E' },
        role: 'marketer',
        accessDays: 30,
        status: 'pending',
      });
      const again = await post('/auth/access-requests', ask, agency.accessToken);
      expect([again.statusCode, again.json().error.code]).toEqual([409, 'REQUEST_WAITING']);
      expect((await graphql(agency.accessToken, shopE, '{ shop { name } }')).statusCode).toBe(403);

      const waiting = await as(
        owner.accessToken,
        '{ staffAccessRequests { id name role accessDays message } }',
      );
      expect(waiting.data.staffAccessRequests).toEqual([
        {
          id: asked.json().request.id,
          name: 'Sana Iqbal',
          role: 'MARKETER',
          accessDays: 30,
          message: 'Pixel Media',
        },
      ]);
      const approved = await as(
        owner.accessToken,
        `mutation { staffAccessRequestApprove(id: "${asked.json().request.id}", accessDays: 7) {
           staffMember { role expiresAt } userErrors { field code } } }`,
      );
      expect(approved.data.staffAccessRequestApprove.userErrors).toEqual([]);
      expect(approved.data.staffAccessRequestApprove.staffMember.role).toBe('MARKETER');
      const until = new Date(approved.data.staffAccessRequestApprove.staffMember.expiresAt);
      expect(until.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
      expect((await graphql(agency.accessToken, shopE, '{ shop { name } }')).statusCode).toBe(200);
      const mine = await get('/auth/access-requests', agency.accessToken);
      expect(mine.json().requests.map((each: Json) => [each.status, each.accessDays])).toEqual([
        ['approved', 7],
      ]);
      const log = await as(
        owner.accessToken,
        '{ auditLog(first: 1) { nodes { action details } } }',
      );
      expect(log.data.auditLog.nodes).toEqual([
        {
          action: 'staff.access_approved',
          details: JSON.stringify({ role: 'MARKETER', accessDays: 7 }),
        },
      ]);
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
      const app = await appOfShopA(['write_products', 'write_orders', 'read_settings']);
      const orderId = await orderOfShopA(app, 'CASH_ON_DELIVERY');

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

    it("lists what the shop's staff and apps changed, by whom, on its activity log (ADR-256)", async () => {
      const manager = await signUp();
      await grant(manager.userId, shopA, 'manager');
      await enableTwoStep(manager.accessToken);
      const created = await graphql(
        manager.accessToken,
        shopA,
        'mutation { productCreate(input: { title: "Rilli" }) { product { id } } }',
      );
      const productId = created.json().data.productCreate.product.id as string;
      const app = await appOfShopA(['write_products', 'read_settings']);
      await app(
        `mutation { productUpdate(input: { id: "${productId}", title: "Rilli quilt" }) {
           product { title } } }`,
      );
      const ACTIVITY = (args: string) =>
        `{ activityLog(${args}) { nodes { id type subjectType subjectId actor { kind id role }
             occurredAt } pageInfo { hasNextPage endCursor } } }`;
      const { activityLog } = await app(ACTIVITY(`subjectId: "${productId}"`));
      expect(activityLog.nodes).toEqual([
        {
          id: expect.stringMatching(/^evt_/),
          type: 'product.updated',
          subjectType: 'product',
          subjectId: productId,
          actor: { kind: 'APP', id: expect.stringMatching(/^tok_/), role: null },
          occurredAt: expect.any(String),
        },
        {
          id: expect.stringMatching(/^evt_/),
          type: 'product.created',
          subjectType: 'product',
          subjectId: productId,
          actor: { kind: 'STAFF', id: toPublicId('user', manager.userId), role: 'manager' },
          occurredAt: expect.any(String),
        },
      ]);
      // A page at a time, the latest first; and by type.
      const first = (await app(ACTIVITY(`subjectId: "${productId}", first: 1`))).activityLog;
      expect([first.nodes.map((node: Json) => node.type), first.pageInfo.hasNextPage]).toEqual([
        ['product.updated'],
        true,
      ]);
      const next = (
        await app(ACTIVITY(`subjectId: "${productId}", after: "${first.pageInfo.endCursor}"`))
      ).activityLog;
      expect(next.nodes.map((node: Json) => node.type)).toEqual(['product.created']);
      expect(
        (await app(ACTIVITY('type: "product.created", first: 250'))).activityLog.nodes.some(
          (node: Json) => node.subjectId === productId,
        ),
      ).toBe(true);
      // Staff without read_settings see none of it; nor does another shop.
      const packer = await signUp();
      await grant(packer.userId, shopA, 'packer');
      const denied = await graphql(packer.accessToken, shopA, ACTIVITY('first: 1'));
      expect(denied.json().errors[0].extensions.code).toBe('ACCESS_DENIED');
      const other = await signUp();
      await grant(other.userId, shopB, 'manager');
      await enableTwoStep(other.accessToken);
      const elsewhere = await graphql(
        other.accessToken,
        shopB,
        ACTIVITY(`subjectId: "${productId}"`),
      );
      expect(elsewhere.json().data.activityLog.nodes).toEqual([]);
    });

    it('lets owners and managers refund, and no other staff', async () => {
      const app = await appOfShopA(['write_products', 'write_orders']);
      const orderId = await orderOfShopA(app, 'PREPAID');
      const refund = (token: string) =>
        graphql(
          token,
          shopA,
          `mutation { orderRefund(id: "${orderId}", input: { amount: "500", method: MOBILE_WALLET }) {
             refund { amount { formatted } } userErrors { code } } }`,
        );

      // Confirmation agents and packers change orders, but do not give money back.
      const agent = await signUp();
      await grant(agent.userId, shopA, 'confirmation_agent');
      expect((await refund(agent.accessToken)).json().errors[0]).toMatchObject({
        message: 'Access denied. Only owners and managers refund orders.',
        extensions: { code: 'ACCESS_DENIED' },
      });
      const manager = await signUp();
      await grant(manager.userId, shopA, 'manager');
      await enableTwoStep(manager.accessToken);
      expect((await refund(manager.accessToken)).json().data.orderRefund).toEqual({
        refund: { amount: { formatted: 'Rs 500' } },
        userErrors: [],
      });
    });

    it('lets owners and managers give orders to anyone, and other staff take their own (ADR-127)', async () => {
      const app = await appOfShopA(['write_products', 'write_orders']);
      const [first, second] = [
        await orderOfShopA(app, 'CASH_ON_DELIVERY'),
        await orderOfShopA(app, 'CASH_ON_DELIVERY'),
      ];
      const manager = await signUp();
      await grant(manager.userId, shopA, 'manager');
      await enableTwoStep(manager.accessToken);
      const agent = await signUp();
      await grant(agent.userId, shopA, 'confirmation_agent');
      const packer = await signUp();
      await grant(packer.userId, shopA, 'packer');
      const [agentId, packerId] = [
        toPublicId('user', agent.userId),
        toPublicId('user', packer.userId),
      ];
      const as = (token: string, query: string) =>
        graphql(token, shopA, query).then((response) => response.json() as Json);
      const assign = (token: string, orderId: string, staffMemberId: string | null) =>
        as(
          token,
          `mutation { orderAssign(id: "${orderId}"${staffMemberId ? `, staffMemberId: "${staffMemberId}"` : ''}) {
             order { id assignedAt assignee { id name } } userErrors { field code message } } }`,
        );

      // A manager gives an order to anyone in the shop, by their account.
      const given = await assign(manager.accessToken, first, agentId);
      expect(given.data.orderAssign).toEqual({
        order: {
          id: first,
          assignedAt: expect.any(String),
          assignee: { id: agentId, name: 'Sana Iqbal' },
        },
        userErrors: [],
      });
      expect(
        (await assign(manager.accessToken, second, toPublicId('user', newId()))).data.orderAssign,
      ).toEqual({
        order: null,
        userErrors: [
          { field: ['staffMemberId'], code: 'NOT_FOUND', message: 'Staff member not found' },
        ],
      });
      const mine = await as(
        agent.accessToken,
        '{ orders(first: 5, query: "assignee:me") { nodes { id assignee { name } } } }',
      );
      expect(mine.data.orders.nodes).toEqual([{ id: first, assignee: { name: 'Sana Iqbal' } }]);

      // Other staff take an order no one has for themselves, but give orders to no one else, and
      // leave someone else's alone.
      expect((await assign(packer.accessToken, second, agentId)).errors[0]).toMatchObject({
        message:
          'Access denied. Only owners and managers give orders to others; staff take them for themselves.',
        extensions: { code: 'ACCESS_DENIED' },
      });
      expect(
        (await assign(packer.accessToken, first, packerId)).data.orderAssign.userErrors,
      ).toEqual([
        {
          field: ['id'],
          code: 'INVALID',
          message: 'The order is assigned to someone else; an owner or manager reassigns it',
        },
      ]);
      expect(
        (await assign(packer.accessToken, second, packerId)).data.orderAssign.order.assignee,
      ).toEqual({
        id: packerId,
        name: 'Sana Iqbal',
      });

      // A member who leaves gives back their open orders, for others to take.
      const removed = await as(
        manager.accessToken,
        `mutation { staffMemberRemove(id: "${packerId}") { removedStaffMemberId userErrors { code } } }`,
      );
      expect(removed.data.staffMemberRemove.removedStaffMemberId).toBe(packerId);
      const released = await as(
        manager.accessToken,
        `{ order(id: "${second}") { assignedAt assignee { id } events(first: 1) { nodes { message } } } }`,
      );
      expect(released.data.order).toEqual({
        assignedAt: null,
        assignee: null,
        events: {
          nodes: [{ message: 'No longer assigned to anyone: its assignee left the shop' }],
        },
      });
      // Apps give orders to anyone, as managers do.
      const taken = await app(
        `mutation { orderAssign(id: "${first}", staffMemberId: "${toPublicId('user', manager.userId)}") {
           order { assignee { id } } } }`,
      );
      expect(taken.orderAssign.order.assignee).toEqual({ id: toPublicId('user', manager.userId) });

      // Whoever reads orders has the staff by name, to name in a comment (ADR-637).
      const names = (await as(agent.accessToken, '{ staffNames { id name } }')).data.staffNames;
      expect(names).toEqual(
        expect.arrayContaining([
          { id: agentId, name: 'Sana Iqbal' },
          { id: toPublicId('user', manager.userId), name: expect.any(String) },
        ]),
      );
      expect(names.map((each: { id: string }) => each.id)).not.toContain(packerId);

      // Many at once, as orderAssign does each (ADR-634).
      const third = await orderOfShopA(app, 'CASH_ON_DELIVERY');
      const bulk = (token: string, ids: string[], staffMemberId: string | null) =>
        as(
          token,
          `mutation { orderBulkAssign(ids: ${JSON.stringify(ids)}${staffMemberId ? `, staffMemberId: "${staffMemberId}"` : ''}) {
             orders { id assignee { id } } userErrors { field code } } }`,
        );
      expect((await bulk(manager.accessToken, [second, third], agentId)).data).toEqual({
        orderBulkAssign: {
          orders: [
            { id: second, assignee: { id: agentId } },
            { id: third, assignee: { id: agentId } },
          ],
          userErrors: [],
        },
      });
      expect((await bulk(manager.accessToken, [second], toPublicId('user', newId()))).data).toEqual(
        {
          orderBulkAssign: {
            orders: [],
            userErrors: [{ field: ['staffMemberId'], code: 'NOT_FOUND' }],
          },
        },
      );
      expect(
        (await bulk(agent.accessToken, [third], toPublicId('user', manager.userId))).errors[0],
      ).toMatchObject({ extensions: { code: 'ACCESS_DENIED' } });
      expect((await bulk(manager.accessToken, [second, third], null)).data).toEqual({
        orderBulkAssign: {
          orders: [
            { id: second, assignee: null },
            { id: third, assignee: null },
          ],
          userErrors: [],
        },
      });
    });

    it('shares new orders among the agents on duty at the desk, where the shop says so (ADR-654)', async () => {
      const app = await appOfShopA(['write_products', 'write_orders']);
      const manager = await signUp();
      await grant(manager.userId, shopA, 'manager');
      await enableTwoStep(manager.accessToken);
      const agent = await signUp();
      await grant(agent.userId, shopA, 'confirmation_agent');
      const agentId = toPublicId('user', agent.userId);
      const as = (token: string, query: string) =>
        graphql(token, shopA, query).then((response) => response.json() as Json);

      // An agent goes on duty for some hours, and is listed as such, by name.
      const started = await as(
        agent.accessToken,
        `mutation { confirmationDeskDutyStart(hours: 4) {
           duty { staffMemberId name endsAt waiting isYou } userErrors { field code } } }`,
      );
      expect(started.data.confirmationDeskDutyStart).toEqual({
        duty: {
          staffMemberId: agentId,
          name: 'Sana Iqbal',
          endsAt: expect.any(String),
          waiting: 0,
          isYou: true,
        },
        userErrors: [],
      });
      expect(
        (
          await as(
            agent.accessToken,
            `mutation { confirmationDeskDutyStart(hours: 13) { userErrors { field code } } }`,
          )
        ).data.confirmationDeskDutyStart.userErrors,
      ).toEqual([{ field: ['hours'], code: 'INVALID' }]);

      // Until the shop shares new orders out, they stay with no one; then they go to the agent.
      const before = await orderOfShopA(app, 'CASH_ON_DELIVERY');
      const shared = await as(
        manager.accessToken,
        'mutation { orderSettingsUpdate(input: { shareNewOrders: true }) { orderSettings { shareNewOrders } } }',
      );
      expect(shared.data.orderSettingsUpdate.orderSettings).toEqual({ shareNewOrders: true });
      const after = await orderOfShopA(app, 'CASH_ON_DELIVERY');
      const assignees = await as(
        manager.accessToken,
        `{ before: order(id: "${before}") { assignee { id } }
           after: order(id: "${after}") { assignee { id name } events(first: 5) { nodes { message } } }
           confirmationDeskDuty { name waiting isYou } }`,
      );
      expect(assignees.data.before.assignee).toBeNull();
      expect(assignees.data.after.assignee).toEqual({ id: agentId, name: 'Sana Iqbal' });
      expect(assignees.data.after.events.nodes).toContainEqual({
        message: 'Assigned to Sana Iqbal, on duty at the Confirmation Desk',
      });
      expect(assignees.data.confirmationDeskDuty).toEqual([
        { name: 'Sana Iqbal', waiting: 1, isYou: false },
      ]);

      // Off duty, the agent hands over what still waits to the manager, on duty too (ADR-656),
      // and is given no more.
      await as(
        manager.accessToken,
        'mutation { confirmationDeskDutyStart { userErrors { code } } }',
      );
      const ended = await as(
        agent.accessToken,
        'mutation { confirmationDeskDutyEnd(handOver: true) { handedOver userErrors { code } } }',
      );
      expect(ended.data.confirmationDeskDutyEnd).toEqual({ handedOver: 1, userErrors: [] });
      const handed = await as(
        manager.accessToken,
        `{ order(id: "${after}") { assignee { id } } confirmationDeskDuty { waiting isYou } }`,
      );
      expect(handed.data).toEqual({
        order: { assignee: { id: toPublicId('user', manager.userId) } },
        confirmationDeskDuty: [{ waiting: 1, isYou: true }],
      });
      await as(manager.accessToken, 'mutation { confirmationDeskDutyEnd { handedOver } }');
      expect((await as(agent.accessToken, '{ confirmationDeskDuty { name } }')).data).toEqual({
        confirmationDeskDuty: [],
      });
      await as(
        manager.accessToken,
        'mutation { orderSettingsUpdate(input: { shareNewOrders: false }) { userErrors { code } } }',
      );
    });

    it("lets staff and apps comment on an order's timeline, each changing their own (ADR-128)", async () => {
      const app = await appOfShopA(['write_products', 'write_orders']);
      const orderId = await orderOfShopA(app, 'CASH_ON_DELIVERY');
      const agent = await signUp();
      await grant(agent.userId, shopA, 'confirmation_agent');
      const packer = await signUp();
      await grant(packer.userId, shopA, 'packer');
      const manager = await signUp();
      await grant(manager.userId, shopA, 'manager');
      await enableTwoStep(manager.accessToken);
      const marketer = await signUp();
      await grant(marketer.userId, shopA, 'marketer');
      const as = (token: string, query: string) =>
        graphql(token, shopA, query).then((response) => response.json() as Json);
      const FIELDS = 'id kind message editedAt author { kind id name }';

      // An agent writes on the timeline, as themselves, and changes their words.
      const created = await as(
        agent.accessToken,
        `mutation { orderCommentCreate(orderId: "${orderId}", message: "Call after 5pm") {
           comment { ${FIELDS} } userErrors { field code } } }`,
      );
      const comment = created.data.orderCommentCreate.comment;
      expect(created.data.orderCommentCreate).toEqual({
        comment: {
          id: expect.stringMatching(/^ocm_/),
          kind: 'comment',
          message: 'Call after 5pm',
          editedAt: null,
          author: { kind: 'STAFF', id: toPublicId('user', agent.userId), name: 'Sana Iqbal' },
        },
        userErrors: [],
      });
      const edited = await as(
        agent.accessToken,
        `mutation { orderCommentUpdate(id: "${comment.id}", message: "Call after 6pm") {
           comment { message editedAt } userErrors { code } } }`,
      );
      expect(edited.data.orderCommentUpdate).toEqual({
        comment: { message: 'Call after 6pm', editedAt: expect.any(String) },
        userErrors: [],
      });
      await app(
        `mutation { orderCommentCreate(orderId: "${orderId}", message: "Synced to the warehouse") {
           userErrors { code } } }`,
      );
      // Among what happened to the order, each with who did it.
      const timeline = await app(
        `{ order(id: "${orderId}") { events(first: 5) { nodes { kind message author { kind name } } } } }`,
      );
      expect(timeline.order.events.nodes).toEqual([
        {
          kind: 'comment',
          message: 'Synced to the warehouse',
          author: { kind: 'APP', name: null },
        },
        {
          kind: 'comment',
          message: 'Call after 6pm',
          author: { kind: 'STAFF', name: 'Sana Iqbal' },
        },
        {
          kind: 'created',
          message: expect.stringMatching(/^Order #\d+ placed through the API/),
          author: { kind: 'APP', name: null },
        },
      ]);

      // No one else changes it; an owner or manager deletes it; staff who only read orders write
      // no comments.
      const byPacker = await as(
        packer.accessToken,
        `mutation { orderCommentUpdate(id: "${comment.id}", message: "Packed") { userErrors { code } }
           orderCommentDelete(id: "${comment.id}") { deletedCommentId userErrors { code } } }`,
      );
      expect(byPacker.data).toEqual({
        orderCommentUpdate: { userErrors: [{ code: 'INVALID' }] },
        orderCommentDelete: { deletedCommentId: null, userErrors: [{ code: 'INVALID' }] },
      });
      const deleted = await as(
        manager.accessToken,
        `mutation { orderCommentDelete(id: "${comment.id}") { deletedCommentId userErrors { code } } }`,
      );
      expect(deleted.data.orderCommentDelete).toEqual({
        deletedCommentId: comment.id,
        userErrors: [],
      });
      const reading = await as(
        marketer.accessToken,
        `mutation { orderCommentCreate(orderId: "${orderId}", message: "Hello") { userErrors { code } } }`,
      );
      expect(reading.errors[0].extensions.code).toBe('ACCESS_DENIED');
    });

    it('lets owners and managers see how each agent did, and no other staff', async () => {
      const app = await appOfShopA(['write_products', 'write_orders']);
      const orderId = await orderOfShopA(app, 'CASH_ON_DELIVERY');
      const agent = await signUp();
      await grant(agent.userId, shopA, 'confirmation_agent');
      const confirmed = await graphql(
        agent.accessToken,
        shopA,
        `mutation { orderConfirm(id: "${orderId}") { userErrors { code } } }`,
      );
      expect(confirmed.json().data.orderConfirm.userErrors).toEqual([]);
      const from = new Date(Date.now() - 3_600_000).toISOString();
      const before = new Date(Date.now() + 3_600_000).toISOString();
      const agents = (token: string) =>
        graphql(
          token,
          shopA,
          `{ confirmationAgents(from: "${from}", before: "${before}") { kind id confirmed } }`,
        );

      // Agents see their queue, not how each of them did.
      expect((await agents(agent.accessToken)).json().errors[0]).toMatchObject({
        message: "Access denied. Only owners and managers see agents' performance.",
        extensions: { code: 'ACCESS_DENIED' },
      });
      const manager = await signUp();
      await grant(manager.userId, shopA, 'manager');
      await enableTwoStep(manager.accessToken);
      expect((await agents(manager.accessToken)).json().data.confirmationAgents).toEqual([
        { kind: 'STAFF', id: toPublicId('user', agent.userId), confirmed: 1 },
      ]);
    });

    it('lets owners and managers see how many orders each packer packed, and packers their own', async () => {
      const app = await appOfShopA(['write_products', 'write_orders']);
      const [first, second] = [
        await orderOfShopA(app, 'PREPAID'),
        await orderOfShopA(app, 'PREPAID'),
      ];
      const [bilal, hina] = [await signUp(), await signUp()];
      await grant(bilal.userId, shopA, 'packer');
      await grant(hina.userId, shopA, 'packer');
      for (const [packer, orderId] of [
        [bilal, first],
        [hina, second],
      ] as const) {
        const packed = await graphql(
          packer.accessToken,
          shopA,
          `mutation { orderMarkPacked(id: "${orderId}") { userErrors { code } } }`,
        );
        expect(packed.json().data.orderMarkPacked.userErrors).toEqual([]);
      }
      const from = new Date(Date.now() - 3_600_000).toISOString();
      const before = new Date(Date.now() + 3_600_000).toISOString();
      const packers = (token: string) =>
        graphql(
          token,
          shopA,
          `{ packers(from: "${from}", before: "${before}") { kind id packed units activeHours packedPerHour } }`,
        );
      const row = (userId: string) => ({
        kind: 'STAFF',
        id: toPublicId('user', userId),
        packed: 1,
        units: 1,
        activeHours: 1,
        packedPerHour: 1,
      });

      // A packer sees their own count alone.
      expect((await packers(hina.accessToken)).json().data.packers).toEqual([row(hina.userId)]);
      const manager = await signUp();
      await grant(manager.userId, shopA, 'manager');
      await enableTwoStep(manager.accessToken);
      expect(
        (await packers(manager.accessToken))
          .json()
          .data.packers.map((each: { id: string }) => each.id),
      ).toEqual(expect.arrayContaining([row(bilal.userId).id, row(hina.userId).id]));
      // Other staff see nobody's.
      const agent = await signUp();
      await grant(agent.userId, shopA, 'confirmation_agent');
      expect((await packers(agent.accessToken)).json().errors[0]).toMatchObject({
        message: 'Access denied. Only owners, managers and packers see packing counts.',
        extensions: { code: 'ACCESS_DENIED' },
      });
    });

    it('lets owners, managers and accountants export orders, as they see them', async () => {
      const app = await appOfShopA(['write_products', 'write_orders']);
      await orderOfShopA(app, 'CASH_ON_DELIVERY');
      const exportAs = (token: string) =>
        graphql(token, shopA, 'mutation { ordersExport { csv rowCount userErrors { code } } }');

      // Marketers read orders, but exports of theirs would need an approval.
      const marketer = await signUp();
      await grant(marketer.userId, shopA, 'marketer');
      expect((await exportAs(marketer.accessToken)).json().errors[0]).toMatchObject({
        message: 'Access denied. Only owners, managers and accountants export orders.',
        extensions: { code: 'ACCESS_DENIED' },
      });
      const accountant = await signUp();
      await grant(accountant.userId, shopA, 'accountant');
      await enableTwoStep(accountant.accessToken);
      const exported = (await exportAs(accountant.accessToken)).json().data.ordersExport;
      expect(exported.userErrors).toEqual([]);
      expect(exported.rowCount).toBeGreaterThan(0);
      expect(exported.csv).toContain(',0300 ••••567,');
      expect(exported.csv).not.toContain('0300 1234567');
    });

    it('lets those who export orders schedule exports to their own proved email (ADR-183)', async () => {
      const CREATE = `mutation { orderExportScheduleCreate(input: { frequency: DAILY, query: "stage:delivered" }) {
        exportSchedule { id staffMemberId frequency hour layout format query nextPeriodFirstDay nextPeriodLastDay }
        userErrors { field message } } }`;
      const LIST = '{ orderExportSchedules { id staffMemberId } }';
      const accountant = await signUp();
      await grant(accountant.userId, shopA, 'accountant');
      await enableTwoStep(accountant.accessToken);
      // Not proved yet: refused, saying why.
      expect(
        (await graphql(accountant.accessToken, shopA, CREATE)).json().data
          .orderExportScheduleCreate,
      ).toEqual({
        exportSchedule: null,
        userErrors: [
          {
            field: ['input'],
            message: "Prove your account's email first: scheduled exports are emailed to it",
          },
        ],
      });
      await admin.query('UPDATE identity.users SET email_verified_at = now() WHERE id = $1', [
        accountant.userId,
      ]);
      const made = (await graphql(accountant.accessToken, shopA, CREATE)).json().data
        .orderExportScheduleCreate;
      expect(made).toEqual({
        exportSchedule: {
          id: expect.stringMatching(/^exs_/),
          staffMemberId: toPublicId('user', accountant.userId),
          frequency: 'DAILY',
          hour: 8,
          layout: 'ORDERS',
          format: 'XLSX',
          query: 'stage:delivered',
          nextPeriodFirstDay: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          nextPeriodLastDay: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        },
        userErrors: [],
      });
      const { id } = made.exportSchedule;
      expect(
        (await graphql(accountant.accessToken, shopA, LIST)).json().data.orderExportSchedules,
      ).toEqual([{ id, staffMemberId: toPublicId('user', accountant.userId) }]);

      // Marketers neither schedule exports nor see who does.
      const marketer = await signUp();
      await grant(marketer.userId, shopA, 'marketer');
      expect((await graphql(marketer.accessToken, shopA, LIST)).json().errors[0]).toMatchObject({
        extensions: { code: 'ACCESS_DENIED' },
      });
      // An app sees them, deletes them, and schedules none: there is no one to email.
      const app = await appOfShopA(['read_orders']);
      expect((await app(LIST)).orderExportSchedules).toEqual([
        { id, staffMemberId: toPublicId('user', accountant.userId) },
      ]);
      expect((await app(CREATE)).orderExportScheduleCreate.userErrors).toEqual([
        { field: ['input'], message: 'Only staff schedule exports: each goes to their email' },
      ]);
      expect(
        (
          await app(
            `mutation { orderExportScheduleDelete(id: "${id}") { deletedExportScheduleId userErrors { message } } }`,
          )
        ).orderExportScheduleDelete,
      ).toEqual({ deletedExportScheduleId: id, userErrors: [] });
      expect((await app(LIST)).orderExportSchedules).toEqual([]);
    });

    it("lets owners, managers and accountants reconcile couriers' remittances", async () => {
      const importAs = (token: string) =>
        graphql(
          token,
          shopA,
          `
            mutation {
              codRemittanceImport(courier: "TCS", csv: "CN,COD Amount\\nTCS1,500", dryRun: true) {
                outcomes {
                  unmatched
                }
                userErrors {
                  code
                }
              }
            }
          `,
        );
      // Marketers read orders, but receiving cash on them is not theirs.
      const marketer = await signUp();
      await grant(marketer.userId, shopA, 'marketer');
      expect((await importAs(marketer.accessToken)).json().errors[0]).toMatchObject({
        message:
          "Access denied. Only owners, managers and accountants reconcile couriers' remittances.",
        extensions: { code: 'ACCESS_DENIED' },
      });
      const accountant = await signUp();
      await grant(accountant.userId, shopA, 'accountant');
      await enableTwoStep(accountant.accessToken);
      expect((await importAs(accountant.accessToken)).json().data.codRemittanceImport).toEqual({
        outcomes: { unmatched: 1 },
        userErrors: [],
      });
    });

    it('lets owners, managers and accountants claim from couriers', async () => {
      const parcel = toPublicId('fulfillment', newId());
      const claimAs = (token: string) =>
        graphql(
          token,
          shopA,
          `
            mutation {
              fulfillmentClaimCreate(id: "${parcel}") {
                userErrors {
                  code
                }
              }
            }
          `,
        );
      // Packers handle parcels, but claiming money for them is not theirs.
      const packer = await signUp();
      await grant(packer.userId, shopA, 'packer');
      expect((await claimAs(packer.accessToken)).json().errors[0]).toMatchObject({
        message: 'Access denied. Only owners, managers and accountants claim from couriers.',
        extensions: { code: 'ACCESS_DENIED' },
      });
      const accountant = await signUp();
      await grant(accountant.userId, shopA, 'accountant');
      await enableTwoStep(accountant.accessToken);
      expect((await claimAs(accountant.accessToken)).json().data.fulfillmentClaimCreate).toEqual({
        userErrors: [{ code: 'NOT_FOUND' }],
      });
    });

    it('asks staff who proved who they are over 15 minutes ago to confirm it first (ADR-103)', async () => {
      const manager = await signUp();
      await grant(manager.userId, shopA, 'manager');
      const secret = await enableTwoStep(manager.accessToken);
      const EXPORT = 'mutation { customersExport { rowCount userErrors { code } } }';
      const exportWith = (key: string) =>
        api.app.inject({
          method: 'POST',
          url: ADMIN_GRAPHQL_PATH,
          headers: {
            authorization: `Bearer ${manager.accessToken}`,
            'idempotency-key': key,
            'x-hatti-shop-id': toPublicId('shop', shopA),
          },
          payload: { query: EXPORT },
        });
      // Just signed in, nothing more is asked.
      expect((await exportWith(randomUUID())).json().data.customersExport.userErrors).toEqual([]);

      await admin.query(
        `UPDATE identity.sessions SET authenticated_at = authenticated_at - interval '20 minutes'
          WHERE user_id = $1`,
        [manager.userId],
      );
      const key = randomUUID();
      const refused = await exportWith(key);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({
        errors: [
          {
            message:
              'Confirm it is you first, with your passkey, authenticator app, password, Google ' +
              'or a code sent to your number, then try again',
            extensions: { code: 'REAUTHENTICATION_REQUIRED' },
          },
        ],
      });
      // Everyday work goes on.
      const product = await graphql(
        manager.accessToken,
        shopA,
        'mutation { productCreate(input: { title: "Chunri" }) { product { handle } } }',
      );
      expect(product.json().data.productCreate.product.handle).toBe('chunri');

      // The account has an authenticator app, so that is what confirms it, not the password.
      const options = await post('/auth/reauthenticate/options', {}, manager.accessToken);
      expect(options.json()).toEqual({
        methods: ['totp'],
        passkeyOptions: null,
        googleOptions: null,
        phone: null,
      });
      const withPassword = await post(
        '/auth/reauthenticate',
        { password: PASSWORD },
        manager.accessToken,
      );
      expect(withPassword.statusCode).toBe(422);
      expect(withPassword.json().error.code).toBe('INVALID_METHOD');
      const confirmed = await post(
        '/auth/reauthenticate',
        { code: code(secret, 30_000) },
        manager.accessToken,
      );
      expect(confirmed.statusCode).toBe(200);
      const { authenticatedAt, sensitiveActionsUntil } = confirmed.json() as Record<string, string>;
      expect(Date.parse(sensitiveActionsUntil!) - Date.parse(authenticatedAt!)).toBe(15 * 60_000);
      expect((await get('/auth/me', manager.accessToken)).json().session).toMatchObject({
        mfaVerified: true,
        authenticatedAt,
      });

      // The refused request kept its key, so it goes through with it now.
      const retried = await exportWith(key);
      expect(retried.statusCode).toBe(200);
      expect(retried.json().data.customersExport.userErrors).toEqual([]);
    });
    it("lets the owner make the shop's own roles and give them, whose members' access follows them (ADM-01, ADR-578)", async () => {
      const shopF = newId();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Shop F')`, [shopF]);
      await admin.query(
        `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
         VALUES ($1, 'growth', 'monthly', now(), now() + interval '1 month')`,
        [shopF],
      );
      const owner = await signUp();
      await grant(owner.userId, shopF, 'owner');
      await enableTwoStep(owner.accessToken);
      const as = (token: string, query: string) =>
        graphql(token, shopF, query).then((response) => response.json() as Json);
      const ROLE = 'customRole { id name basedOn scopes capabilities staffMemberCount } ';
      const ERRORS = 'userErrors { field code message }';

      // What each preset holds, for the admin's editor: the owner's is never a custom role's.
      const presets = (
        await as(owner.accessToken, '{ rolePresets { role capabilities customizable } }')
      ).data.rolePresets;
      expect(presets.map((preset: Json) => [preset.role, preset.customizable])).toEqual([
        ['OWNER', false],
        ['MANAGER', true],
        ['CONFIRMATION_AGENT', true],
        ['PACKER', true],
        ['MARKETER', true],
        ['ACCOUNTANT', true],
      ]);
      expect(presets[2].capabilities).toEqual(['REVEAL_CUSTOMER_NUMBERS']);
      expect(presets[5].capabilities).toEqual([
        'EXPORT_ORDERS',
        'RECONCILE_PAYMENTS',
        'CLAIM_FROM_COURIERS',
      ]);

      const create = (input: string) =>
        as(
          owner.accessToken,
          `mutation { customRoleCreate(input: ${input}) { ${ROLE} ${ERRORS} } }`,
        );
      const made = await create(
        `{ name: "Caller, masked", basedOn: CONFIRMATION_AGENT,
           scopes: ["read_orders", "read_customers"], capabilities: [] }`,
      );
      const caller = made.data.customRoleCreate.customRole;
      expect(caller).toEqual({
        id: expect.stringMatching(/^role_/),
        name: 'Caller, masked',
        basedOn: 'CONFIRMATION_AGENT',
        scopes: ['read_orders', 'read_customers'],
        capabilities: [],
        staffMemberCount: 0,
      });
      // Never beyond its preset, nor the owner's.
      expect(
        (
          await create(
            `{ name: "Packer plus", basedOn: PACKER, scopes: ["write_products"],
               capabilities: [EXPORT_ORDERS] }`,
          )
        ).data.customRoleCreate.userErrors,
      ).toEqual([
        {
          field: ['input', 'scopes', '0'],
          code: 'INVALID',
          message: "write_products is beyond the packer role's",
        },
        {
          field: ['input', 'capabilities', '0'],
          code: 'INVALID',
          message: "export_orders is beyond the packer role's",
        },
      ]);
      expect(
        (await create('{ name: "Boss", basedOn: OWNER, scopes: [], capabilities: [] }')).data
          .customRoleCreate.userErrors[0],
      ).toMatchObject({ field: ['input', 'basedOn'], code: 'INVALID' });

      // Invited to it, an agent works in it.
      const invited = await as(
        owner.accessToken,
        `mutation { staffInvitationCreate(customRoleId: "${caller.id}") {
           invitation { role customRole { name } } token ${ERRORS} } }`,
      );
      expect(invited.data.staffInvitationCreate).toMatchObject({
        invitation: { role: 'CONFIRMATION_AGENT', customRole: { name: 'Caller, masked' } },
        userErrors: [],
      });
      const agent = await signUp();
      const accepted = await post(
        '/auth/invitations/accept',
        { token: invited.data.staffInvitationCreate.token },
        agent.accessToken,
      );
      expect(accepted.json().shop.role).toBe('confirmation_agent');

      const { token: appToken, hash, hint } = generateAccessToken();
      await admin.query(
        `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
         VALUES ($1, 'test', $2, $3, $4)`,
        [shopF, hash, hint, ['write_products', 'write_orders']],
      );
      const app = async (query: string) =>
        (
          await api.app.inject({
            method: 'POST',
            url: ADMIN_GRAPHQL_PATH,
            headers: { 'x-hatti-access-token': appToken, 'idempotency-key': randomUUID() },
            payload: { query },
          })
        ).json().data;
      const product = await app(
        'mutation { productCreate(input: { title: "Kurta", status: ACTIVE, ' +
          'variants: [{ price: "2,000" }] }) { product { variants { id } } } }',
      );
      const orderId = (
        await app(
          `mutation { orderCreate(input: {
             lineItems: [{ variantId: "${product.productCreate.product.variants[0].id}", quantity: 1 }]
             paymentMethod: CASH_ON_DELIVERY
             shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                                address1: "House 12, Street 4", city: "Karachi" } }) {
             order { id } } }`,
        )
      ).orderCreate.order.id as string;

      // Its scopes alone, and numbers masked with no reveal.
      expect(
        (await as(agent.accessToken, `{ order(id: "${orderId}") { phone } }`)).data.order,
      ).toEqual({ phone: '0300 ••••567' });
      expect(
        (await as(agent.accessToken, '{ products(first: 1) { nodes { id } } }')).errors[0]
          .extensions.code,
      ).toBe('ACCESS_DENIED');
      const reveal = `mutation { orderPhoneReveal(id: "${orderId}") { phone } }`;
      expect((await as(agent.accessToken, reveal)).errors[0].extensions.code).toBe('ACCESS_DENIED');
      // Changed, it counts from their next request.
      const updated = await as(
        owner.accessToken,
        `mutation { customRoleUpdate(id: "${caller.id}",
           input: { capabilities: [REVEAL_CUSTOMER_NUMBERS] }) { ${ROLE} ${ERRORS} } }`,
      );
      expect(updated.data.customRoleUpdate.customRole).toMatchObject({
        capabilities: ['REVEAL_CUSTOMER_NUMBERS'],
        staffMemberCount: 1,
      });
      expect((await as(agent.accessToken, reveal)).data.orderPhoneReveal).toEqual({
        phone: '+923001234567',
      });

      // A manager in a role without exports or staff exports none, and manages no one.
      const lead = await create(
        '{ name: "Lead", basedOn: MANAGER, scopes: ["write_orders"], capabilities: [ASSIGN_ORDERS] }',
      );
      const leadId = lead.data.customRoleCreate.customRole.id;
      const manager = await signUp();
      await grant(manager.userId, shopF, 'manager');
      await enableTwoStep(manager.accessToken);
      const changed = await as(
        owner.accessToken,
        `mutation { staffMemberRoleUpdate(id: "${toPublicId('user', manager.userId)}",
           customRoleId: "${leadId}") { staffMember { role customRole { name } } ${ERRORS} } }`,
      );
      expect(changed.data.staffMemberRoleUpdate).toEqual({
        staffMember: { role: 'MANAGER', customRole: { name: 'Lead' } },
        userErrors: [],
      });
      // The admin is told as much, to show them what they can use (ADR-580).
      const shopsOf = async (token: string) =>
        (await get('/auth/me', token)).json().shops as Json[];
      expect(await shopsOf(manager.accessToken)).toEqual([
        {
          id: toPublicId('shop', shopF),
          name: 'Shop F',
          role: 'manager',
          mfaRequired: true,
          scopes: ['write_orders'],
          capabilities: ['assign_orders'],
          customRole: { id: leadId, name: 'Lead' },
          agreementDue: false,
        },
      ]);
      expect(await shopsOf(agent.accessToken)).toMatchObject([
        {
          role: 'confirmation_agent',
          scopes: ['read_orders', 'read_customers'],
          capabilities: ['reveal_customer_numbers'],
          customRole: { id: caller.id, name: 'Caller, masked' },
        },
      ]);
      expect(
        (await as(manager.accessToken, 'mutation { ordersExport { rowCount } }')).errors[0],
      ).toMatchObject({
        message: 'Access denied. Only owners, managers and accountants export orders.',
        extensions: { code: 'ACCESS_DENIED' },
      });
      expect(
        (await as(manager.accessToken, '{ customRoles { id } }')).errors[0].extensions.code,
      ).toBe('ACCESS_DENIED');
      expect(
        (await as(manager.accessToken, `{ order(id: "${orderId}") { phone } }`)).data.order,
      ).toEqual({ phone: '0300 ••••567' });

      // Held, a custom role is not deleted; the owner sees who holds each.
      const STAFF =
        '{ staffMembers { role customRole { name } } customRoles { name staffMemberCount } }';
      expect((await as(owner.accessToken, STAFF)).data).toEqual({
        staffMembers: [
          { role: 'OWNER', customRole: null },
          { role: 'CONFIRMATION_AGENT', customRole: { name: 'Caller, masked' } },
          { role: 'MANAGER', customRole: { name: 'Lead' } },
        ],
        customRoles: [
          { name: 'Caller, masked', staffMemberCount: 1 },
          { name: 'Lead', staffMemberCount: 1 },
        ],
      });
      const remove = (id: string) =>
        as(
          owner.accessToken,
          `mutation { customRoleDelete(id: "${id}") { deletedCustomRoleId ${ERRORS} } }`,
        );
      expect((await remove(leadId)).data.customRoleDelete).toEqual({
        deletedCustomRoleId: null,
        userErrors: [
          {
            field: ['id'],
            code: 'IN_USE',
            message:
              '1 member of staff has this role: give them another, or take the invitations ' +
              'back, first',
          },
        ],
      });
      await as(
        owner.accessToken,
        `mutation { staffMemberRoleUpdate(id: "${toPublicId('user', manager.userId)}",
           role: MANAGER) { ${ERRORS} } }`,
      );
      expect((await remove(leadId)).data.customRoleDelete).toEqual({
        deletedCustomRoleId: leadId,
        userErrors: [],
      });
      const log = await as(
        owner.accessToken,
        '{ auditLog(first: 6) { nodes { action subjectId } } }',
      );
      expect(log.data.auditLog.nodes.map((node: Json) => node.action)).toEqual([
        'staff.custom_role_deleted',
        'staff.role_changed',
        'staff.role_changed',
        'staff.custom_role_created',
        'order.phone_revealed',
        'staff.custom_role_updated',
      ]);
    });

    it('lets the owner hand the shop to a manager, and no one else (ADR-104)', async () => {
      const shopD = newId();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Shop D')`, [shopD]);
      const owner = await signUp();
      await grant(owner.userId, shopD, 'owner');
      await enableTwoStep(owner.accessToken);
      const manager = await signUp();
      await grant(manager.userId, shopD, 'manager');
      await enableTwoStep(manager.accessToken);
      const transfer = (token: string, to: string) =>
        graphql(
          token,
          shopD,
          `mutation { shopOwnershipTransfer(staffMemberId: "${toPublicId('user', to)}") {
             owner { name role } previousOwner { role } userErrors { field code message } } }`,
        );

      expect((await transfer(manager.accessToken, owner.userId)).json().errors[0]).toMatchObject({
        message: 'Access denied. Only the owner hands the shop over.',
        extensions: { code: 'ACCESS_DENIED' },
      });
      const handed = await transfer(owner.accessToken, manager.userId);
      expect(handed.json().data.shopOwnershipTransfer).toEqual({
        owner: { name: 'Sana Iqbal', role: 'OWNER' },
        previousOwner: { role: 'MANAGER' },
        userErrors: [],
      });
      // From the next request, the old owner is a manager and cannot take it back.
      expect((await transfer(owner.accessToken, owner.userId)).json().errors[0]).toMatchObject({
        extensions: { code: 'ACCESS_DENIED' },
      });
      const log = await graphql(
        manager.accessToken,
        shopD,
        '{ auditLog(first: 1) { nodes { action subjectId details actor { role } } } }',
      );
      expect(log.json().data.auditLog.nodes).toEqual([
        {
          action: 'shop.ownership_transferred',
          subjectId: toPublicId('shop', shopD),
          details: JSON.stringify({
            to: toPublicId('user', manager.userId),
            from: toPublicId('user', owner.userId),
          }),
          actor: { role: 'owner' },
        },
      ]);
    });
  });
});
