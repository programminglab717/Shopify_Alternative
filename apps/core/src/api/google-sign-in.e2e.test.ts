import 'reflect-metadata';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { GoogleTestIssuer, type GoogleTestClaims } from '@hatti/identity/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe.skipIf(!server)('/auth/google: merchants sign up and in with Google (ADR-164)', () => {
  let testDb: TestDatabase;
  let api: TestApi;
  let google: GoogleTestIssuer;

  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
    token?: string,
  ) =>
    api.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  /** Starts Google's sign-in here, which comes back with its ID token saying `claims`. */
  const fromGoogle = async (claims: Omit<GoogleTestClaims, 'nonce'>) => {
    const { nonce } = (await call('POST', '/auth/google/options')).json() as Json;
    return { idToken: await google.idToken({ ...claims, nonce }) };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    google = await GoogleTestIssuer.create();
    api = await startTestApi(testDb, {
      google: { clientIds: [google.clientId], keys: google.keys },
    });
  });

  afterAll(async () => {
    await api?.close();
    await testDb?.drop();
  });

  it('opens an account with Google, opens a shop with it, and signs it in again', async () => {
    const options = await call('POST', '/auth/google/options');
    expect([options.statusCode, options.headers['cache-control']]).toEqual([200, 'no-store']);
    expect(options.json()).toEqual({
      clientId: google.clientId,
      nonce: expect.stringMatching(/^[\w-]{43}$/),
      expiresAt: expect.any(String),
    });
    const subject = '109876543210987654321';
    const idToken = await google.idToken({
      sub: subject,
      nonce: options.json().nonce,
      email: 'nadia@example.pk',
      email_verified: true,
      name: 'Nadia Hussain',
    });
    const opened = await call('POST', '/auth/google/sign-in', { idToken });
    expect([opened.statusCode, opened.headers['cache-control']]).toEqual([200, 'no-store']);
    const body = opened.json() as Json;
    expect(body).toEqual({
      status: 'signed_in',
      signedUp: true,
      user: {
        id: expect.stringMatching(/^usr_/),
        email: 'nadia@example.pk',
        emailVerified: true,
        name: 'Nadia Hussain',
        phone: null,
        phoneVerified: false,
        mfaEnabled: false,
      },
      accessToken: expect.stringMatching(/^hsa_/),
      accessTokenExpiresAt: expect.any(String),
      refreshToken: expect.stringMatching(/^hsr_/),
      refreshTokenExpiresAt: expect.any(String),
      session: expect.objectContaining({ mfaVerified: false }),
    });
    // Its nonce answered once.
    const replayed = await call('POST', '/auth/google/sign-in', { idToken });
    expect([replayed.statusCode, replayed.json().error.code]).toEqual([401, 'INVALID_CHALLENGE']);

    const me = await call('GET', '/auth/me', undefined, body.accessToken);
    expect(me.json()).toMatchObject({
      user: { email: 'nadia@example.pk' },
      shops: [],
      google: { email: 'nadia@example.pk', connectedAt: expect.any(String) },
    });
    const shop = await call('POST', '/auth/shops', { name: 'Nadia Crafts' }, body.accessToken);
    expect([shop.statusCode, shop.json().shop]).toMatchObject([
      201,
      { name: 'Nadia Crafts', handle: 'nadia-crafts', role: 'owner', mfaRequired: true },
    ]);

    const again = await call('POST', '/auth/google/sign-in', await fromGoogle({ sub: subject }));
    expect([again.statusCode, again.json()]).toMatchObject([
      200,
      { status: 'signed_in', signedUp: false, user: { id: body.user.id } },
    ]);
    // Google is the account's only way in, so it stays.
    const kept = await call('DELETE', '/auth/google', undefined, body.accessToken);
    expect([kept.statusCode, kept.json().error.code]).toEqual([409, 'ONLY_SIGN_IN_METHOD']);
  });

  it('connects Google to an account opened with a password, from the account, and disconnects it', async () => {
    const opened = await call('POST', '/auth/sign-up', {
      email: 'faisal@example.pk',
      password: 'correct horse battery staple',
      name: 'Faisal Qureshi',
    });
    const token = (opened.json() as Json).accessToken;
    const theirs = {
      sub: '101010101010101010101',
      email: 'faisal@example.pk',
      email_verified: true,
    };
    const refused = await call('POST', '/auth/google/sign-in', await fromGoogle(theirs));
    expect([refused.statusCode, refused.json().error]).toEqual([
      409,
      {
        code: 'GOOGLE_NOT_CONNECTED',
        message:
          'An account has this email. Sign in to it your usual way, then connect Google to it',
      },
    ]);
    const anonymous = await call('POST', '/auth/google', await fromGoogle(theirs));
    expect(anonymous.statusCode).toBe(401);

    const connected = await call('POST', '/auth/google', await fromGoogle(theirs), token);
    expect([connected.statusCode, connected.json()]).toEqual([
      201,
      { google: { email: 'faisal@example.pk', connectedAt: expect.any(String) } },
    ]);
    const signedIn = await call('POST', '/auth/google/sign-in', await fromGoogle(theirs));
    expect(signedIn.json()).toMatchObject({
      status: 'signed_in',
      signedUp: false,
      user: { email: 'faisal@example.pk', name: 'Faisal Qureshi' },
    });

    const disconnected = await call('DELETE', '/auth/google', undefined, token);
    expect(disconnected.statusCode).toBe(204);
    expect((await call('GET', '/auth/me', undefined, token)).json().google).toBeNull();
    const tooLong = await call('POST', '/auth/google/sign-in', { idToken: 'x'.repeat(5_000) });
    expect([tooLong.statusCode, tooLong.json().error.code]).toEqual([400, 'INVALID_INPUT']);
  });
});
