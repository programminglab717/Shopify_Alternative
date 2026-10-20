import 'reflect-metadata';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { generateAccessToken } from '@hatti/api';
import { newId } from '@hatti/ids';
import { StorefrontApiClient, contactMessagesPath } from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Messages through the online store's contact form (ADR-589)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  let token = '';

  async function graphql(query: string, variables: Record<string, unknown> = {}) {
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

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    const generated = generateAccessToken();
    token = generated.token;
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, generated.hash, generated.hint, ['write_conversations']],
    );
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('keeps a message from the storefront for the shop to read, mark and delete', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: contactMessagesPath(shop),
          payload: { phone: '0300 1234567', body: 'Hi' },
        })
      ).statusCode,
    ).toBe(401);
    await app.listen(0, '127.0.0.1');
    const client = new StorefrontApiClient({
      baseUrl: await app.getUrl(),
      key: TEST_STOREFRONT_KEY,
    });
    const sent = await client.contactMessage(shop, {
      name: 'Ayesha',
      phone: '0300 1234567',
      body: 'Is the lawn suit back in medium?',
      fields: { 'Order number': '#1042' },
      page: '/pages/contact',
      language: 'ur',
    });
    if (!sent.ok) throw new Error(JSON.stringify(sent.errors));
    expect(sent.id).toMatch(/^cform_/);
    expect(await client.contactMessage(shop, { body: 'Hi' })).toEqual({
      ok: false,
      errors: [{ field: 'email', message: 'Email or a mobile number is needed, to answer you' }],
    });

    const listed = await graphql(`
      {
        contactMessagesUnreadCount
        contactMessages(first: 5) {
          nodes {
            id
            name
            email
            phone
            body
            fields {
              name
              value
            }
            page
            language
            readAt
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `);
    expect(listed).toEqual({
      contactMessagesUnreadCount: 1,
      contactMessages: {
        nodes: [
          {
            id: sent.id,
            name: 'Ayesha',
            email: null,
            phone: '+923001234567',
            body: 'Is the lawn suit back in medium?',
            fields: [{ name: 'Order number', value: '#1042' }],
            page: '/pages/contact',
            language: 'ur',
            readAt: null,
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });

    const read = await graphql(
      `
        mutation ($id: ID!) {
          contactMessageMarkRead(id: $id) {
            contactMessage {
              readAt
            }
            userErrors {
              message
            }
          }
        }
      `,
      { id: sent.id },
    );
    expect(read.contactMessageMarkRead.contactMessage.readAt).toEqual(expect.any(String));
    expect((await graphql('{ contactMessagesUnreadCount }')).contactMessagesUnreadCount).toBe(0);
    const deleted = await graphql(
      `
        mutation ($id: ID!) {
          contactMessageDelete(id: $id) {
            deletedContactMessageId
            userErrors {
              message
            }
          }
        }
      `,
      { id: sent.id },
    );
    expect(deleted.contactMessageDelete).toEqual({
      deletedContactMessageId: sent.id,
      userErrors: [],
    });
    const again = await graphql(
      `
        mutation ($id: ID!) {
          contactMessageDelete(id: $id) {
            deletedContactMessageId
            userErrors {
              message
            }
          }
        }
      `,
      { id: sent.id },
    );
    expect(again.contactMessageDelete).toEqual({
      deletedContactMessageId: null,
      userErrors: [{ message: 'No such message' }],
    });
  });
});
