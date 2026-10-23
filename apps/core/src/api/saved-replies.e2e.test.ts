import 'reflect-metadata';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { generateAccessToken } from '@hatti/api';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

const REPLY = /* GraphQL */ `
  fragment Reply on SavedReplyPayload {
    savedReply {
      id
      title
      body
    }
    userErrors {
      field
      code
      message
    }
  }
`;

describe.skipIf(!server)(
  "The inbox's saved replies through the Admin API (MSG-06, ADR-758)",
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
    let api: TestApi;
    let app: NestFastifyApplication;
    const shop = newId();
    const tokens: Record<'agent' | 'marketer', string> = { agent: '', marketer: '' };

    async function graphql(
      who: keyof typeof tokens,
      query: string,
      variables: Record<string, unknown> = {},
    ) {
      const response = await app.inject({
        method: 'POST',
        url: ADMIN_GRAPHQL_PATH,
        headers: { 'x-hatti-access-token': tokens[who], 'idempotency-key': newId() },
        payload: { query, variables },
      });
      return response.json();
    }

    beforeAll(async () => {
      testDb = await createTestDatabase(server);
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
      for (const [who, scopes] of [
        ['agent', ['write_conversations']],
        ['marketer', ['read_conversations']],
      ] as const) {
        const generated = generateAccessToken();
        tokens[who] = generated.token;
        await admin.query(
          `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
         VALUES ($1, $2, $3, $4, $5)`,
          [shop, who, generated.hash, generated.hint, scopes],
        );
      }
      api = await startTestApi(testDb);
      app = api.app;
    });

    afterAll(async () => {
      await api?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it('keeps, changes and deletes replies for those who answer, and shows them to all who read', async () => {
      const created = await graphql(
        'agent',
        `
          mutation ($input: SavedReplyInput!) {
            savedReplyCreate(input: $input) {
              ...Reply
            }
          }
          ${REPLY}
        `,
        { input: { title: 'Bank details', body: 'Meezan Bank\nIBAN PK36 MEZN 0001' } },
      );
      const reply = created.data.savedReplyCreate.savedReply;
      expect(reply).toMatchObject({
        title: 'Bank details',
        body: 'Meezan Bank\nIBAN PK36 MEZN 0001',
      });
      expect(reply.id).toMatch(/^srep_/);

      const taken = await graphql(
        'agent',
        `
          mutation ($input: SavedReplyInput!) {
            savedReplyCreate(input: $input) {
              ...Reply
            }
          }
          ${REPLY}
        `,
        { input: { title: 'bank DETAILS', body: 'Again' } },
      );
      expect(taken.data.savedReplyCreate).toEqual({
        savedReply: null,
        userErrors: [
          {
            field: ['title'],
            code: 'TAKEN',
            message: 'A saved reply is called bank DETAILS already',
          },
        ],
      });

      const changed = await graphql(
        'agent',
        `
          mutation ($id: ID!, $input: SavedReplyInput!) {
            savedReplyUpdate(id: $id, input: $input) {
              ...Reply
            }
          }
          ${REPLY}
        `,
        { id: reply.id, input: { title: 'Bank transfer', body: 'بینک: میزان' } },
      );
      expect(changed.data.savedReplyUpdate.savedReply).toMatchObject({
        id: reply.id,
        title: 'Bank transfer',
        body: 'بینک: میزان',
      });

      const read = await graphql('marketer', '{ savedReplies { id title body } }');
      expect(read.data.savedReplies).toEqual([
        { id: reply.id, title: 'Bank transfer', body: 'بینک: میزان' },
      ]);
      // Marketers read the inbox; they do not answer, nor keep its replies.
      const refused = await graphql(
        'marketer',
        `
          mutation ($id: ID!) {
            savedReplyDelete(id: $id) {
              deletedSavedReplyId
            }
          }
        `,
        { id: reply.id },
      );
      expect(refused.errors[0].extensions.code).toBe('ACCESS_DENIED');

      const deleted = await graphql(
        'agent',
        `
          mutation ($id: ID!) {
            savedReplyDelete(id: $id) {
              deletedSavedReplyId
              userErrors {
                code
              }
            }
          }
        `,
        { id: reply.id },
      );
      expect(deleted.data.savedReplyDelete).toEqual({
        deletedSavedReplyId: reply.id,
        userErrors: [],
      });
      const again = await graphql(
        'agent',
        `
          mutation ($id: ID!) {
            savedReplyDelete(id: $id) {
              deletedSavedReplyId
              userErrors {
                code
              }
            }
          }
        `,
        { id: reply.id },
      );
      expect(again.data.savedReplyDelete).toEqual({
        deletedSavedReplyId: null,
        userErrors: [{ code: 'NOT_FOUND' }],
      });
    });
  },
);
