import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

const TOKEN = 'EAAQbusinessToken'.padEnd(80, 'x');
const WABA = '102290129340398';
const NUMBER = '106540352242922';

const ACCOUNT = `businessAccountId phoneNumberId displayPhoneNumber verifiedName qualityRating`;

/** Meta's Graph API as connecting a number asks it: the paths asked, in order. */
function fakeGraph(asked: string[]): Server {
  return createServer((request, response) => {
    const url = new URL(request.url!, 'http://graph');
    const path = url.pathname.replace(/^\/v26\.0\//, '');
    asked.push(`${request.method} ${path}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (path === 'oauth/access_token') {
      response.end(JSON.stringify({ access_token: TOKEN }));
    } else if (path === `${WABA}/phone_numbers`) {
      response.end(
        JSON.stringify({
          data: [
            {
              id: NUMBER,
              display_phone_number: '+92 300 1234567',
              verified_name: 'Zari Fashions',
              quality_rating: 'GREEN',
            },
          ],
        }),
      );
    } else {
      response.end(JSON.stringify({ success: true }));
    }
  });
}

describe.skipIf(!server)(
  "Admin GraphQL API: the shop's own WhatsApp number (MKT-01, ADR-419)",
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
    let api: TestApi;
    let app: NestFastifyApplication;
    let graph: Server;
    const asked: string[] = [];
    const shop = newId();
    const tokens = { settings: '', reader: '' };

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
        headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
        payload: { query, variables },
      });
      return response.json<{ data?: Json; errors?: Json[] }>();
    }

    beforeAll(async () => {
      testDb = await createTestDatabase(server);
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`,
        [shop],
      );
      tokens.settings = await issueToken(['read_settings', 'write_settings']);
      tokens.reader = await issueToken(['read_settings']);
      graph = fakeGraph(asked);
      await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
      api = await startTestApi(testDb, {
        whatsAppSignup: {
          appId: '1234567890',
          appSecret: 'app-secret-of-sixteen',
          configurationId: '987654321',
          baseUrl: `http://127.0.0.1:${(graph.address() as AddressInfo).port}`,
          version: 'v26.0',
        },
      });
      app = api.app;
    });

    afterAll(async () => {
      await api?.close();
      await new Promise<void>((resolve) => (graph ? graph.close(() => resolve()) : resolve()));
      await admin?.end();
      await testDb?.drop();
    });

    it('starts Embedded Signup, connects what it shared and lets it go', async () => {
      const before = await gql(
        tokens.reader,
        `{ whatsAppSignup { appId configurationId graphVersion } whatsAppAccount { ${ACCOUNT} } }`,
      );
      expect(before).toEqual({
        data: {
          whatsAppSignup: {
            appId: '1234567890',
            configurationId: '987654321',
            graphVersion: 'v26.0',
          },
          whatsAppAccount: null,
        },
      });

      const connect = `mutation ($input: WhatsAppAccountConnectInput!) {
      whatsAppAccountConnect(input: $input) {
        whatsAppAccount { ${ACCOUNT} } userErrors { field code message }
      }
    }`;
      const input = { code: 'code-from-signup', businessAccountId: WABA, phoneNumberId: NUMBER };
      // Reading settings is not changing them.
      const refused = await gql(tokens.reader, connect, { input });
      expect(refused.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
      expect(asked).toEqual([]);

      const connected = await gql(tokens.settings, connect, { input });
      expect(connected.data.whatsAppAccountConnect).toEqual({
        whatsAppAccount: {
          businessAccountId: WABA,
          phoneNumberId: NUMBER,
          displayPhoneNumber: '+92 300 1234567',
          verifiedName: 'Zari Fashions',
          qualityRating: 'GREEN',
        },
        userErrors: [],
      });
      expect(asked).toEqual([
        'GET oauth/access_token',
        `GET ${WABA}/phone_numbers`,
        `POST ${WABA}/subscribed_apps`,
        `POST ${NUMBER}/register`,
      ]);
      const shown = await gql(
        tokens.reader,
        `{ whatsAppAccount { ${ACCOUNT} connectedAt }
           whatsAppOrderTemplates { total approved pending refused triedAt } }`,
      );
      expect(shown.data.whatsAppAccount).toMatchObject({ phoneNumberId: NUMBER });
      // Hatti's order templates go to the account from the worker (ADR-537): none yet.
      expect(shown.data.whatsAppOrderTemplates).toEqual({
        total: 44,
        approved: 0,
        pending: 0,
        refused: 0,
        triedAt: null,
      });
      expect(JSON.stringify(shown)).not.toContain(TOKEN.slice(0, 16));

      const bad = await gql(tokens.settings, connect, {
        input: { ...input, phoneNumberId: 'not-an-id' },
      });
      expect(bad.data.whatsAppAccountConnect.userErrors).toEqual([
        {
          field: ['input', 'phoneNumberId'],
          code: 'INVALID',
          message: "Not one of Meta's IDs: not-an-id",
        },
      ]);

      const disconnect = `mutation { whatsAppAccountDisconnect { disconnectedPhoneNumber userErrors { code } } }`;
      expect((await gql(tokens.settings, disconnect)).data.whatsAppAccountDisconnect).toEqual({
        disconnectedPhoneNumber: '+92 300 1234567',
        userErrors: [],
      });
      expect(
        (
          await gql(
            tokens.reader,
            `{ whatsAppAccount { phoneNumberId } whatsAppOrderTemplates { total } }`,
          )
        ).data,
      ).toEqual({ whatsAppAccount: null, whatsAppOrderTemplates: null });
    });
  },
);
