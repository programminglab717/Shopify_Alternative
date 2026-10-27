import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { StorefrontApiClient, webChatPath } from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

describe.skipIf(!server)("The chat on the shop's online store (MSG-10, ADR-810)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { settings: '', inbox: '' };

  async function graphql(token: string, query: string, variables: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': newId() },
      payload: { query, variables },
    });
    const body = response.json();
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    return body.data;
  }

  async function issueToken(scopes: string[]): Promise<string> {
    const generated = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, generated.hash, generated.hint, scopes],
    );
    return generated.token;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    tokens.settings = await issueToken(['write_settings']);
    tokens.inbox = await issueToken(['write_conversations']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('is turned on in the Admin API, chatted in from the storefront and answered from the inbox', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: webChatPath(shop),
          payload: { name: 'Ayesha', phone: '0300 1234567', body: 'Hi' },
        })
      ).statusCode,
    ).toBe(401);
    await app.listen(0, '127.0.0.1');
    const client = new StorefrontApiClient({
      baseUrl: await app.getUrl(),
      key: TEST_STOREFRONT_KEY,
    });
    const first = { name: 'Ayesha', phone: '0300 1234567', body: 'Is the lawn suit in medium?' };
    // Off: none.
    expect(await client.webChatStart(shop, first)).toBeNull();

    const update = `mutation ($input: WebChatSettingsInput!) {
      webChatSettingsUpdate(input: $input) {
        webChatSettings { enabled greeting }
        userErrors { field message }
      }
    }`;
    expect(
      await graphql(tokens.settings, update, { input: { enabled: true, greeting: 'Salam!' } }),
    ).toEqual({
      webChatSettingsUpdate: {
        webChatSettings: { enabled: true, greeting: 'Salam!' },
        userErrors: [],
      },
    });
    expect(await graphql(tokens.settings, '{ webChatSettings { enabled greeting } }')).toEqual({
      webChatSettings: { enabled: true, greeting: 'Salam!' },
    });

    expect(await client.webChatStart(shop, { ...first, phone: '12' })).toEqual({
      ok: false,
      errors: [{ field: 'phone', message: 'Give a Pakistani mobile number, like 0300 1234567' }],
    });
    const started = await client.webChatStart(shop, first);
    if (!started?.ok || !started.token) throw new Error(JSON.stringify(started));
    const token = started.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.messages).toEqual([
      {
        id: expect.stringMatching(/^cmsg_/),
        direction: 'inbound',
        body: 'Is the lawn suit in medium?',
        at: expect.any(String),
      },
    ]);

    const { conversations } = await graphql(
      tokens.inbox,
      `
        {
          conversations(first: 5) {
            nodes {
              id
              channel
              customerName
              replyableUntil
              unread
            }
          }
        }
      `,
    );
    expect(conversations.nodes).toEqual([
      {
        id: expect.stringMatching(/^chat_/),
        channel: 'WEB',
        customerName: 'Ayesha',
        replyableUntil: null,
        unread: 1,
      },
    ]);
    const replied = await graphql(
      tokens.inbox,
      `
        mutation ($id: ID!) {
          conversationReply(id: $id, body: "Yes, in stock") {
            userErrors {
              message
            }
          }
        }
      `,
      { id: conversations.nodes[0].id },
    );
    expect(replied.conversationReply.userErrors).toEqual([]);

    expect(await client.webChatWrite(shop, { token, body: 'Thanks!' })).toEqual({
      ok: true,
      messages: [
        expect.objectContaining({ direction: 'inbound', body: 'Is the lawn suit in medium?' }),
        expect.objectContaining({ direction: 'outbound', body: 'Yes, in stock' }),
        expect.objectContaining({ direction: 'inbound', body: 'Thanks!' }),
      ],
    });
    const read = await client.webChatRead(shop, token);
    expect(read?.ok && read.messages).toHaveLength(3);
    expect(await client.webChatRead(shop, 'x'.repeat(43))).toBeNull();
  });
});
