import 'reflect-metadata';
import { AiGateway } from '@hatti/ai';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe.skipIf(!server)(
  "Questions of the shop's numbers through the Admin API (ANL-08, ADR-844)",
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
    let api: TestApi;
    let app: NestFastifyApplication;
    const shop = newId();
    const tokens = { orders: '', products: '' };

    async function issueToken(scopes: string[]): Promise<string> {
      const { token, hash, hint } = generateAccessToken();
      await admin.query(
        `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
        [shop, hash, hint, scopes],
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

    beforeAll(async () => {
      testDb = await createTestDatabase(server);
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
      tokens.orders = await issueToken(['read_orders']);
      tokens.products = await issueToken(['read_products']);
      const fetch = (async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: 'tool_use',
                name: 'choose_report',
                input: {
                  answerable: true,
                  breakdown: 'month',
                  columns: ['orders'],
                  period: 'this_year',
                },
              },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 200, output_tokens: 30 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof globalThis.fetch;
      api = await startTestApi(testDb, {
        ai: new AiGateway({ apiKey: 'test', model: 'model-from-config', fetch }),
      });
      app = api.app;
    });

    afterAll(async () => {
      await api?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it('answers with the report the question was read into, for those who read orders', async () => {
      expect(
        (await gql(tokens.orders, '{ reportQuestions { available usedToday } }')).data,
      ).toEqual({
        reportQuestions: { available: true, usedToday: 0 },
      });
      const ASK = `mutation ($question: String!) {
      reportQuestionAsk(question: $question) {
        answer { breakdown columns period report { columns { key } totals } }
        userErrors { field code }
      }
    }`;
      expect(
        (await gql(tokens.orders, ASK, { question: 'Is saal har mahine kitne order aaye?' })).data
          ?.reportQuestionAsk,
      ).toEqual({
        answer: {
          breakdown: 'MONTH',
          columns: ['orders'],
          period: 'THIS_YEAR',
          report: { columns: [{ key: 'orders' }], totals: ['0'] },
        },
        userErrors: [],
      });
      expect(
        (await gql(tokens.products, ASK, { question: 'sales?' })).errors?.[0]?.extensions?.code,
      ).toBe('ACCESS_DENIED');
    });
  },
);
