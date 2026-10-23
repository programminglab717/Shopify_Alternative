import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
const SHARED = '100000000000001';
const OWN = '200000000000002';
const SHARED_TOKEN = 'EAAQsharedToken'.padEnd(80, 'y');

const REPLY = `mutation ($id: ID!, $body: String!) {
  conversationReply(id: $id, body: $body) {
    conversation { id unread replyableUntil lastMessage { id direction status } }
    message { id direction body status error at }
    userErrors { field code message }
  }
}`;

const CONVERSATIONS = `query ($first: Int, $after: String, $unread: Boolean, $status: ConversationStatus) {
  conversations(first: $first, after: $after, unread: $unread, status: $status) {
    nodes {
      id customerPhone viaOwnNumber status unread lastMessageAt lastInboundAt createdAt
      lastMessage { id direction body mediaKind at }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const MESSAGES = `query ($conversationId: ID!, $first: Int, $before: ID) {
  conversationMessages(conversationId: $conversationId, first: $first, before: $before) {
    nodes { id direction body mediaKind at status }
    pageInfo { hasNextPage endCursor }
  }
}`;

const MARK_READ = `mutation ($id: ID!) {
  conversationMarkRead(id: $id) {
    conversation { id unread status }
    userErrors { field code message }
  }
}`;

const STATUS = `mutation ($id: ID!, $status: ConversationStatus!) {
  conversationUpdateStatus(id: $id, status: $status) {
    conversation { id unread status }
    userErrors { field code message }
  }
}`;

describe.skipIf(!server)("The inbox's API (MSG-05, ADR-545)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const other = newId();
  const tokens = { writer: '', reader: '', none: '', other: '' };
  /** Meta's Graph API as replies go through it: each message sent kept, each given an ID. */
  const sent: { path: string; auth: string | undefined; body: Json }[] = [];
  let graph: Server;

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

  /** Customers' messages to `to`, posted to the webhook as Meta does. */
  async function written(to: string, messages: object[]) {
    const response = await posted({
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550001111', phone_number_id: to },
      messages,
    });
    expect(response.statusCode).toBe(200);
  }

  /** A change of the messages field, posted to the webhook as Meta does. */
  async function posted(value: object) {
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [{ field: 'messages', value }],
        },
      ],
    });
    return app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', WHATSAPP.appSecret).update(raw).digest('hex')}`,
      },
      payload: raw,
    });
  }

  const at = (iso: string) => String(Math.floor(new Date(iso).getTime() / 1000));

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'B')`, [
      shop,
      other,
    ]);
    await admin.query(
      `INSERT INTO messaging.whatsapp_accounts
              (shop_id, business_account_id, phone_number_id, display_phone_number,
               verified_name, access_token, pin)
       VALUES ($1, '300', $2, '+92 300 0000000', 'Zari', 'sealed', 'sealed')`,
      [shop, OWN],
    );
    tokens.writer = await issueToken(shop, ['write_conversations']);
    tokens.reader = await issueToken(shop, ['read_conversations']);
    tokens.none = await issueToken(shop, ['read_orders']);
    tokens.other = await issueToken(other, ['write_conversations']);
    graph = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      request.on('end', () => {
        sent.push({
          path: request.url!,
          auth: request.headers.authorization,
          body: JSON.parse(raw),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ messages: [{ id: `wamid.REPLY${sent.length}` }] }));
      });
    });
    await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
    api = await startTestApi(testDb, {
      whatsapp: WHATSAPP,
      whatsAppReplies: {
        baseUrl: `http://127.0.0.1:${(graph.address() as AddressInfo).port}`,
        version: 'v26.0',
        shared: { phoneNumberId: SHARED, accessToken: SHARED_TOKEN },
      },
    });
    app = api.app;
  });

  afterAll(async () => {
    await new Promise((resolve) => graph?.close(resolve));
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM messaging.conversations; DELETE FROM messaging.messages');
  });

  it('keeps what customers write to the shop, and lets its staff read and close it', async () => {
    // To the shop's own number; then a photo to the shared one, answering a message of the shop's.
    await admin.query(
      `INSERT INTO messaging.messages
              (shop_id, kind, channel, recipient, language, dedupe_key, status, provider,
               provider_message_id, sent_at)
       VALUES ($1, 'order_placed', 'whatsapp', $2, 'en', 'test:1', 'sent', 'whatsapp_cloud',
               'wamid.ZARI1', now())`,
      [shop, AYESHA],
    );
    await written(OWN, [
      {
        from: AYESHA.slice(1),
        id: 'wamid.IN1',
        type: 'text',
        timestamp: at('2026-10-17T09:00:00Z'),
        text: { body: 'Is the lawn suit in medium?' },
      },
    ]);
    const photo = {
      from: AYESHA.slice(1),
      id: 'wamid.IN2',
      type: 'image',
      timestamp: at('2026-10-17T09:05:00Z'),
      context: { from: '15550001111', id: 'wamid.ZARI1' },
      image: { id: 'media-1', mime_type: 'image/jpeg' },
    };
    await written(SHARED, [photo]);
    // Meta delivering it again keeps it once.
    await written(SHARED, [photo]);

    const list = await data(tokens.reader, CONVERSATIONS, { first: 10 });
    expect(list.nodes).toEqual([
      {
        id: expect.stringMatching(/^chat_/),
        customerPhone: AYESHA,
        viaOwnNumber: false,
        status: 'OPEN',
        unread: 2,
        lastMessageAt: '2026-10-17T09:05:00.000Z',
        lastInboundAt: '2026-10-17T09:05:00.000Z',
        createdAt: expect.any(String),
        lastMessage: {
          id: expect.stringMatching(/^cmsg_/),
          direction: 'INBOUND',
          body: null,
          mediaKind: 'image',
          at: '2026-10-17T09:05:00.000Z',
        },
      },
    ]);
    expect(list.pageInfo).toEqual({ hasNextPage: false, endCursor: expect.any(String) });
    const id = list.nodes[0].id;
    expect(await data(tokens.reader, '{ conversationsUnreadCount }')).toBe(1);
    expect(
      await data(tokens.reader, 'query ($id: ID!) { conversation(id: $id) { id } }', { id }),
    ).toEqual({ id });

    const first = await data(tokens.reader, MESSAGES, { conversationId: id, first: 1 });
    expect(first.nodes.map((m: Json) => m.mediaKind)).toEqual(['image']);
    expect(first.pageInfo.hasNextPage).toBe(true);
    const older = await data(tokens.reader, MESSAGES, {
      conversationId: id,
      before: first.pageInfo.endCursor,
    });
    expect(older.nodes.map((m: Json) => [m.direction, m.body])).toEqual([
      ['INBOUND', 'Is the lawn suit in medium?'],
    ]);
    expect(older.pageInfo.hasNextPage).toBe(false);

    // Reading needs read_conversations; marking read and closing, write_conversations.
    const denied = await gql(tokens.none, CONVERSATIONS, {});
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const readOnly = await gql(tokens.reader, MARK_READ, { id });
    expect(readOnly.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');

    expect(await data(tokens.writer, MARK_READ, { id })).toEqual({
      conversation: { id, unread: 0, status: 'OPEN' },
      userErrors: [],
    });
    expect(await data(tokens.writer, CONVERSATIONS, { unread: true })).toMatchObject({ nodes: [] });
    expect(await data(tokens.writer, STATUS, { id, status: 'CLOSED' })).toEqual({
      conversation: { id, unread: 0, status: 'CLOSED' },
      userErrors: [],
    });
    expect(
      (await data(tokens.writer, CONVERSATIONS, { status: 'CLOSED' })).nodes.map((c: Json) => c.id),
    ).toEqual([id]);

    // Writing again opens it, unread.
    await written(OWN, [
      {
        from: AYESHA.slice(1),
        id: 'wamid.IN3',
        type: 'text',
        timestamp: at('2026-10-17T10:00:00Z'),
        text: { body: 'Hello?' },
      },
    ]);
    const [again] = (await data(tokens.writer, CONVERSATIONS, {})).nodes;
    expect(again).toMatchObject({ id, status: 'OPEN', unread: 1, viaOwnNumber: true });
  });

  it("finds no other shop's conversations", async () => {
    await written(OWN, [
      {
        from: AYESHA.slice(1),
        id: 'wamid.IN9',
        type: 'text',
        timestamp: at('2026-10-17T09:00:00Z'),
        text: { body: 'Salam' },
      },
    ]);
    const [conversation] = (await data(tokens.reader, CONVERSATIONS, {})).nodes;
    const id = conversation.id;
    expect((await data(tokens.other, CONVERSATIONS, {})).nodes).toEqual([]);
    expect(await data(tokens.other, '{ conversationsUnreadCount }')).toBe(0);
    expect(
      await data(tokens.other, 'query ($id: ID!) { conversation(id: $id) { id } }', { id }),
    ).toBeNull();
    expect((await data(tokens.other, MESSAGES, { conversationId: id })).nodes).toEqual([]);
    expect(await data(tokens.other, MARK_READ, { id })).toEqual({
      conversation: null,
      userErrors: [{ field: ['id'], code: 'NOT_FOUND', message: 'No such conversation' }],
    });
    expect(await data(tokens.other, STATUS, { id, status: 'CLOSED' })).toMatchObject({
      conversation: null,
      userErrors: [{ code: 'NOT_FOUND' }],
    });
    const bad = await gql(tokens.reader, MESSAGES, {
      conversationId: toPublicId('product', newId()),
    });
    expect(bad.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(await data(tokens.reader, '{ conversationsUnreadCount }')).toBe(1);
  });

  it('answers within the day from the number written to, and follows the reply to delivery', async () => {
    await admin.query(
      `INSERT INTO messaging.messages
              (shop_id, kind, channel, recipient, language, dedupe_key, status, provider,
               provider_message_id, sent_at)
       VALUES ($1, 'order_placed', 'whatsapp', $2, 'en', 'test:2', 'sent', 'whatsapp_cloud',
               'wamid.ZARI2', now())`,
      [shop, AYESHA],
    );
    const wrote = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await written(SHARED, [
      {
        from: AYESHA.slice(1),
        id: 'wamid.IN20',
        type: 'text',
        timestamp: String(wrote.getTime() / 1000),
        context: { from: '15550001111', id: 'wamid.ZARI2' },
        text: { body: 'Kab tak aayega?' },
      },
    ]);
    const [conversation] = (await data(tokens.reader, CONVERSATIONS, {})).nodes;
    const id = conversation.id;

    const readOnly = await gql(tokens.reader, REPLY, { id, body: 'Kal tak' });
    expect(readOnly.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    expect(await data(tokens.other, REPLY, { id, body: 'Kal tak' })).toMatchObject({
      message: null,
      userErrors: [{ field: ['id'], code: 'NOT_FOUND' }],
    });
    expect(sent).toEqual([]);

    const replied = await data(tokens.writer, REPLY, { id, body: 'Kal tak pohanch jayega' });
    expect(replied).toEqual({
      conversation: {
        id,
        unread: 0,
        replyableUntil: new Date(wrote.getTime() + 24 * 3_600_000).toISOString(),
        lastMessage: { id: replied.message.id, direction: 'OUTBOUND', status: 'SENT' },
      },
      message: {
        id: expect.stringMatching(/^cmsg_/),
        direction: 'OUTBOUND',
        body: 'Kal tak pohanch jayega',
        status: 'SENT',
        error: null,
        at: expect.any(String),
      },
      userErrors: [],
    });
    expect(sent).toEqual([
      {
        path: `/v26.0/${SHARED}/messages`,
        auth: `Bearer ${SHARED_TOKEN}`,
        body: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: AYESHA.slice(1),
          type: 'text',
          text: { body: 'Kal tak pohanch jayega', preview_url: true },
        },
      },
    ]);

    // WhatsApp's word of it, as of the shop's other messages.
    const now = String(Math.floor(Date.now() / 1000));
    const statuses = await posted({
      messaging_product: 'whatsapp',
      statuses: [
        { id: 'wamid.REPLY1', status: 'delivered', timestamp: now },
        { id: 'wamid.REPLY1', status: 'read', timestamp: now },
      ],
    });
    expect(statuses.statusCode).toBe(200);
    const [latest] = (await data(tokens.reader, MESSAGES, { conversationId: id, first: 1 })).nodes;
    expect(latest).toMatchObject({ id: replied.message.id, status: 'READ' });

    // Past the day, nothing is sent.
    await admin.query(
      `UPDATE messaging.conversations SET last_inbound_at = now() - interval '25 hours'`,
    );
    expect(await data(tokens.writer, REPLY, { id, body: 'Hello?' })).toMatchObject({
      message: null,
      userErrors: [{ field: ['id'], code: 'WINDOW_CLOSED' }],
    });
    expect(sent).toHaveLength(1);
  });

  it("says since when a customer waits and by when to answer, overdue past the shop's target (ADR-760)", async () => {
    const settings = await issueToken(shop, ['write_settings', 'read_conversations']);
    const target = await data(
      settings,
      `mutation ($input: MessagingSettingsInput!) {
         messagingSettingsUpdate(input: $input) {
           messagingSettings { replyTargetMinutes } userErrors { field code message } } }`,
      { input: { replyTargetMinutes: 30 } },
    );
    expect(target).toEqual({ messagingSettings: { replyTargetMinutes: 30 }, userErrors: [] });
    const refused = await data(
      settings,
      `mutation { messagingSettingsUpdate(input: { replyTargetMinutes: 2000 }) {
         userErrors { field code } } }`,
    );
    expect(refused.userErrors).toEqual([
      { field: ['input', 'replyTargetMinutes'], code: 'INVALID' },
    ]);

    const wrote = new Date(Math.floor(Date.now() / 1000) * 1000 - 45 * 60_000);
    await written(OWN, [
      {
        from: AYESHA.slice(1),
        id: 'wamid.WAIT1',
        type: 'text',
        timestamp: at(wrote.toISOString()),
        text: { body: 'Is the order on its way?' },
      },
    ]);
    const list = await data(
      tokens.reader,
      '{ conversations(first: 5, overdue: true) { nodes { id waitingSince answerBy } } }',
    );
    expect(list.nodes).toEqual([
      {
        id: expect.stringMatching(/^chat_/),
        waitingSince: wrote.toISOString(),
        answerBy: new Date(wrote.getTime() + 30 * 60_000).toISOString(),
      },
    ]);
    expect(await data(tokens.reader, '{ conversationsOverdueCount }')).toBe(1);
    // Another shop's count is its own.
    expect(await data(tokens.other, '{ conversationsOverdueCount }')).toBe(0);

    // Closed, it waits no more.
    const closed = await data(tokens.writer, STATUS, { id: list.nodes[0].id, status: 'CLOSED' });
    expect(closed.userErrors).toEqual([]);
    expect(await data(tokens.reader, '{ conversationsOverdueCount }')).toBe(0);
  });

  it("reports how long customers waited for the shop's answers, to those who may see it (ADR-763)", async () => {
    await admin.query('DELETE FROM messaging.conversation_answers');
    await admin.query(
      `INSERT INTO messaging.settings (shop_id, reply_target_minutes) VALUES ($1, 30)
           ON CONFLICT (shop_id) DO UPDATE SET reply_target_minutes = 30`,
      [shop],
    );
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO messaging.conversations (shop_id, customer_phone, last_message_at)
       VALUES ($1, '+923001119999', now()) RETURNING id`,
      [shop],
    );
    const staffMember = newId();
    await admin.query(
      `INSERT INTO messaging.conversation_answers
              (shop_id, conversation_id, waited_from, answered_at, actor_kind, actor_id)
       VALUES ($1, $2, now() - interval '10 minutes', now() - interval '6 minutes', 'staff', $3),
              ($1, $2, now() - interval '50 minutes', now() - interval '10 minutes', 'staff', $3)`,
      [shop, rows[0]!.id, staffMember],
    );
    const query = `query ($from: DateTime!, $before: DateTime!) {
      inboxReplyTimes(from: $from, before: $before) {
        answered medianWaitSeconds withinTarget replyTargetMinutes
        repliers { kind id answered medianWaitSeconds withinTarget }
      } }`;
    const period = {
      from: new Date(Date.now() - 86_400_000).toISOString(),
      before: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(await data(tokens.reader, query, period)).toEqual({
      answered: 2,
      medianWaitSeconds: 1320,
      withinTarget: 1,
      replyTargetMinutes: 30,
      repliers: [
        {
          kind: 'STAFF',
          id: toPublicId('user', staffMember),
          answered: 2,
          medianWaitSeconds: 1320,
          withinTarget: 1,
        },
      ],
    });
    const refused = await gql(tokens.none, query, period);
    expect(refused.errors?.[0]).toMatchObject({ extensions: { code: 'ACCESS_DENIED' } });
  });

  it('labels conversations with what customers write about, and lists those with a label (ADR-764)', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO messaging.conversations (shop_id, customer_phone, last_message_at)
       VALUES ($1, '+923001119999', now() - interval '1 hour'), ($1, '+923001118888', now())
       RETURNING id`,
      [shop],
    );
    const [first, second] = rows.map((row) => toPublicId('conversation', row.id)) as [
      string,
      string,
    ];
    const label = `mutation ($id: ID!, $labels: [String!]!) {
      conversationLabelsSet(id: $id, labels: $labels) {
        conversation { id labels }
        userErrors { field code message }
      } }`;
    expect(await data(tokens.writer, label, { id: first, labels: ['Delivery', 'size'] })).toEqual({
      conversation: { id: first, labels: ['Delivery', 'size'] },
      userErrors: [],
    });
    expect(await data(tokens.writer, label, { id: second, labels: ['delivery'] })).toEqual({
      conversation: { id: second, labels: ['Delivery'] },
      userErrors: [],
    });
    const labelled = `query ($label: String) {
      conversations(label: $label) { nodes { id labels } } }`;
    expect((await data(tokens.reader, labelled, { label: 'size' })).nodes).toEqual([
      { id: first, labels: ['Delivery', 'size'] },
    ]);
    expect(await data(tokens.reader, '{ conversationLabels { name open } }')).toEqual([
      { name: 'Delivery', open: 2 },
      { name: 'size', open: 1 },
    ]);
    expect(await data(tokens.other, '{ conversationLabels { name open } }')).toEqual([]);
    expect(await data(tokens.other, label, { id: first, labels: ['mine'] })).toMatchObject({
      conversation: null,
      userErrors: [{ code: 'NOT_FOUND' }],
    });
    const tooLong = await data(tokens.writer, label, { id: first, labels: ['x'.repeat(41)] });
    expect(tooLong.userErrors).toMatchObject([{ field: ['labels'], code: 'TOO_LONG' }]);
    const readOnly = await gql(tokens.reader, label, { id: first, labels: [] });
    expect(readOnly.errors?.[0]).toMatchObject({ extensions: { code: 'ACCESS_DENIED' } });
  });

  it("sends a draft order's link in the conversation, for the customer to add their address and confirm (ADR-765)", async () => {
    await admin.query(
      `INSERT INTO messaging.messages
              (shop_id, kind, channel, recipient, language, dedupe_key, status, provider,
               provider_message_id, sent_at)
       VALUES ($1, 'order_placed', 'whatsapp', $2, 'en', 'test:draft', 'sent', 'whatsapp_cloud',
               'wamid.ZARIDRAFT', now())`,
      [shop, AYESHA],
    );
    await written(SHARED, [
      {
        from: AYESHA.slice(1),
        id: 'wamid.IN30',
        type: 'text',
        timestamp: String(Math.floor(Date.now() / 1000) - 60),
        context: { from: '15550001111', id: 'wamid.ZARIDRAFT' },
        text: { body: 'Yeh suit chahiye' },
      },
    ]);
    const [conversation] = (await data(tokens.reader, CONVERSATIONS, {})).nodes;
    const draftId = newId();
    await admin.query(
      `INSERT INTO orders.draft_orders
         (shop_id, id, number, source, payment_method, currency, lines, subtotal, discount,
          shipping, total, advance_paid, actor_kind, actor_id)
       VALUES ($1, $2, 901, 'whatsapp', 'cash_on_delivery', 'PKR', $4, 250000, 0, 0, 250000, 0,
               'app', $3)`,
      [
        shop,
        draftId,
        newId(),
        JSON.stringify([
          {
            variantId: newId(),
            productId: newId(),
            title: 'Lawn suit',
            variantTitle: 'Medium',
            sku: null,
            quantity: 1,
            unitPrice: '250000',
          },
        ]),
      ],
    );
    const draft = toPublicId('draftOrder', draftId);
    const send = `mutation ($id: ID!, $draftOrderId: ID!) {
      conversationDraftLinkSend(id: $id, draftOrderId: $draftOrderId) {
        conversation { id lastMessage { direction body status } }
        userErrors { field code message }
      } }`;
    const both = await issueToken(shop, ['write_conversations', 'write_orders']);
    const before = sent.length;

    // It takes both scopes, and the shop's own conversation and draft.
    const refused = await gql(tokens.writer, send, { id: conversation.id, draftOrderId: draft });
    expect(refused.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    expect(
      await data(both, send, {
        id: conversation.id,
        draftOrderId: toPublicId('draftOrder', newId()),
      }),
    ).toMatchObject({
      conversation: null,
      userErrors: [{ field: ['draftOrderId'], code: 'NOT_FOUND' }],
    });
    expect(sent).toHaveLength(before);

    const done = await data(both, send, { id: conversation.id, draftOrderId: draft });
    expect(done.userErrors).toEqual([]);
    const body = done.conversation.lastMessage.body as string;
    expect(done.conversation.lastMessage).toMatchObject({ direction: 'OUTBOUND', status: 'SENT' });
    expect(body).toMatch(
      /^Please add your address and confirm your order from Zari:\nhttps?:\/\/\S+\/d\/[A-Za-z0-9_-]{22}\n/,
    );
    expect(sent.slice(before).map((each) => each.body.text.body)).toEqual([body]);
    const { rows } = await admin.query(
      'SELECT link_token_hash IS NOT NULL AS linked FROM orders.draft_orders WHERE id = $1',
      [draftId],
    );
    expect(rows[0]).toEqual({ linked: true });

    // Past the day, no link is made, so the one sent stays good.
    await admin.query(
      `UPDATE messaging.conversations SET last_inbound_at = now() - interval '25 hours'`,
    );
    const { rows: hashBefore } = await admin.query(
      'SELECT link_token_hash FROM orders.draft_orders WHERE id = $1',
      [draftId],
    );
    expect(await data(both, send, { id: conversation.id, draftOrderId: draft })).toMatchObject({
      conversation: null,
      userErrors: [{ field: ['id'], code: 'WINDOW_CLOSED' }],
    });
    const { rows: hashAfter } = await admin.query(
      'SELECT link_token_hash FROM orders.draft_orders WHERE id = $1',
      [draftId],
    );
    expect(hashAfter).toEqual(hashBefore);
  });
});
