import 'reflect-metadata';
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import { SupportService } from '@hatti/billing/public';
import { Database } from '@hatti/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();
const PASSWORD = 'correct horse battery staple';

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SUPPORT = `query Support {
  hattiSupport {
    plan channel answerWithinHours whatsapp phone email hours { en ur }
    requests {
      id channel topic message callBack status answer answeredBy
      messages { id direction body mediaKind at status error }
    }
  }
}`;
const ASK = `mutation Ask($input: SupportRequestInput!) {
  supportRequestCreate(input: $input) {
    request { id topic message callBack status } userErrors { field code message }
  }
}`;
const CLOSE = `mutation Close($id: ID!) {
  supportRequestClose(id: $id) { request { id status } userErrors { field code } }
}`;

const CONTACT = {
  whatsapp: '+923001112233',
  phone: '+924235761999',
  email: 'help@hatti.pk',
  hours: { en: 'Monday to Saturday, 10am to 7pm', ur: 'پیر سے ہفتہ، صبح 10 سے شام 7' },
};

const WHATSAPP = { appSecret: 'whatsapp-app-secret-1234', verifyToken: 'verify-token-5678' };
const SUPPORT_LINE = '300000000000003';

describe.skipIf(!server)("Admin GraphQL API: Hatti's support for shops (BIL-05, ADR-508)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  const shop = newId();
  let packer = '';
  let packerId = '';
  let app = '';

  /** A change of the messages field, posted to WhatsApp's webhook as Meta signs it. */
  async function posted(value: object) {
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value }] }],
    });
    const response = await api.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', WHATSAPP.appSecret).update(raw).digest('hex')}`,
      },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
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
    const body = response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    api = await startTestApi(testDb, {
      support: CONTACT,
      whatsapp: WHATSAPP,
      supportLine: { phoneNumberId: SUPPORT_LINE },
    });
    const signedUp = await api.app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      payload: {
        email: `support-${randomBytes(4).toString('hex')}@example.pk`,
        password: PASSWORD,
        name: 'Omar',
      },
    });
    const body = signedUp.json() as { accessToken: string; user: { id: string } };
    packer = body.accessToken;
    packerId = fromPublicId(body.user.id, 'user');
    await admin.query(
      `INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, 'packer')`,
      [packerId, shop],
    );
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, '{}')`,
      [shop, hash, hint],
    );
    app = token;
  });

  afterAll(async () => {
    await admin?.end();
    await api?.close();
    await testDb?.drop();
  });

  it("shows any member of staff how to reach Hatti's people, as the shop's plan allows", async () => {
    expect(await gql(packer, SUPPORT)).toEqual({
      plan: 'FREE',
      channel: 'HELP_CENTRE',
      answerWithinHours: 48,
      whatsapp: null,
      phone: null,
      email: 'help@hatti.pk',
      hours: CONTACT.hours,
      requests: [],
    });
    await admin.query(
      `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
       VALUES ($1, 'pro', 'yearly', now(), now() + interval '1 year')`,
      [shop],
    );
    expect(await gql(packer, SUPPORT)).toMatchObject({
      plan: 'PRO',
      channel: 'PRIORITY_CALL',
      answerWithinHours: 4,
      whatsapp: '+923001112233',
      phone: '+924235761999',
    });
  });

  it("keeps a request for Hatti's people, answered from their own tool, shown to the shop", async () => {
    const asked = await gql(packer, ASK, {
      input: {
        topic: 'COURIERS',
        message: 'PostEx bookings fail for Multan.',
        language: 'ENGLISH',
        callBack: '0300 1234567',
      },
    });
    expect(asked).toMatchObject({
      request: { topic: 'COURIERS', callBack: '+923001234567', status: 'OPEN' },
      userErrors: [],
    });
    expect(asked.request.id).toMatch(/^sreq_/);
    expect(
      await gql(packer, ASK, { input: { topic: 'OTHER', message: 'help', language: 'URDU' } }),
    ).toMatchObject({ request: null, userErrors: [{ field: ['input', 'message'] }] });
    expect(
      await gql(app, ASK, {
        input: { topic: 'OTHER', message: 'An app asks for help.', language: 'ENGLISH' },
      }),
    ).toMatchObject({ request: null, userErrors: [{ field: ['input'], code: 'INVALID' }] });

    // Hatti's people answer it, with the system login, as the CLI does.
    const database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'support-requests',
    });
    try {
      const support = new SupportService(database);
      const waiting = await support.waiting();
      expect(waiting.map((each) => [each.shopName, each.priority])).toEqual([['Zari', 1]]);
      expect(waiting[0]).toMatchObject({ shopId: shop });
      const answered = await support.answer(waiting[0]!.id, 'PostEx fixed Multan.', 'Ayesha');
      expect(answered.ok).toBe(true);
    } finally {
      await database.close();
    }
    expect((await gql(packer, SUPPORT)).requests).toEqual([
      {
        id: asked.request.id,
        channel: 'ADMIN',
        topic: 'COURIERS',
        message: 'PostEx bookings fail for Multan.',
        callBack: '+923001234567',
        status: 'ANSWERED',
        answer: 'PostEx fixed Multan.',
        answeredBy: 'Ayesha',
        messages: [],
      },
    ]);

    expect(await gql(packer, CLOSE, { id: asked.request.id })).toEqual({
      request: { id: asked.request.id, status: 'CLOSED' },
      userErrors: [],
    });
    expect(await gql(packer, CLOSE, { id: asked.request.id })).toEqual({
      request: null,
      userErrors: [{ field: ['id'], code: 'NOT_FOUND' }],
    });
    expect(await gql(packer, CLOSE, { id: 'sreq_nonsense' })).toMatchObject({ request: null });
  });

  it("keeps what staff write to Hatti's support WhatsApp as the shop's request, and the answer sent back (ADR-560)", async () => {
    const phone = `+92345${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
    await admin.query(
      'UPDATE identity.users SET phone_e164 = $2, phone_verified_at = now() WHERE id = $1',
      [packerId, phone],
    );
    const now = Math.floor(Date.now() / 1000);
    const message = {
      from: phone.slice(1),
      id: 'wamid.support1',
      timestamp: String(now - 2),
      type: 'text',
      text: { body: 'آرڈر بک نہیں ہو رہے' },
    };
    const toSupport = {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '923001112233', phone_number_id: SUPPORT_LINE },
    };
    // Meta may deliver it twice: kept once.
    await posted({ ...toSupport, messages: [message] });
    await posted({ ...toSupport, messages: [message] });
    await posted({
      ...toSupport,
      messages: [
        { from: phone.slice(1), id: 'wamid.support2', timestamp: String(now - 1), type: 'image' },
      ],
    });
    // The shop's inbox keeps none of it.
    const { rows: inbox } = await admin.query(
      'SELECT count(*)::int AS count FROM messaging.conversations WHERE shop_id = $1',
      [shop],
    );
    expect(inbox[0].count).toBe(0);

    // Hatti's people answer it, and it goes back on WhatsApp.
    const database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'support-requests',
    });
    try {
      const sent: string[] = [];
      const support = new SupportService(database, null, {
        send: async (to, text) => {
          sent.push(`${to}: ${text}`);
          return { ok: true, id: 'wamid.answer1' };
        },
      });
      const [waiting] = await support.waiting();
      expect(waiting).toMatchObject({ channel: 'whatsapp', language: 'ur', priority: 1 });
      const answered = await support.answer(waiting!.id, 'PostEx نے ٹھیک کر دیا', 'Ayesha');
      expect(answered).toMatchObject({ ok: true, value: { whatsapp: { kind: 'sent' } } });
      expect(sent).toEqual([`${phone}: PostEx نے ٹھیک کر دیا`]);
    } finally {
      await database.close();
    }
    // WhatsApp says it was delivered.
    await posted({
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: SUPPORT_LINE },
      statuses: [
        {
          id: 'wamid.answer1',
          status: 'delivered',
          timestamp: String(now),
          recipient_id: phone.slice(1),
        },
      ],
    });

    const [request] = (await gql(packer, SUPPORT)).requests;
    expect(request).toMatchObject({
      channel: 'WHATSAPP',
      topic: 'OTHER',
      message: 'آرڈر بک نہیں ہو رہے',
      callBack: null,
      status: 'ANSWERED',
      answer: 'PostEx نے ٹھیک کر دیا',
    });
    expect(
      request.messages.map((each: Json) => [
        each.direction,
        each.body,
        each.mediaKind,
        each.status,
      ]),
    ).toEqual([
      ['INBOUND', 'آرڈر بک نہیں ہو رہے', null, null],
      ['INBOUND', null, 'image', null],
      ['OUTBOUND', 'PostEx نے ٹھیک کر دیا', null, 'DELIVERED'],
    ]);
    expect(request.messages[0].id).toMatch(/^smsg_/);
  });
});
