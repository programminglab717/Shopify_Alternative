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
const SHARED = '100000000000001';
const OWN = '200000000000002';

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
    nodes { id direction body mediaKind at }
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
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550001111', phone_number_id: to },
                messages,
              },
            },
          ],
        },
      ],
    });
    const response = await app.inject({
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
    api = await startTestApi(testDb, { whatsapp: WHATSAPP });
    app = api.app;
  });

  afterAll(async () => {
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
});
