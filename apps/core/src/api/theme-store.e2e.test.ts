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

const NOT_FOUND = JSON.stringify({
  sections: { main: { type: 'main-404', settings: {} } },
  order: ['main'],
});

describe.skipIf(!server)('The theme store (OS-20)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  const studio = newId();
  const zari = newId();

  const post = (url: string, payload: unknown, token?: string) =>
    api.app.inject({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  async function account(
    role: StaffRole,
    shop: string,
  ): Promise<{ token: string; userId: string }> {
    const signedUp = await post('/auth/sign-up', {
      email: `themes-${randomBytes(4).toString('hex')}@example.pk`,
      password: PASSWORD,
      name: 'Hira Baig',
    });
    const body = signedUp.json() as { accessToken: string; user: { id: string } };
    const userId = fromPublicId(body.user.id, 'user');
    await admin.query(
      'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
      [userId, shop, role],
    );
    const { secret } = (await post('/auth/two-step/totp/setup', {}, body.accessToken)).json() as {
      secret: string;
    };
    const code = totp(base32Decode(secret), Date.now());
    await post('/auth/two-step/totp/confirm', { code }, body.accessToken);
    return { token: body.accessToken, userId };
  }

  async function gql(token: string, shop: string, query: string, variables?: object) {
    const response = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: {
        authorization: `Bearer ${token}`,
        'x-hatti-shop-id': toPublicId('shop', shop),
        'idempotency-key': randomUUID(),
      },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  async function data(token: string, shop: string, query: string, variables?: object) {
    const body = await gql(token, shop, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  const OFFER = `mutation ($themeId: ID!, $input: ThemeStoreOfferInput!) {
    themeStoreOffer(themeId: $themeId, input: $input) {
      listing { id name designer price { amount } free } userErrors { field message } } }`;
  const STORE = '{ themeStore { id name designer free bought price { amount } } }';
  const INSTALL = `mutation ($id: ID!) {
    themeStoreInstall(id: $id) { theme { id name role } userErrors { field message } } }`;

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle, development)
       VALUES ($1, 'Rang lab', 'rang-lab', true), ($2, 'Zari', 'zari', false)`,
      [studio, zari],
    );
    api = await startTestApi(testDb);
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("takes a designer's themes, listed once Hatti looks, and installs or sells them to shops", async () => {
    // A designer, a partner who built a theme on their development store.
    const designer = await account('owner', studio);
    await admin.query(
      `INSERT INTO identity.partners (user_id, business_name, referral_code)
       VALUES ($1, 'Rang Studio', 'rang0001')`,
      [designer.userId],
    );
    await admin.query(
      `INSERT INTO identity.partner_stores (shop_id, partner_id, kind)
       VALUES ($1, $2, 'development')`,
      [studio, designer.userId],
    );
    const made = await data(
      designer.token,
      studio,
      'mutation { themeCreate(name: "Basant") { theme { id } userErrors { message } } }',
    );
    const saved = await data(
      designer.token,
      studio,
      `mutation ($id: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
        themeFilesUpsert(themeId: $id, files: $files) { userErrors { message } } }`,
      { id: made.theme.id, files: [{ filename: 'templates/404.json', body: NOT_FOUND }] },
    );
    expect(saved.userErrors).toEqual([]);

    // Offered for Rs 5,000, and a free one besides.
    const paid = await data(designer.token, studio, OFFER, {
      themeId: made.theme.id,
      input: { name: 'Basant', description: 'For spring lawn', price: '5000' },
    });
    expect(paid).toEqual({
      listing: expect.objectContaining({
        name: 'Basant',
        designer: 'Rang Studio',
        price: { amount: '5000.00' },
        free: false,
      }),
      userErrors: [],
    });
    expect(
      (
        await data(designer.token, studio, OFFER, {
          themeId: made.theme.id,
          input: { name: 'Basant', price: '50' },
        })
      ).userErrors,
    ).toEqual([
      { field: ['input'], message: 'A theme is free, or Rs 1,000 to Rs 100,000 in whole rupees' },
    ]);
    const plain = await data(
      designer.token,
      studio,
      'mutation { themeCreate(name: "Saada") { theme { id } } }',
    );
    const free = await data(designer.token, studio, OFFER, {
      themeId: plain.theme.id,
      input: { name: 'Saada', price: '0' },
    });

    // A shop sees neither until Hatti lists them.
    const owner = await account('owner', zari);
    expect(await data(owner.token, zari, STORE)).toEqual([]);
    // Nor does a merchant offer themes of a shop that isn't a partner's development store.
    const own = await data(
      owner.token,
      zari,
      'mutation { themeCreate(name: "Mine") { theme { id } } }',
    );
    expect(
      (
        await gql(owner.token, zari, OFFER, {
          themeId: own.theme.id,
          input: { name: 'Mine', price: '0' },
        })
      ).errors?.[0].extensions.code,
    ).toBe('ACCESS_DENIED');
    await admin.query('UPDATE identity.partner_themes SET listed_at = now()');
    const store = await data(owner.token, zari, STORE);
    expect(store).toEqual([
      expect.objectContaining({ name: 'Saada', free: true, bought: false }),
      expect.objectContaining({ name: 'Basant', free: false, bought: false }),
    ]);

    // A free theme installs at once, as one of the shop's, not published.
    const installed = await data(owner.token, zari, INSTALL, { id: free.listing.id });
    expect(installed).toEqual({
      theme: expect.objectContaining({ name: 'Saada', role: 'UNPUBLISHED' }),
      userErrors: [],
    });

    // A paid one is bought first, by the owner, through Hatti's gateway.
    expect((await data(owner.token, zari, INSTALL, { id: paid.listing.id })).userErrors).toEqual([
      { field: ['id'], message: 'Buy the theme first: it is paid for once, then yours' },
    ]);
    const bought = await data(
      owner.token,
      zari,
      'mutation ($id: ID!) { themeStoreBuy(id: $id) { invoiceId amount { amount } userErrors { message } } }',
      { id: paid.listing.id },
    );
    expect(bought.amount).toEqual({ amount: '5000.00' });
    const invoices = await data(
      owner.token,
      zari,
      '{ billingInvoices { reason themeName status } }',
    );
    expect(invoices).toEqual([{ reason: 'THEME', themeName: 'Basant', status: 'OPEN' }]);
    const pay = await data(
      owner.token,
      zari,
      'mutation ($id: ID!) { billingInvoicePay(id: $id) { checkoutUrl } }',
      { id: bought.invoiceId },
    );
    const checkout = new URL(pay.checkoutUrl);
    await api.app.inject({ method: 'GET', url: `${checkout.pathname}${checkout.search}` });
    const page = await api.app.inject({
      method: 'GET',
      url: `/billing/invoices/${bought.invoiceId}`,
    });
    expect(page.body).toContain('Install Basant from Online store › Theme store.');

    expect((await data(owner.token, zari, STORE))[1]).toMatchObject({
      name: 'Basant',
      bought: true,
    });
    const basant = await data(owner.token, zari, INSTALL, { id: paid.listing.id });
    expect(basant.theme).toMatchObject({ name: 'Basant', role: 'UNPUBLISHED' });
    const files = await data(
      owner.token,
      zari,
      'query ($id: ID!) { theme(id: $id) { files { filename body } } }',
      { id: basant.theme.id },
    );
    expect(files.files).toEqual([{ filename: 'templates/404.json', body: NOT_FOUND }]);

    // Taken out of the store, it stays the buyer's to install again; and is bought once.
    await admin.query('UPDATE identity.partner_themes SET listed_at = NULL WHERE name = $1', [
      'Basant',
    ]);
    expect((await data(owner.token, zari, INSTALL, { id: paid.listing.id })).userErrors).toEqual(
      [],
    );
    await admin.query('UPDATE identity.partner_themes SET listed_at = now()');
    expect(
      (
        await data(
          owner.token,
          zari,
          'mutation ($id: ID!) { themeStoreBuy(id: $id) { invoiceId userErrors { message } } }',
          { id: paid.listing.id },
        )
      ).userErrors,
    ).toEqual([{ message: 'The shop bought this theme already' }]);

    // Offered anew, it waits for Hatti again; the designer sees theirs on their partner page.
    await data(designer.token, studio, OFFER, {
      themeId: made.theme.id,
      input: { name: 'Basant II', price: '6000' },
    });
    const listed = await api.app.inject({
      method: 'GET',
      url: '/auth/partner/themes',
      headers: { authorization: `Bearer ${designer.token}` },
    });
    expect((listed.json() as Json).themes).toEqual([
      expect.objectContaining({ name: 'Basant II', price: '600000', listed: false }),
      expect.objectContaining({ name: 'Saada', price: '0', listed: true }),
    ]);
  });
});
