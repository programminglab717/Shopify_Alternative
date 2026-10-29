import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { StaffRole } from '@hatti/api';
import { base32Decode, totp } from '@hatti/crypto';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { verifySessionToken } from '@hatti/admin-client';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();
const PASSWORD = 'correct horse battery staple';
const REDIRECT = 'https://reviews.example.pk/auth/callback';

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe.skipIf(!server)('Public apps installed through OAuth (DEV-05)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  // The partner's development store, and a shop of a merchant's.
  const devStore = newId();
  const merchantShop = newId();
  const embedStore = newId();

  const send = (method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) =>
    api.app.inject({
      method,
      url,
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  /** An account in `shops` in `role`, signed in with a second factor. */
  async function account(
    role: StaffRole,
    shops: readonly string[],
  ): Promise<{ token: string; userId: string }> {
    const email = `oauth-${randomBytes(4).toString('hex')}@example.pk`;
    const signedUp = await send('POST', '/auth/sign-up', {
      email,
      password: PASSWORD,
      name: 'Hina Malik',
    });
    expect(signedUp.statusCode).toBe(201);
    const body = signedUp.json() as { accessToken: string; user: { id: string } };
    const userId = fromPublicId(body.user.id, 'user');
    for (const shop of shops) {
      await admin.query(
        'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
        [userId, shop, role],
      );
    }
    const setup = await send('POST', '/auth/two-step/totp/setup', {}, body.accessToken);
    const { secret } = setup.json() as { secret: string };
    const code = totp(base32Decode(secret), Date.now());
    expect(
      (await send('POST', '/auth/two-step/totp/confirm', { code }, body.accessToken)).statusCode,
    ).toBe(200);
    return { token: body.accessToken, userId };
  }

  async function gql(
    token: string,
    shop: string,
    query: string,
    variables?: Record<string, unknown>,
  ) {
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

  const consentUrl = (clientId: string, scope: string, redirect = REDIRECT) =>
    `/auth/oauth/app?${new URLSearchParams({ client_id: clientId, redirect_uri: redirect, scope })}`;

  const tokenFor = (clientId: string, clientSecret: string, code: string) =>
    send('POST', '/admin/oauth/access_token', {
      client_id: clientId,
      client_secret: clientSecret,
      code,
    });

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle, development)
       VALUES ($1, 'Partner sandbox', 'sandbox', true), ($2, 'Zari', 'zari', false),
              ($3, 'Widget lab', 'widget-lab', true)`,
      [devStore, merchantShop, embedStore],
    );
    api = await startTestApi(testDb);
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('is registered by a partner, approved by an owner, and traded for a token once', async () => {
    const partner = await account('owner', [devStore, merchantShop]);
    await admin.query(
      `INSERT INTO identity.partners (user_id, business_name, referral_code)
       VALUES ($1, 'Bazaar Labs', 'bazaar01')`,
      [partner.userId],
    );
    await admin.query(
      `INSERT INTO identity.partner_stores (shop_id, partner_id, kind)
       VALUES ($1, $2, 'development')`,
      [devStore, partner.userId],
    );

    const registered = await send(
      'POST',
      '/auth/partner/apps',
      {
        name: 'Reviews Pro',
        appUrl: 'https://reviews.example.pk',
        redirectUrls: [REDIRECT],
        scopes: ['write_orders', 'read_products'],
      },
      partner.token,
    );
    expect(registered.statusCode).toBe(201);
    const { app, clientSecret } = registered.json() as Json;
    expect(app).toMatchObject({
      name: 'Reviews Pro',
      scopes: ['read_products', 'write_orders'],
      listed: false,
    });
    expect(app.clientId).toMatch(/^hca_[0-9a-f]{32}$/);
    expect(clientSecret).toMatch(/^hcs_/);

    // The consent page: what it asks, by whom; never to an address it did not register.
    const consent = await send(
      'GET',
      consentUrl(app.clientId, 'read_products'),
      undefined,
      partner.token,
    );
    expect(consent.statusCode).toBe(200);
    expect(consent.json()).toEqual({
      app: {
        name: 'Reviews Pro',
        appUrl: 'https://reviews.example.pk',
        partner: 'Bazaar Labs',
        scopes: ['read_products'],
        listed: false,
      },
    });
    expect(
      (
        await send(
          'GET',
          consentUrl(app.clientId, 'read_products', 'https://evil.example.pk/cb'),
          undefined,
          partner.token,
        )
      ).statusCode,
    ).toBe(422);
    expect(
      (await send('GET', consentUrl(app.clientId, 'write_products'), undefined, partner.token))
        .statusCode,
    ).toBe(422);
    expect((await send('GET', consentUrl(app.clientId, 'read_products'))).statusCode).toBe(401);

    const approve = (shop: string, token = partner.token) =>
      send(
        'POST',
        '/auth/oauth/authorize',
        {
          clientId: app.clientId,
          redirectUri: REDIRECT,
          scope: 'read_products',
          state: 'n0nce',
          shopId: toPublicId('shop', shop),
        },
        token,
      );

    // Not listed yet, it installs on its partner's development store alone.
    const elsewhere = await approve(merchantShop);
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json()).toMatchObject({ error: { code: 'NOT_LISTED' } });

    const approved = await approve(devStore);
    expect(approved.statusCode).toBe(200);
    const back = new URL((approved.json() as { redirectUrl: string }).redirectUrl);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('n0nce');
    expect(back.searchParams.get('shop')).toBe(toPublicId('shop', devStore));
    const code = back.searchParams.get('code')!;

    // The secret is checked; the code is traded once.
    const wrong = await tokenFor(app.clientId, 'hcs_wrong', code);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: 'invalid_grant' });
    // Form-encoded, as OAuth libraries send it, or as JSON.
    const traded = await api.app.inject({
      method: 'POST',
      url: '/admin/oauth/access_token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        client_id: app.clientId,
        client_secret: clientSecret,
        code,
      }).toString(),
    });
    expect(traded.statusCode).toBe(200);
    const { access_token: accessToken, scope } = traded.json() as Json;
    expect(scope).toBe('read_products');
    expect((await tokenFor(app.clientId, clientSecret, code)).statusCode).toBe(400);
    expect((await send('POST', '/admin/oauth/access_token', { code })).statusCode).toBe(400);

    // The token reads what was approved, and nothing else.
    expect(
      (await gql(accessToken, devStore, '{ products(first: 1) { nodes { id } } }')).errors,
    ).toBeUndefined();
    const denied = await gql(accessToken, devStore, '{ orders(first: 1) { nodes { id } } }');
    expect(denied.errors?.[0].extensions.code).toBe('ACCESS_DENIED');

    // The shop sees it among its apps, not among its custom apps.
    const installed = await gql(
      partner.token,
      devStore,
      '{ installedApps { id appId name scopes } }',
    );
    expect(installed.data?.installedApps).toEqual([
      expect.objectContaining({ appId: app.id, name: 'Reviews Pro', scopes: ['read_products'] }),
    ]);
    expect((await gql(partner.token, devStore, '{ customApps { id } }')).data?.customApps).toEqual(
      [],
    );

    // Installed again, its earlier token stops working.
    const again = new URL(
      ((await approve(devStore)).json() as { redirectUrl: string }).redirectUrl,
    );
    const second = (
      await tokenFor(app.clientId, clientSecret, again.searchParams.get('code')!)
    ).json() as Json;
    expect((await gql(accessToken, devStore, '{ shop { name } }')).status).toBe(401);
    expect((await gql(second.access_token, devStore, '{ shop { name } }')).status).toBe(200);

    // Uninstalled, neither does its new one.
    const [current] = (await gql(partner.token, devStore, '{ installedApps { id } }')).data
      ?.installedApps as { id: string }[];
    const removed = await gql(
      partner.token,
      devStore,
      'mutation ($id: ID!) { appUninstall(id: $id) { uninstalledAppId userErrors { message } } }',
      { id: current!.id },
    );
    expect(removed.data?.appUninstall).toEqual({ uninstalledAppId: current!.id, userErrors: [] });
    expect((await gql(second.access_token, devStore, '{ shop { name } }')).status).toBe(401);
  });

  it('is approved by owners and managers alone, within what their role gives', async () => {
    const partner = await account('owner', []);
    await admin.query(
      `INSERT INTO identity.partners (user_id, business_name, referral_code)
       VALUES ($1, 'Rang Studio', 'rang0002')`,
      [partner.userId],
    );
    const registered = await send(
      'POST',
      '/auth/partner/apps',
      {
        name: 'Stock sync',
        appUrl: 'https://sync.example.pk',
        redirectUrls: [REDIRECT],
        scopes: ['read_products', 'write_settings'],
      },
      partner.token,
    );
    const { app } = registered.json() as Json;
    // Hatti lists it, so any shop may install it.
    await admin.query('UPDATE identity.partner_apps SET listed_at = now() WHERE client_id = $1', [
      app.clientId,
    ]);
    const approve = (token: string, scope: string) =>
      send(
        'POST',
        '/auth/oauth/authorize',
        {
          clientId: app.clientId,
          redirectUri: REDIRECT,
          scope,
          shopId: toPublicId('shop', merchantShop),
        },
        token,
      );
    const packer = await account('packer', [merchantShop]);
    expect((await approve(packer.token, 'read_products')).statusCode).toBe(403);
    // A manager gives what their role writes, and reads.
    const manager = await account('manager', [merchantShop]);
    expect((await approve(manager.token, 'read_products,write_settings')).statusCode).toBe(200);
    // A manager in a custom role gives what that role reaches alone (ADR-578).
    const narrow = await account('manager', [merchantShop]);
    const roleId = newId();
    await admin.query(
      `INSERT INTO identity.custom_roles (id, shop_id, name, based_on, scopes)
       VALUES ($1, $2, 'Catalogue only', 'manager', '{read_products}')`,
      [roleId, merchantShop],
    );
    await admin.query(
      'UPDATE identity.memberships SET custom_role_id = $1 WHERE user_id = $2 AND shop_id = $3',
      [roleId, narrow.userId, merchantShop],
    );
    const tooMuch = await approve(narrow.token, 'read_products write_settings');
    expect(tooMuch.statusCode).toBe(403);
    expect(tooMuch.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect((await approve(narrow.token, 'read_products')).statusCode).toBe(200);
  });

  it('opens inside the admin with a session token, and offers scripts the shop turns on (DEV-06)', async () => {
    const partner = await account('owner', [embedStore]);
    await admin.query(
      `INSERT INTO identity.partners (user_id, business_name, referral_code)
       VALUES ($1, 'Widget Works', 'widget03')`,
      [partner.userId],
    );
    await admin.query(
      `INSERT INTO identity.partner_stores (shop_id, partner_id, kind)
       VALUES ($1, $2, 'development')`,
      [embedStore, partner.userId],
    );
    const { app, clientSecret } = (
      await send(
        'POST',
        '/auth/partner/apps',
        {
          name: 'Size finder',
          appUrl: 'https://sizes.example.pk/admin',
          redirectUrls: [REDIRECT],
          scopes: ['write_themes'],
        },
        partner.token,
      )
    ).json() as Json;
    const approved = await send(
      'POST',
      '/auth/oauth/authorize',
      {
        clientId: app.clientId,
        redirectUri: REDIRECT,
        scope: 'write_themes',
        shopId: toPublicId('shop', embedStore),
      },
      partner.token,
    );
    const code = new URL((approved.json() as Json).redirectUrl).searchParams.get('code')!;
    const { access_token: appToken } = (
      await tokenFor(app.clientId, clientSecret, code)
    ).json() as Json;
    const [install] = (await gql(partner.token, embedStore, '{ installedApps { id } }')).data
      ?.installedApps as { id: string }[];

    // Opened inside the admin, its frame carries a token the app checks with its secret.
    const opened = await gql(
      partner.token,
      embedStore,
      'query ($id: ID!) { appSession(id: $id) { name url token expiresAt } }',
      { id: install!.id },
    );
    const session = opened.data?.appSession;
    expect(session.name).toBe('Size finder');
    const url = new URL(session.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://sizes.example.pk/admin');
    expect(url.searchParams.get('shop')).toBe(toPublicId('shop', embedStore));
    expect(url.searchParams.get('id_token')).toBe(session.token);
    expect(
      verifySessionToken(session.token, { clientId: app.clientId, clientSecret }),
    ).toMatchObject({
      dest: toPublicId('shop', embedStore),
      sub: toPublicId('user', partner.userId),
    });
    expect(
      verifySessionToken(session.token, { clientId: app.clientId, clientSecret: 'hcs_x' }),
    ).toBeNull();
    // Apps open no sessions, nor see what else the shop installed.
    expect(
      (await gql(appToken, embedStore, `{ appSession(id: "${install!.id}") { url } }`)).errors?.[0]
        .extensions.code,
    ).toBe('ACCESS_DENIED');
    expect(
      (await gql(appToken, embedStore, '{ installedApps { id } }')).errors?.[0].extensions.code,
    ).toBe('ACCESS_DENIED');

    // The app offers a script; the shop turns it on, never the app.
    const SET = `mutation ($input: AppEmbedInput!) {
      appEmbedSet(input: $input) { appEmbed { id appName handle src enabled } userErrors { field code } } }`;
    const refused = await gql(appToken, embedStore, SET, {
      input: { handle: 'Size Finder', name: 'Size finder', src: 'http://sizes.example.pk/w.js' },
    });
    expect(refused.data?.appEmbedSet.userErrors).toEqual([
      { field: ['input', 'handle'], code: 'INVALID' },
    ]);
    const offered = (
      await gql(appToken, embedStore, SET, {
        input: { handle: 'size-finder', name: 'Size finder', src: 'https://sizes.example.pk/w.js' },
      })
    ).data?.appEmbedSet.appEmbed;
    expect(offered).toMatchObject({
      appName: 'Size finder',
      handle: 'size-finder',
      enabled: false,
    });
    const ENABLE = `mutation ($id: ID!) { appEmbedEnable(id: $id, enabled: true) { appEmbed { enabled } userErrors { code } } }`;
    expect(
      (await gql(appToken, embedStore, ENABLE, { id: offered.id })).errors?.[0].extensions.code,
    ).toBe('ACCESS_DENIED');
    expect(
      (await gql(partner.token, embedStore, ENABLE, { id: offered.id })).data?.appEmbedEnable,
    ).toEqual({ appEmbed: { enabled: true }, userErrors: [] });
    expect(
      (await gql(partner.token, embedStore, '{ appEmbeds { handle enabled } }')).data?.appEmbeds,
    ).toEqual([{ handle: 'size-finder', enabled: true }]);

    // Uninstalled, its scripts go with it.
    await gql(
      partner.token,
      embedStore,
      'mutation ($id: ID!) { appUninstall(id: $id) { uninstalledAppId } }',
      { id: install!.id },
    );
    expect((await gql(partner.token, embedStore, '{ appEmbeds { id } }')).data?.appEmbeds).toEqual(
      [],
    );
    expect(
      (
        await gql(partner.token, embedStore, 'query ($id: ID!) { appSession(id: $id) { url } }', {
          id: install!.id,
        })
      ).data?.appSession,
    ).toBeNull();
  });
});
