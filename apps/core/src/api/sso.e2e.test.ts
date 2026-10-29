import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { StaffRole } from '@hatti/api';
import { base32Decode, totp } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDns, startTestApi, type TestApi } from '../testing/api.js';
import { fakeOidcProvider } from '../testing/oidc-provider.js';
import { MessagesService } from '@hatti/messaging/public';
import { SsoDomainChecks, ssoDomainMissingNotice } from '../worker/sso-domain-checks.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const PASSWORD = 'correct horse battery staple';
const CLIENT = { id: 'hatti-zari', secret: 'organisation-secret-0042' };

const fakeProvider = () => fakeOidcProvider(CLIENT);

describe.skipIf(!server)('Single sign-on for staff (ADM-09, ADR-864)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let provider: Awaited<ReturnType<typeof fakeProvider>>;
  const shop = newId();
  const otherShop = newId();
  const dns = new TestDns();
  /** Zari's owner, signed in with their password. */
  let owner: string;

  const post = (url: string, payload: object, token?: string) =>
    api.app.inject({
      method: 'POST',
      url,
      payload,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  async function account(
    email: string,
    role: StaffRole,
    twoStep = true,
    shopId = shop,
  ): Promise<string> {
    const body = (
      await post('/auth/sign-up', { email, password: PASSWORD, name: 'Sana Iqbal' })
    ).json() as {
      accessToken: string;
      user: { id: string };
    };
    await admin.query(
      'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
      [fromPublicId(body.user.id, 'user'), shopId, role],
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
    api = await startTestApi(testDb, { dns });
  });

  afterAll(async () => {
    await api?.close();
    await new Promise((resolve) => provider?.http.close(resolve));
    await admin?.end();
    await testDb?.drop();
  });

  it("signs the shop's staff in through its provider, and admits them alone where it requires it", async () => {
    owner = await account('owner@zari.pk', 'owner');
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

  it("proves a domain the shop's through DNS, which then takes its sign-ins alone (ADR-919)", async () => {
    const zari = owner;
    const rang = await account('rang@rang.pk', 'owner', true, otherShop);
    const SAVE = `mutation ($input: ShopSsoInput!) {
      shopSsoUpdate(input: $input) {
        sso { emailDomains domains { domain recordName provedAt } proofRecord }
        userErrors { field code message } } }`;
    const CHECK = `mutation { shopSsoDomainsCheck {
      sso { domains { domain recordName provedAt } proofRecord } userErrors { code message } } }`;
    const input = (clientId: string, emailDomains: string[]) => ({
      issuer: provider.issuer,
      clientId,
      clientSecret: CLIENT.secret,
      emailDomains,
      required: false,
      providerMfa: true,
    });
    /** The client a sign-in by `email` is sent to the provider as. */
    const routedTo = async (email: string) => {
      const started = (await post('/auth/sso/start', { email })).json() as { url: string };
      return new URL(started.url).searchParams.get('client_id');
    };

    // No SSO yet: nothing to check.
    expect((await gql(zari, CHECK)).data.shopSsoDomainsCheck).toEqual({
      sso: null,
      userErrors: [{ code: 'NOT_FOUND', message: 'Set up single sign-on first' }],
    });

    const saved = (await gql(zari, SAVE, { input: input(CLIENT.id, ['zari.pk']) })).data
      .shopSsoUpdate.sso;
    expect(saved.domains).toEqual([
      { domain: 'zari.pk', recordName: '_hatti-sso.zari.pk', provedAt: null },
    ]);
    expect(saved.proofRecord).toMatch(/^hatti-sso=[0-9a-f]{32}$/);
    // Rang names the same domain later: unproved, a sign-in by email goes to the shop that named
    // it last.
    const rangSaved = (await gql(rang, SAVE, { input: input('rang', ['zari.pk']) }, otherShop)).data
      .shopSsoUpdate.sso;
    expect(rangSaved.proofRecord).not.toBe(saved.proofRecord);
    expect(await routedTo('sadia@zari.pk')).toBe('rang');

    // DNS without the record, or with another shop's, proves nothing.
    dns.records.set('_hatti-sso.zari.pk', { texts: ['v=spf1 -all', rangSaved.proofRecord] });
    expect((await gql(zari, CHECK)).data.shopSsoDomainsCheck.sso.domains[0].provedAt).toBeNull();
    // With Zari's, the domain is proved Zari's, and its sign-ins go there alone.
    dns.records.set('_hatti-sso.zari.pk', { texts: ['v=spf1 -all', saved.proofRecord] });
    const proved = (await gql(zari, CHECK)).data.shopSsoDomainsCheck.sso;
    expect(proved.domains[0].provedAt).toEqual(expect.any(String));
    expect(await routedTo('sadia@zari.pk')).toBe(CLIENT.id);
    // Rang's record is not there, and the domain is Zari's now: Rang cannot prove it, nor name it.
    dns.records.set('_hatti-sso.zari.pk', { texts: [rangSaved.proofRecord] });
    expect(
      (await gql(rang, CHECK, undefined, otherShop)).data.shopSsoDomainsCheck.sso.domains[0]
        .provedAt,
    ).toBeNull();
    expect(
      (await gql(rang, SAVE, { input: input('rang', ['zari.pk', 'rang.pk']) }, otherShop)).data
        .shopSsoUpdate.userErrors,
    ).toEqual([
      {
        field: ['input', 'emailDomains'],
        code: 'TAKEN',
        message: "zari.pk is proved another shop's, through DNS",
      },
    ]);
    expect(await routedTo('sadia@zari.pk')).toBe(CLIENT.id);

    // A domain Zari no longer names is no longer proved its: Rang's sign-ins by it again.
    const dropped = (await gql(zari, SAVE, { input: input(CLIENT.id, ['zari.com.pk']) })).data
      .shopSsoUpdate.sso;
    expect(dropped.domains).toEqual([
      { domain: 'zari.com.pk', recordName: '_hatti-sso.zari.com.pk', provedAt: null },
    ]);
    expect(await routedTo('sadia@zari.pk')).toBe('rang');
    const { rows } = await admin.query(
      `SELECT details FROM platform.audit_log WHERE action = 'sso.domains_proved'`,
    );
    expect(rows).toEqual([{ details: { domains: ['zari.pk'] } }]);
  });

  it('looks a proved domain up again each day, and unproves it three days after its record goes (ADR-934)', async () => {
    const zari = owner;
    const SSO = '{ shopSso { proofRecord domains { domain provedAt missingSince } } }';
    const CHECK = 'mutation { shopSsoDomainsCheck { sso { domains { domain provedAt } } } }';
    const { proofRecord } = (await gql(zari, SSO)).data.shopSso;
    dns.records.set('_hatti-sso.zari.com.pk', { texts: [proofRecord] });
    expect((await gql(zari, CHECK)).data.shopSsoDomainsCheck.sso.domains[0].provedAt).toEqual(
      expect.any(String),
    );
    const database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'sso-domain-checks-test',
    });
    try {
      // Its shop told the first time its record is gone (ADR-938), at its alerts number.
      await admin.query(
        `INSERT INTO messaging.settings (shop_id, alerts_phone) VALUES ($1, '+923335550031')
         ON CONFLICT (shop_id) DO UPDATE SET alerts_phone = excluded.alerts_phone`,
        [shop],
      );
      const checks = new SsoDomainChecks(
        database.app,
        (host) => dns.texts(host),
        undefined,
        ssoDomainMissingNotice(database, new MessagesService(database)),
      );
      const told = async () =>
        (
          await admin.query<{ channel: string; variables: Record<string, string> }>(
            `SELECT channel, variables FROM messaging.messages
              WHERE kind = 'sso_domain_missing' ORDER BY created_at, id`,
          )
        ).rows;
      const day = 86_400_000;
      const at = Date.now() + 2 * day;
      const swept = (offset: number, by = checks) => by.sweep(new Date(at + offset));
      // Not due within the day of its proof.
      expect(await checks.sweep(new Date())).toEqual({
        proved: 0,
        missing: 0,
        unproved: 0,
        unanswered: 0,
      });
      expect((await swept(0)).proved).toBe(1);
      // Its record gone: missing, said so, still proved.
      dns.records.delete('_hatti-sso.zari.com.pk');
      expect((await swept(day + 1_000)).missing).toBe(1);
      const missing = (await gql(zari, SSO)).data.shopSso.domains[0];
      expect([missing.provedAt === null, missing.missingSince]).toEqual([
        false,
        new Date(at + day + 1_000).toISOString(),
      ]);
      // On WhatsApp, the day it stops being proved Zari's in Zari's time.
      expect(await told()).toEqual([
        {
          channel: 'whatsapp',
          variables: { shop: 'Zari', domain: 'zari.com.pk', date: expect.any(String) },
        },
      ]);
      // DNS failing changes nothing.
      const failing = new SsoDomainChecks(database.app, async () => {
        throw new Error('SERVFAIL');
      });
      expect((await swept(2 * day + 2_000, failing)).unanswered).toBe(1);
      // Still missing, it is not told again.
      expect(await told()).toHaveLength(1);
      // Three days missing: no longer proved Zari's.
      expect((await swept(4 * day + 3_000)).unproved).toBe(1);
      expect((await gql(zari, SSO)).data.shopSso.domains).toEqual([
        { domain: 'zari.com.pk', provedAt: null, missingSince: null },
      ]);
      // Put back, the owner proves it again as at first; the sweep asks nothing of it till then.
      dns.records.set('_hatti-sso.zari.com.pk', { texts: [proofRecord] });
      expect((await swept(6 * day)).proved).toBe(0);
    } finally {
      await database.close();
    }
  });
});
