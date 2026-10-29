import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { StaffRole } from '@hatti/api';
import { WebhookService } from '@hatti/apps/public';
import { base32Decode, totp } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { PartnerEarnings } from '../worker/partner-earnings.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();
const PASSWORD = 'correct horse battery staple';
const REDIRECT = 'https://reviews.example.pk/callback';

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const CREATE = `mutation ($name: String!, $price: MoneyInput!, $returnUrl: String!) {
  appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl) {
    appPurchaseOneTime { id name status test price { amount } }
    confirmationUrl
    userErrors { field message } } }`;
const APPROVE = `mutation ($id: ID!) {
  appPurchaseOneTimeApprove(id: $id) {
    appPurchaseOneTime { status } invoiceId userErrors { message } } }`;
const STATUS = 'query ($id: ID!) { appPurchaseOneTime(id: $id) { status } }';

describe.skipIf(!server)("Apps' one-time charges in rupees (DEV-05)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let database: Database;
  const lab = newId();
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
      email: `charges-${randomBytes(4).toString('hex')}@example.pk`,
      password: PASSWORD,
      name: 'Sara Ali',
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
    await post(
      '/auth/two-step/totp/confirm',
      { code: totp(base32Decode(secret), Date.now()) },
      body.accessToken,
    );
    return { token: body.accessToken, userId };
  }

  async function gql(token: string, shop: string, query: string, variables?: object) {
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

  async function data(token: string, shop: string, query: string, variables?: object) {
    const body = await gql(token, shop, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  /** The app installed on `shop` by its owner: the app's token there. */
  async function install(
    app: { clientId: string; clientSecret: string },
    owner: { token: string },
    shop: string,
  ): Promise<string> {
    const approved = await post(
      '/auth/oauth/authorize',
      {
        clientId: app.clientId,
        redirectUri: REDIRECT,
        scope: 'read_products',
        shopId: toPublicId('shop', shop),
      },
      owner.token,
    );
    const code = new URL((approved.json() as Json).redirectUrl).searchParams.get('code')!;
    const traded = await post('/admin/oauth/access_token', {
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
    });
    return (traded.json() as Json).access_token as string;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle, development)
       VALUES ($1, 'Reviews lab', 'reviews-lab', true), ($2, 'Zari', 'zari', false)`,
      [lab, zari],
    );
    // On Growth, which includes custom apps (ADR-523).
    await admin.query(
      `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
       VALUES ($1, 'growth', 'monthly', now(), now() + interval '1 month')`,
      [zari],
    );
    api = await startTestApi(testDb);
    database = new Database({ appUrl: testDb.appUrl, applicationName: 'app-charges-test' });
  });

  afterAll(async () => {
    await database?.close();
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('charges a shop once, approved by its owner and paid through Hatti, earning the partner 80%', async () => {
    const partner = await account('owner', lab);
    await admin.query(
      `INSERT INTO identity.partners (user_id, business_name, referral_code)
       VALUES ($1, 'Bazaar Labs', 'bazaar09')`,
      [partner.userId],
    );
    await admin.query(
      `INSERT INTO identity.partner_stores (shop_id, partner_id, kind) VALUES ($1, $2, 'development')`,
      [lab, partner.userId],
    );
    const registered = (
      await post(
        '/auth/partner/apps',
        {
          name: 'Reviews Pro',
          appUrl: 'https://reviews.example.pk',
          redirectUrls: [REDIRECT],
          scopes: ['read_products'],
        },
        partner.token,
      )
    ).json() as Json;
    const app = { clientId: registered.app.clientId, clientSecret: registered.clientSecret };

    // On the partner's development store, a test: paid once approved, no money moving.
    const labToken = await install(app, partner, lab);
    const tried = await data(labToken, lab, CREATE, {
      name: 'Photo reviews, for good',
      price: { amount: '2500', currencyCode: 'PKR' },
      returnUrl: 'https://reviews.example.pk/charged',
    });
    expect(tried.appPurchaseOneTime).toMatchObject({ test: true, status: 'PENDING' });
    expect(await data(partner.token, lab, APPROVE, { id: tried.appPurchaseOneTime.id })).toEqual({
      appPurchaseOneTime: { status: 'PAID' },
      invoiceId: null,
      userErrors: [],
    });

    // Listed, it charges a merchant's shop for real.
    await admin.query('UPDATE identity.partner_apps SET listed_at = now()');
    const owner = await account('owner', zari);
    const appToken = await install(app, owner, zari);
    expect(
      (
        await data(appToken, zari, CREATE, {
          name: 'Photo reviews',
          price: { amount: '20', currencyCode: 'PKR' },
          returnUrl: 'http://reviews.example.pk/charged',
        })
      ).userErrors,
    ).toEqual([
      { field: ['price'], message: 'A charge is Rs 50 to Rs 500,000, in whole rupees' },
      { field: ['returnUrl'], message: 'Give an https address of 500 characters at most' },
    ]);
    const asked = await data(appToken, zari, CREATE, {
      name: 'Photo reviews, for good',
      price: { amount: '2500', currencyCode: 'PKR' },
      returnUrl: 'https://reviews.example.pk/charged',
    });
    const charge = asked.appPurchaseOneTime;
    expect(charge).toMatchObject({ test: false, status: 'PENDING', price: { amount: '2500.00' } });
    expect(asked.confirmationUrl).toMatch(
      new RegExp(`/${toPublicId('shop', zari)}/settings/apps/charges/${charge.id}$`),
    );

    // The app approves nothing itself; a manager neither.
    expect(
      (await gql(appToken, zari, APPROVE, { id: charge.id })).errors?.[0].extensions.code,
    ).toBe('ACCESS_DENIED');
    const manager = await account('manager', zari);
    expect(
      (await gql(manager.token, zari, APPROVE, { id: charge.id })).errors?.[0].extensions.code,
    ).toBe('ACCESS_DENIED');

    // The owner approves it: an invoice of Hatti's, paid through its gateway.
    const approved = await data(owner.token, zari, APPROVE, { id: charge.id });
    expect(approved.appPurchaseOneTime).toEqual({ status: 'ACCEPTED' });
    const invoices = await data(
      owner.token,
      zari,
      '{ billingInvoices { reason chargeName status } }',
    );
    expect(invoices).toEqual([
      { reason: 'APP', chargeName: 'Photo reviews, for good', status: 'OPEN' },
    ]);
    const pay = await data(
      owner.token,
      zari,
      'mutation ($id: ID!) { billingInvoicePay(id: $id) { checkoutUrl } }',
      { id: approved.invoiceId },
    );
    const checkout = new URL(pay.checkoutUrl);
    await api.app.inject({ method: 'GET', url: `${checkout.pathname}${checkout.search}` });

    // As the worker hears it is paid: the charge is paid, and its partner earns their share.
    const { rows } = await admin.query<{
      id: string;
      shop_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `SELECT id, shop_id, aggregate_type, aggregate_id, event_type, payload, occurred_at
         FROM platform.outbox_events WHERE event_type = 'billing_invoice.paid' AND shop_id = $1`,
      [zari],
    );
    const paid = rows[0]!;
    await new PartnerEarnings(database).handle({
      id: paid.id,
      type: paid.event_type,
      shopId: paid.shop_id,
      aggregateType: paid.aggregate_type,
      aggregateId: paid.aggregate_id,
      payload: paid.payload,
      occurredAt: new Date(paid.occurred_at).toISOString(),
    } as DomainEvent);
    expect(await data(appToken, zari, STATUS, { id: charge.id })).toEqual({ status: 'PAID' });

    // The app, subscribed to its charges, is told it was paid; no other app is (ADR-914).
    const subscribed = await data(
      appToken,
      zari,
      `mutation { webhookSubscriptionCreate(topic: APP_PURCHASES_ONE_TIME_UPDATE,
         webhookSubscription: { callbackUrl: "https://reviews.example.pk/hooks" }) {
         webhookSubscription { topic } userErrors { message } } }`,
    );
    expect(subscribed).toEqual({
      webhookSubscription: { topic: 'APP_PURCHASES_ONE_TIME_UPDATE' },
      userErrors: [],
    });
    const { rows: updates } = await admin.query<{
      id: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `SELECT id, aggregate_id, payload, occurred_at FROM platform.outbox_events
        WHERE event_type = 'app_charge.updated' AND shop_id = $1`,
      [zari],
    );
    expect(updates.map((each) => each.payload)).toEqual([
      { status: 'paid', appId: expect.any(String) },
    ]);
    const webhooks = api.app.get(WebhookService, { strict: false });
    for (const update of updates) {
      await webhooks.fanOut({
        id: update.id,
        type: 'app_charge.updated',
        shopId: zari,
        aggregateType: 'app_charge',
        aggregateId: update.aggregate_id,
        payload: update.payload,
        occurredAt: new Date(update.occurred_at).toISOString(),
      } as DomainEvent);
    }
    const { rows: told } = await admin.query<{ topic: string; body: { data: unknown } }>(
      `SELECT topic, body FROM apps.webhook_deliveries WHERE shop_id = $1`,
      [zari],
    );
    expect(told).toEqual([
      {
        topic: 'app_purchases_one_time/update',
        body: expect.objectContaining({ data: { id: charge.id, status: 'PAID' } }),
      },
    ]);
    const { rows: earned } = await admin.query(
      `SELECT partner_id, plan, invoice_amount::text, amount::text FROM identity.partner_earnings`,
    );
    expect(earned).toEqual([
      { partner_id: partner.userId, plan: 'app', invoice_amount: '250000', amount: '200000' },
    ]);

    // Answered, it is not answered again; and another app does not see it.
    expect((await data(owner.token, zari, APPROVE, { id: charge.id })).userErrors).toEqual([
      { message: 'The charge was answered already' },
    ]);
    const custom = await data(
      owner.token,
      zari,
      'mutation { customAppCreate(input: { name: "Sheet", scopes: ["read_products"] }) { accessToken } }',
    );
    expect(await data(custom.accessToken, zari, STATUS, { id: charge.id })).toBeNull();
    expect(
      (
        await data(custom.accessToken, zari, CREATE, {
          name: 'Nope',
          price: { amount: '100', currencyCode: 'PKR' },
          returnUrl: 'https://sheet.example.pk',
        })
      ).userErrors,
    ).toEqual([{ field: [], message: "Custom apps don't charge the shop: public apps do" }]);
  });
});
