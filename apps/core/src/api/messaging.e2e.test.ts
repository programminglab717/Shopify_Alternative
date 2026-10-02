import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const WHATSAPP = { appSecret: 'whatsapp-app-secret-1234', verifyToken: 'verify-token-5678' };
const AYESHA = '+923001234567';

const MESSAGES = `query ($first: Int, $after: String, $status: MessageStatus, $orderId: ID) {
  messages(first: $first, after: $after, status: $status, orderId: $orderId) {
    nodes {
      id kind channel recipient language status attempts orderId error replacesId
      sentAt deliveredAt readAt createdAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const SETTINGS = '{ messagingSettings { routing language disabledNotifications updatedAt } }';

const UPDATE = `mutation ($input: MessagingSettingsInput!) {
  messagingSettingsUpdate(input: $input) {
    messagingSettings { routing language disabledNotifications }
    userErrors { field code message }
  }
}`;

describe.skipIf(!server)("WhatsApp's webhook and the shop's messages", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const other = newId();
  const tokens = { orders: '', settings: '', reader: '', none: '' };

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
    );
    return token;
  }

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': newId() },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  async function data(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  /** Posts `body` to the webhook as Meta does, signed with `secret`. */
  async function webhook(body: unknown, secret = WHATSAPP.appSecret) {
    const raw = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      },
      payload: raw,
    });
  }

  /** A webhook's body with these statuses and messages from customers. */
  const delivery = (statuses: object[], messages: object[] = []) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          { field: 'messages', value: { messaging_product: 'whatsapp', statuses, messages } },
        ],
      },
    ],
  });

  const seconds = (date: Date) => String(Math.floor(date.getTime() / 1000));

  /** Queues a message of the shop's, as the worker does; sent with `wamid` when given. */
  async function message(
    shopId: string,
    options: { recipient?: string; wamid?: string; orderId?: string } = {},
  ): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO messaging.messages
              (shop_id, kind, channel, recipient, language, variables, order_id, dedupe_key,
               status, provider, provider_message_id, sent_at, attempts)
       VALUES ($1, 'order_placed', 'whatsapp', $2, 'en', '{"shop":"Zari","order":"#1001"}', $3,
               $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        shopId,
        options.recipient ?? AYESHA,
        options.orderId ?? null,
        `order_placed:${newId()}`,
        options.wamid ? 'sent' : 'pending',
        options.wamid ? 'whatsapp_cloud' : null,
        options.wamid ?? null,
        options.wamid ? new Date() : null,
        options.wamid ? 1 : 0,
      ],
    );
    return rows[0]!.id;
  }

  const statusOf = async (id: string) =>
    (
      await admin.query<{ status: string; error: string | null }>(
        'SELECT status, error FROM messaging.messages WHERE id = $1',
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'B')`, [
      shop,
      other,
    ]);
    tokens.orders = await issueToken(shop, ['read_orders']);
    tokens.settings = await issueToken(shop, ['write_settings']);
    tokens.reader = await issueToken(shop, ['read_settings']);
    tokens.none = await issueToken(shop, ['read_products']);
    api = await startTestApi(testDb, { whatsapp: WHATSAPP });
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM messaging.messages; DELETE FROM messaging.opt_outs; ' +
        'DELETE FROM messaging.settings',
    );
  });

  it("answers Meta's check with its challenge, given the token agreed", async () => {
    const check = (token: string, mode = 'subscribe') =>
      app.inject({
        method: 'GET',
        url:
          '/webhooks/whatsapp?' +
          new URLSearchParams({
            'hub.mode': mode,
            'hub.verify_token': token,
            'hub.challenge': '1158201444',
          }).toString(),
      });
    const ok = await check(WHATSAPP.verifyToken);
    expect([ok.statusCode, ok.body]).toEqual([200, '1158201444']);
    expect((await check('verify-token-0000')).statusCode).toBe(403);
    expect((await check(WHATSAPP.verifyToken, 'unsubscribe')).statusCode).toBe(403);
  });

  it('takes only what Meta signed, and follows each message to delivery', async () => {
    const sent = await message(shop, { wamid: 'wamid.A1' });
    const failed = await message(shop, { wamid: 'wamid.A2' });
    const elsewhere = await message(other, { wamid: 'wamid.B1', recipient: '+923217654321' });
    const now = new Date();
    const body = delivery([
      { id: 'wamid.A1', status: 'delivered', timestamp: seconds(now) },
      {
        id: 'wamid.A2',
        status: 'failed',
        timestamp: seconds(now),
        errors: [{ code: 131026, title: 'Message undeliverable' }],
      },
      { id: 'wamid.B1', status: 'read', timestamp: seconds(now) },
    ]);

    expect((await webhook(body, 'another-secret')).statusCode).toBe(401);
    // More than a webhook sends: refused before it is read.
    const large = await webhook({ ...body, padding: 'x'.repeat(1024 * 1024) });
    expect(large.statusCode).toBe(413);
    const unsigned = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    expect(unsigned.statusCode).toBe(401);
    expect(await statusOf(sent)).toEqual({ status: 'sent', error: null });

    const taken = await webhook(body);
    expect([taken.statusCode, taken.json()]).toEqual([200, { received: 3 }]);
    expect(await statusOf(sent)).toEqual({ status: 'delivered', error: null });
    expect(await statusOf(failed)).toEqual({
      status: 'failed',
      error: 'WhatsApp 131026: Message undeliverable',
    });
    // Each shop's message, whichever shop it is.
    expect(await statusOf(elsewhere)).toEqual({ status: 'read', error: null });
    // An SMS in place of the one WhatsApp could not deliver, once however often Meta says so.
    expect((await webhook(body)).statusCode).toBe(200);
    const { rows: sms } = await admin.query(
      `SELECT channel, status, replaces FROM messaging.messages WHERE channel = 'sms'`,
    );
    expect(sms).toEqual([{ channel: 'sms', status: 'pending', replaces: failed }]);
  });

  it('asks Meta to send again a status come before its message was recorded', async () => {
    const early = delivery([
      { id: 'wamid.soon', status: 'delivered', timestamp: seconds(new Date()) },
    ]);
    expect((await webhook(early)).statusCode).toBe(503);
    // Recorded since: taken.
    const id = await message(shop, { wamid: 'wamid.soon' });
    expect((await webhook(early)).statusCode).toBe(200);
    expect(await statusOf(id)).toEqual({ status: 'delivered', error: null });
    // Of a message long gone, as one erased: taken, and nothing done.
    const old = delivery([
      { id: 'wamid.gone', status: 'read', timestamp: seconds(new Date(Date.now() - 3_600_000)) },
    ]);
    expect((await webhook(old)).statusCode).toBe(200);
  });

  it('stops the shop a customer said "band karo" to, and nothing else they say', async () => {
    const answered = await message(other, { wamid: 'wamid.B9' });
    const pending = await message(shop);
    const now = seconds(new Date());
    const said = await webhook(
      delivery(
        [],
        [
          { from: AYESHA.slice(1), type: 'text', timestamp: now, text: { body: 'Kab ayega?' } },
          // Shop A wrote last.
          { from: AYESHA.slice(1), type: 'text', timestamp: now, text: { body: 'Band karo' } },
        ],
      ),
    );
    expect([said.statusCode, said.json()]).toEqual([200, { received: 2 }]);
    expect(await statusOf(pending)).toEqual({
      status: 'skipped',
      error: 'Not sent: the customer asked the shop to stop',
    });
    expect(await statusOf(answered)).toEqual({ status: 'sent', error: null });
    // Pressing Stop under shop B's message: B's.
    await webhook(
      delivery(
        [],
        [
          {
            from: AYESHA.slice(1),
            type: 'button',
            timestamp: now,
            context: { from: '15550001111', id: 'wamid.B9' },
            button: { payload: 'stop', text: 'Stop' },
          },
        ],
      ),
    );
    const { rows } = await admin.query(
      'SELECT shop_id, channel, recipient, said FROM messaging.opt_outs ORDER BY created_at',
    );
    expect(rows).toEqual([
      { shop_id: shop, channel: 'whatsapp', recipient: AYESHA, said: 'Band karo' },
      { shop_id: other, channel: 'whatsapp', recipient: AYESHA, said: 'Stop' },
    ]);
  });

  it("lists the shop's own messages, by status and order, a page at a time", async () => {
    const orderId = newId();
    const first = await message(shop, { orderId });
    const second = await message(shop, { wamid: 'wamid.L2' });
    await message(other, { recipient: '+923217654321' });

    const page = await data(tokens.orders, MESSAGES, { first: 1 });
    expect(page.nodes).toEqual([
      expect.objectContaining({
        id: toPublicId('message', second),
        kind: 'ORDER_PLACED',
        channel: 'WHATSAPP',
        recipient: AYESHA,
        language: 'EN',
        status: 'SENT',
        attempts: 1,
        orderId: null,
        replacesId: null,
        sentAt: expect.any(String),
        deliveredAt: null,
      }),
    ]);
    expect(page.pageInfo.hasNextPage).toBe(true);
    const next = await data(tokens.orders, MESSAGES, { first: 5, after: page.pageInfo.endCursor });
    expect(next.nodes.map((node: Json) => [node.id, node.orderId])).toEqual([
      [toPublicId('message', first), toPublicId('order', orderId)],
    ]);
    expect(next.pageInfo.hasNextPage).toBe(false);
    expect(
      (await data(tokens.orders, MESSAGES, { status: 'PENDING' })).nodes.map((n: Json) => n.id),
    ).toEqual([toPublicId('message', first)]);
    expect(
      (await data(tokens.orders, MESSAGES, { orderId: toPublicId('order', orderId) })).nodes.map(
        (node: Json) => node.id,
      ),
    ).toEqual([toPublicId('message', first)]);
    expect((await gql(tokens.orders, MESSAGES, { orderId: 'gid://x' })).errors).toBeDefined();
    expect((await gql(tokens.none, MESSAGES)).errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });

  it("keeps the shop's settings for its messages", async () => {
    expect(await data(tokens.reader, SETTINGS)).toEqual({
      routing: 'RICH',
      language: 'EN',
      disabledNotifications: [],
      updatedAt: null,
    });
    const changed = await data(tokens.settings, UPDATE, {
      input: {
        routing: 'ECONOMY',
        language: 'UR',
        disabledNotifications: ['ORDER_SHIPPED', 'ORDER_PLACED'],
      },
    });
    expect(changed).toEqual({
      messagingSettings: {
        routing: 'ECONOMY',
        language: 'UR',
        disabledNotifications: ['ORDER_PLACED', 'ORDER_SHIPPED'],
      },
      userErrors: [],
    });
    expect(await data(tokens.reader, SETTINGS)).toMatchObject({
      routing: 'ECONOMY',
      updatedAt: expect.any(String),
    });
    expect(
      (await gql(tokens.reader, UPDATE, { input: { language: 'EN' } })).errors?.[0],
    ).toMatchObject({ extensions: { code: 'ACCESS_DENIED' } });
  });
});
