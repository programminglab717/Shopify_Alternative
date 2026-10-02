import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
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

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const GRANT = `mutation ($minutes: Int, $note: String) {
  supportAccessGrant(minutes: $minutes, note: $note) {
    grant { id access note grantedBy expiresAt endedAt open }
    userErrors { field code message } } }`;

describe.skipIf(!server)("Admin GraphQL API: Hatti's support, with the owner's consent", () => {
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

  /** An account signed in with a second factor; in the shop in `role`, if given. */
  async function account(role: StaffRole | null): Promise<{ token: string; userId: string }> {
    const email = `support-${randomBytes(4).toString('hex')}@example.pk`;
    const signedUp = await post('/auth/sign-up', { email, password: PASSWORD, name: 'Sana Iqbal' });
    expect(signedUp.statusCode).toBe(201);
    const body = signedUp.json() as { accessToken: string; user: { id: string } };
    const userId = fromPublicId(body.user.id, 'user');
    if (role) {
      await admin.query(
        'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
        [userId, shop, role],
      );
    }
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

  it('lets support look while the owner allows it, numbers masked, changing nothing, each look logged', async () => {
    const owner = await account('owner');
    const manager = await account('manager');
    const agent = await account(null);
    await admin.query('INSERT INTO identity.support_agents (user_id) VALUES ($1)', [agent.userId]);
    const { token: app, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, '{write_customers,read_settings}')`,
      [shop, hash, hint],
    );
    const created = await data(
      app,
      'mutation { customerCreate(input: { phone: "03001234567", name: "Ayesha Khan" }) { customer { id } userErrors { code } } }',
    );
    expect(created.userErrors).toEqual([]);

    // Not yet allowed: the shop is closed to support, and it lists none open to it.
    const shops = (token: string) =>
      api.app.inject({
        method: 'GET',
        url: '/auth/support/shops',
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await shops(agent.token)).json()).toEqual({ shops: [] });
    expect([(await shops(owner.token)).statusCode, (await shops(owner.token)).json()]).toEqual([
      403,
      {
        error: {
          code: 'NOT_SUPPORT',
          message: "Only Hatti's support agents see the shops open to them",
        },
      },
    ]);
    const closed = await gql(agent.token, '{ shop { name } }');
    expect([closed.status, closed.errors?.[0].extensions.code]).toEqual([403, 'NO_SHOP_ACCESS']);

    // The owner alone allows it, for a while; not a manager, nor an app.
    expect((await gql(manager.token, GRANT, { minutes: 30 })).errors?.[0].extensions.code).toBe(
      'ACCESS_DENIED',
    );
    expect((await gql(app, GRANT, { minutes: 30 })).errors?.[0].extensions.code).toBe(
      'ACCESS_DENIED',
    );
    expect((await data(owner.token, GRANT, { minutes: 5 })).userErrors).toEqual([
      {
        field: ['minutes'],
        code: 'INVALID',
        message: 'Support may look for 15 minutes to a day: 15 to 1440 minutes',
      },
    ]);
    const granted = await data(owner.token, GRANT, { minutes: 30, note: "Order won't ship" });
    expect(granted).toEqual({
      grant: {
        id: expect.stringMatching(/^sgr_/),
        access: 'READ',
        note: "Order won't ship",
        grantedBy: 'Sana Iqbal',
        expiresAt: expect.any(String),
        endedAt: null,
        open: true,
      },
      userErrors: [],
    });
    expect(await data(manager.token, '{ supportAccess { id open } }')).toEqual({
      id: granted.grant.id,
      open: true,
    });
    expect((await shops(agent.token)).json()).toEqual({
      shops: [
        {
          id: toPublicId('shop', shop),
          name: 'Zari',
          handle: 'zari',
          note: "Order won't ship",
          expiresAt: granted.grant.expiresAt,
        },
      ],
    });

    // Support reads, numbers masked as most staff see them.
    expect(await data(agent.token, '{ shop { name } }')).toEqual({ name: 'Zari' });
    expect(
      await data(agent.token, 'query Customers { customers(first: 5) { nodes { name phone } } }'),
    ).toEqual({ nodes: [{ name: 'Ayesha Khan', phone: '0300 ••••567' }] });
    // And changes nothing: refused before it runs.
    const changed = await gql(
      agent.token,
      `mutation { customerUpdate(id: "${created.customer.id}", input: { name: "X" }) {
        userErrors { code } } }`,
    );
    expect([changed.status, changed.errors?.[0].extensions.code]).toEqual([
      403,
      'SUPPORT_READ_ONLY',
    ]);
    const ended = await gql(agent.token, 'mutation { supportAccessEnd { grant { id } } }');
    expect(ended.errors?.[0].extensions.code).toBe('SUPPORT_READ_ONLY');

    // Each look is on the shop's audit log, as support.
    const looked = await data(
      owner.token,
      `{ auditLog(action: "support.looked") { nodes { action subjectId actor { kind id role } details } } }`,
    );
    expect(
      looked.nodes.map((entry: Json) => ({ ...entry, details: JSON.parse(entry.details) })),
    ).toEqual([
      {
        action: 'support.looked',
        subjectId: toPublicId('shop', shop),
        actor: { kind: 'SUPPORT', id: toPublicId('user', agent.userId), role: null },
        details: { grant: granted.grant.id, operation: 'Customers', fields: ['customers'] },
      },
      {
        action: 'support.looked',
        subjectId: toPublicId('shop', shop),
        actor: { kind: 'SUPPORT', id: toPublicId('user', agent.userId), role: null },
        details: { grant: granted.grant.id, operation: null, fields: ['shop'] },
      },
    ]);

    // A manager ends it at once: the shop is closed to support again.
    const end = await data(
      manager.token,
      'mutation { supportAccessEnd { grant { id open endedAt } userErrors { code } } }',
    );
    expect(end).toEqual({
      grant: { id: granted.grant.id, open: false, endedAt: expect.any(String) },
      userErrors: [],
    });
    const after = await gql(agent.token, '{ shop { name } }');
    expect([after.status, after.errors?.[0].extensions.code]).toEqual([403, 'NO_SHOP_ACCESS']);
    expect(
      (await data(manager.token, 'mutation { supportAccessEnd { userErrors { code } } }'))
        .userErrors,
    ).toEqual([{ code: 'NOT_FOUND' }]);
    expect(await data(owner.token, '{ supportAccess { id } }')).toBeNull();
    expect(await data(owner.token, '{ supportAccessGrants { id open endedBy } }')).toEqual([
      { id: granted.grant.id, open: false, endedBy: 'Sana Iqbal' },
    ]);
    const changes = await data(
      owner.token,
      '{ auditLog(first: 10) { nodes { action actor { kind } details } } }',
    );
    expect(
      changes.nodes
        .filter((entry: Json) => entry.action.startsWith('support.access'))
        .map((entry: Json) => [entry.action, entry.actor.kind]),
    ).toEqual([
      ['support.access_ended', 'STAFF'],
      ['support.access_granted', 'STAFF'],
    ]);
  });
});
