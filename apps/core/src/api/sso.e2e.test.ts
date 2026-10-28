import 'reflect-metadata';
import { generateKeyPairSync, randomUUID, sign as signWith, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StaffRole } from '@hatti/api';
import { base32Decode, totp } from '@hatti/crypto';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const PASSWORD = 'correct horse battery staple';
const CLIENT = { id: 'hatti-zari', secret: 'organisation-secret-0042' };

/**
 * An organisation's identity provider, as OpenID Connect has it: its configuration, its keys,
 * and a token endpoint trading the codes the test gives out for ID tokens it signs.
 */
async function fakeProvider() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { email: string; nonce: string; verified?: boolean }>();
  let base = '';
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  /** An ID token, RS256 as providers sign them. */
  const sign = (claims: Record<string, unknown>, key: KeyObject = privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    const body = `${part({ alg: 'RS256', kid: 'key-1', typ: 'JWT' })}.${part({
      iss: base,
      aud: CLIENT.id,
      sub: `user-${String(claims.email)}`,
      iat: now,
      exp: now + 300,
      ...claims,
    })}`;
    return `${body}.${signWith('sha256', Buffer.from(body), key).toString('base64url')}`;
  };
  const http: Server = createServer((request, response) => {
    const url = new URL(request.url!, base);
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        const form = new URLSearchParams(body);
        const basic = Buffer.from(
          (request.headers.authorization ?? '').replace(/^Basic /, ''),
          'base64',
        ).toString('utf8');
        const given = codes.get(form.get('code') ?? '');
        if (basic !== `${CLIENT.id}:${CLIENT.secret}` || !given || !form.get('code_verifier')) {
          return json(400, { error: 'invalid_grant' });
        }
        codes.delete(form.get('code')!);
        json(200, {
          access_token: 'at',
          id_token: sign({
            email: given.email,
            email_verified: given.verified ?? true,
            nonce: given.nonce,
          }),
        });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    http,
    get issuer() {
      return base;
    },
    /** The provider signing `email` in for the sign-in its authorize address began. */
    signIn(
      authorizeUrl: string,
      email: string,
      options: { verified?: boolean; nonce?: string } = {},
    ) {
      const url = new URL(authorizeUrl);
      const code = randomUUID();
      codes.set(code, {
        email,
        nonce: options.nonce ?? url.searchParams.get('nonce')!,
        ...(options.verified !== undefined && { verified: options.verified }),
      });
      return { code, state: url.searchParams.get('state')! };
    },
  };
}

describe.skipIf(!server)('Single sign-on for staff (ADM-09, ADR-864)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let provider: Awaited<ReturnType<typeof fakeProvider>>;
  const shop = newId();
  const otherShop = newId();

  const post = (url: string, payload: object, token?: string) =>
    api.app.inject({
      method: 'POST',
      url,
      payload,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  async function account(email: string, role: StaffRole, twoStep = true): Promise<string> {
    const body = (
      await post('/auth/sign-up', { email, password: PASSWORD, name: 'Sana Iqbal' })
    ).json() as {
      accessToken: string;
      user: { id: string };
    };
    await admin.query(
      'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
      [fromPublicId(body.user.id, 'user'), shop, role],
    );
    if (twoStep) {
      const { secret } = (await post('/auth/two-step/totp/setup', {}, body.accessToken)).json() as {
        secret: string;
      };
      await post(
        '/auth/two-step/totp/confirm',
        { code: totp(base32Decode(secret), Date.now()) },
        body.accessToken,
      );
    }
    return body.accessToken;
  }

  async function gql(token: string, query: string, variables?: object, shopId = shop) {
    const response = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: {
        authorization: `Bearer ${token}`,
        'x-hatti-shop-id': toPublicId('shop', shopId),
        'idempotency-key': randomUUID(),
      },
      payload: { query, variables },
    });
    return {
      status: response.statusCode,
      ...(response.json() as { data?: Json; errors?: Json[] }),
    };
  }

  /** A sign-in through the provider, as `email`, from the admin's start to its session. */
  async function ssoSignIn(email: string, options: { verified?: boolean; nonce?: string } = {}) {
    const started = await post('/auth/sso/start', { email });
    if (started.statusCode !== 200) return { started };
    const { url, state } = started.json() as { url: string; state: string };
    const answer = provider.signIn(url, email, options);
    expect(answer.state).toBe(state);
    const back = await api.app.inject({
      method: 'GET',
      url: `/auth/sso/callback?code=${answer.code}&state=${answer.state}`,
    });
    expect(back.statusCode).toBe(303);
    const admin = new URL(back.headers.location as string);
    const handoff = admin.searchParams.get('code');
    if (!handoff) return { error: admin.searchParams.get('error') };
    expect(admin.pathname).toBe('/sso/callback');
    expect(admin.searchParams.get('state')).toBe(state);
    const redeemed = await post('/auth/sso/redeem', { code: handoff });
    return { handoff, redeemed, json: redeemed.json() as Json };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari'), ($2, 'Rang', 'rang')`,
      [shop, otherShop],
    );
    provider = await fakeProvider();
    api = await startTestApi(testDb);
  });

  afterAll(async () => {
    await api?.close();
    await new Promise((resolve) => provider?.http.close(resolve));
    await admin?.end();
    await testDb?.drop();
  });

  it("signs the shop's staff in through its provider, and admits them alone where it requires it", async () => {
    const owner = await account('owner@zari.pk', 'owner');
    const managerPassword = await account('ali@zari.pk', 'manager');
    await account('saima@zari.pk', 'confirmation_agent', false);

    // Before the shop sets it up, no shop signs in the domain's people.
    expect((await ssoSignIn('ali@zari.pk')).started?.statusCode).toBe(404);

    const SAVE = `mutation ($input: ShopSsoInput!) {
      shopSsoUpdate(input: $input) {
        sso { issuer clientId secretHint emailDomains required providerMfa callbackUrl }
        userErrors { field message } } }`;
    const input = {
      issuer: provider.issuer,
      clientId: CLIENT.id,
      emailDomains: ['Zari.pk'],
      required: false,
      providerMfa: true,
    };
    expect((await gql(managerPassword, SAVE, { input })).errors?.[0]?.message).toContain(
      "Only the shop's owner sets its single sign-on",
    );
    expect((await gql(owner, SAVE, { input })).data.shopSsoUpdate.userErrors).toEqual([
      { field: ['input', 'clientSecret'], message: "Client secret can't be blank" },
    ]);
    const saved = await gql(owner, SAVE, { input: { ...input, clientSecret: CLIENT.secret } });
    expect(saved.data.shopSsoUpdate.sso).toEqual({
      issuer: provider.issuer,
      clientId: CLIENT.id,
      secretHint: '0042',
      emailDomains: ['zari.pk'],
      required: false,
      providerMfa: true,
      callbackUrl: 'http://localhost:4000/auth/sso/callback',
    });

    // A member signs in through it; their session is two-step verified, as the provider asks.
    const ali = await ssoSignIn('ali@zari.pk');
    expect(ali.redeemed!.statusCode).toBe(200);
    expect(ali.json).toMatchObject({ status: 'signed_in', session: { mfaVerified: true } });
    const viaSso = ali.json.accessToken as string;
    expect((await gql(viaSso, '{ shop { name } }')).data).toEqual({ shop: { name: 'Zari' } });
    // Its code is good once.
    expect((await post('/auth/sso/redeem', { code: ali.handoff })).statusCode).toBe(400);

    // The session reaches Zari alone: not another shop Ali works in, nor Ali's account, as the
    // shop's owner chose the provider and vouches for nothing else of theirs.
    const aliId = (ali.json.user as { id: string }).id;
    await admin.query(
      `INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, 'manager')`,
      [fromPublicId(aliId, 'user'), otherShop],
    );
    expect((await gql(managerPassword, '{ shop { name } }', undefined, otherShop)).data).toEqual({
      shop: { name: 'Rang' },
    });
    expect((await gql(viaSso, '{ shop { name } }', undefined, otherShop)).data?.shop).toBeFalsy();
    const me = await api.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${viaSso}` },
    });
    expect((me.json() as Json).shops.map((each: { name: string }) => each.name)).toEqual(['Zari']);
    for (const url of ['/auth/passkeys/options', '/auth/two-step/totp/setup', '/auth/shops']) {
      const refused = await post(url, {}, viaSso);
      expect([refused.statusCode, (refused.json() as Json).error.code]).toEqual([
        403,
        'SSO_SESSION',
      ]);
    }

    // Not a member, an email not of the shop's domains, or a token for another sign-in: no.
    expect((await ssoSignIn('stranger@zari.pk')).error).toBe('not_member');
    expect((await ssoSignIn('ali@zari.pk', { verified: false })).error).toBe('not_member');
    expect((await ssoSignIn('ali@zari.pk', { nonce: 'another' })).error).toBe('invalid');
    const replay = await api.app.inject({
      method: 'GET',
      url: '/auth/sso/callback?code=x&state=not-a-state',
    });
    expect(new URL(replay.headers.location as string).searchParams.get('error')).toBe('expired');

    // Required, the shop admits its members only through it; its owner keeps their own way in.
    await gql(owner, SAVE, { input: { ...input, required: true } });
    const refused = await gql(managerPassword, '{ shop { name } }');
    expect([refused.status, refused.errors?.[0]?.extensions?.code]).toEqual([403, 'SSO_REQUIRED']);
    expect((await gql(viaSso, '{ shop { name } }')).data).toEqual({ shop: { name: 'Zari' } });
    expect((await gql(owner, '{ shop { name } }')).data).toEqual({ shop: { name: 'Zari' } });

    // A member whose provider asks no second factor, in a role that needs one, is told so.
    await gql(owner, SAVE, { input: { ...input, required: true, providerMfa: false } });
    const noMfa = await ssoSignIn('ali@zari.pk');
    const told = await gql(noMfa.json.accessToken, '{ shop { name } }');
    expect(told.errors?.[0]?.extensions?.code).toBe('MFA_REQUIRED');
    const saima = await ssoSignIn('saima@zari.pk');
    expect((await gql(saima.json.accessToken, '{ shop { name } }')).data).toEqual({
      shop: { name: 'Zari' },
    });

    expect((await gql(owner, 'mutation { shopSsoDelete }')).data).toEqual({ shopSsoDelete: true });
    expect((await gql(managerPassword, '{ shop { name } }')).data).toEqual({
      shop: { name: 'Zari' },
    });
    const { rows } = await admin.query(
      `SELECT action FROM platform.audit_log WHERE action LIKE 'sso.%' ORDER BY id`,
    );
    expect(rows.map((row) => row.action)).toEqual([
      'sso.updated',
      'sso.updated',
      'sso.updated',
      'sso.deleted',
    ]);
  });
});
