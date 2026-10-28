import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from '../api/constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';
import { startTestConsole, type TestConsole } from '../testing/console.js';
import { fakeOidcProvider } from '../testing/oidc-provider.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const PASSWORD = 'correct horse battery staple';
const CLIENT = { id: 'hatti-console', secret: 'the-console-secret-of-hatti' };
const CONSOLE_URL = 'https://console.hatti.example';

describe.skipIf(!server)("Hatti's console (ADR-876)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let consoleApi: TestConsole;
  let provider: Awaited<ReturnType<typeof fakeOidcProvider>>;
  const shop = newId();
  let packer = '';

  /** The console's server, as the console's address passes requests to it. */
  const call = (method: 'GET' | 'POST', url: string, token?: string, payload?: object) =>
    consoleApi.app.inject({
      method,
      url,
      ...(payload && { payload }),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  async function signUp(email: string, name: string) {
    const body = (
      await api.app.inject({
        method: 'POST',
        url: '/auth/sign-up',
        payload: { email, password: PASSWORD, name },
      })
    ).json() as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, userId: fromPublicId(body.user.id, 'user') };
  }

  /** Through Hatti's provider as `email`, back to the console's page with a code, or why not. */
  async function signIn(email: string, options: { amr?: string[] } = {}) {
    const started = (await call('POST', '/console/api/auth/start', undefined, {})).json() as {
      url: string;
      state: string;
    };
    const { code, state } = provider.signIn(started.url, email, {
      amr: options.amr ?? ['hwk', 'mfa'],
    });
    const back = await call('GET', `/console/api/auth/callback?code=${code}&state=${state}`);
    expect(back.statusCode).toBe(303);
    const page = new URL(back.headers.location as string);
    expect(page.origin + page.pathname).toBe(`${CONSOLE_URL}/signed-in`);
    return { page, started };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    provider = await fakeOidcProvider(CLIENT);
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    api = await startTestApi(testDb);
    consoleApi = await startTestConsole(testDb, {
      issuer: provider.issuer,
      clientId: CLIENT.id,
      clientSecret: CLIENT.secret,
      consoleUrl: CONSOLE_URL,
      requiredAmr: ['hwk'],
    });
    const agent = await signUp('ayesha@hatti.pk', 'Ayesha');
    await admin.query('INSERT INTO identity.support_agents (user_id) VALUES ($1)', [agent.userId]);
    await signUp('bilal@hatti.pk', 'Bilal');
    const staff = await signUp('omar@zari.pk', 'Omar');
    packer = staff.token;
    await admin.query(
      `INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, 'packer')`,
      [staff.userId, shop],
    );
  });

  afterAll(async () => {
    await admin?.end();
    await consoleApi?.close();
    await api?.close();
    provider?.http.close();
    await testDb?.drop();
  });

  it("signs Hatti's agents in through Hatti's provider with their key, and no one else", async () => {
    const { page, started } = await signIn('Ayesha@hatti.pk');
    const authorize = new URL(started.url);
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `${CONSOLE_URL}/console/api/auth/callback`,
    );
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(page.searchParams.get('state')).toBe(started.state);
    const redeemed = await call('POST', '/console/api/auth/redeem', undefined, {
      code: page.searchParams.get('code'),
    });
    expect(redeemed.statusCode).toBe(200);
    const session = redeemed.json() as Json;
    expect(session.token).toMatch(/^hcs_/);
    expect(session.agent).toMatchObject({ email: 'ayesha@hatti.pk', name: 'Ayesha' });
    // A code is traded once.
    const again = await call('POST', '/console/api/auth/redeem', undefined, {
      code: page.searchParams.get('code'),
    });
    expect(again.statusCode).toBe(400);
    expect((again.json() as Json).error.code).toBe('CONSOLE_EXPIRED');

    expect((await call('GET', '/console/api/auth/me', session.token)).json()).toMatchObject({
      agent: { email: 'ayesha@hatti.pk' },
    });
    // Not one of Hatti's agents; no key; an answer replayed.
    expect((await signIn('bilal@hatti.pk')).page.searchParams.get('error')).toBe('not_agent');
    expect((await signIn('ayesha@hatti.pk', { amr: ['pwd'] })).page.searchParams.get('error')).toBe(
      'no_key',
    );
    const replayed = await call('GET', `/console/api/auth/callback?code=x&state=${started.state}`);
    expect(new URL(replayed.headers.location as string).searchParams.get('error')).toBe('expired');

    // The console's session reaches nothing else, and no other session reaches the console.
    const shopCall = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: {
        authorization: `Bearer ${session.token}`,
        'x-hatti-shop-id': toPublicId('shop', shop),
        'idempotency-key': randomUUID(),
      },
      payload: { query: '{ shop { name } }' },
    });
    expect((shopCall.json() as Json).data?.shop).toBeUndefined();
    // The API serves no console, and a staff session reaches none.
    expect(
      (await api.app.inject({ method: 'GET', url: '/console/api/support-requests' })).statusCode,
    ).toBe(404);
    const staffCall = await call('GET', '/console/api/support-requests', packer);
    expect(staffCall.statusCode).toBe(401);
    expect((staffCall.json() as Json).error.code).toBe('CONSOLE_SIGNED_OUT');

    // Signed out, the token reaches nothing more.
    expect((await call('POST', '/console/api/auth/sign-out', session.token)).statusCode).toBe(204);
    expect((await call('GET', '/console/api/auth/me', session.token)).statusCode).toBe(401);
  });

  it("answers shops' requests as the agent signed in, each answer logged first", async () => {
    const asked = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: {
        authorization: `Bearer ${packer}`,
        'x-hatti-shop-id': toPublicId('shop', shop),
        'idempotency-key': randomUUID(),
      },
      payload: {
        query: `mutation ($input: SupportRequestInput!) {
          supportRequestCreate(input: $input) { request { id } userErrors { field } } }`,
        variables: {
          input: {
            topic: 'COURIERS',
            message: 'PostEx bookings fail for Multan.',
            language: 'ENGLISH',
          },
        },
      },
    });
    const requestId = (asked.json() as Json).data.supportRequestCreate.request.id as string;
    const { page } = await signIn('ayesha@hatti.pk');
    const { token } = (
      await call('POST', '/console/api/auth/redeem', undefined, {
        code: page.searchParams.get('code'),
      })
    ).json() as Json;

    const waiting = (await call('GET', '/console/api/support-requests', token)).json() as Json;
    expect(waiting.requests).toEqual([
      expect.objectContaining({
        id: requestId,
        shop: { id: toPublicId('shop', shop), name: 'Zari', plan: 'free' },
        channel: 'admin',
        topic: 'couriers',
        message: 'PostEx bookings fail for Multan.',
        late: false,
        lastInbound: null,
      }),
    ]);
    const blank = await call('POST', `/console/api/support-requests/${requestId}/answer`, token, {
      answer: ' ',
    });
    expect(blank.statusCode).toBe(422);
    expect((blank.json() as Json).error.fields).toEqual({ answer: 'BLANK' });

    const answered = await call(
      'POST',
      `/console/api/support-requests/${requestId}/answer`,
      token,
      { answer: 'PostEx fixed Multan; book again.' },
    );
    expect(answered.statusCode).toBe(200);
    expect((answered.json() as Json).whatsapp).toBe('none');
    expect(
      ((await call('GET', '/console/api/support-requests', token)).json() as Json).requests,
    ).toEqual([]);
    const { rows } = await admin.query(
      `SELECT answer, answered_by FROM billing.support_requests WHERE id = $1`,
      [fromPublicId(requestId, 'supportRequest')],
    );
    expect(rows[0]).toEqual({ answer: 'PostEx fixed Multan; book again.', answered_by: 'Ayesha' });
    // Answered already: nothing to answer, though it was asked.
    expect(
      (
        await call('POST', `/console/api/support-requests/${requestId}/answer`, token, {
          answer: 'Again',
        })
      ).statusCode,
    ).toBe(404);

    const log = (await call('GET', '/console/api/actions', token)).json() as Json;
    expect(log.actions.map((each: Json) => [each.email, each.action, each.subject])).toEqual([
      ['ayesha@hatti.pk', 'support_request.answer', requestId],
      ['ayesha@hatti.pk', 'support_request.answer', requestId],
    ]);
    // The log is kept: the identity login can't change or delete it.
    const identity = new pg.Client({ connectionString: testDb.identityUrl });
    await identity.connect();
    try {
      await expect(identity.query('DELETE FROM identity.console_actions')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await identity.end();
    }
  });
});
