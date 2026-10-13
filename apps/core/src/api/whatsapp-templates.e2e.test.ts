import 'reflect-metadata';
import { createHmac, randomUUID } from 'node:crypto';
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

const WHATSAPP = { appSecret: 'whatsapp-app-secret-1234', verifyToken: 'verify-token-5678' };
const WABA = '102290129340398';
const NUMBER = '106540352242922';
const META_TEMPLATE = '594425479261596';

const TEMPLATE = `id name language body buttonText buttonUrl status rejectedReason`;

/** Meta's Graph API as connecting a number and sending a template ask it. */
function fakeGraph(asked: string[]): Server {
  return createServer((request, response) => {
    const path = new URL(request.url!, 'http://graph').pathname.replace(/^\/v26\.0\//, '');
    asked.push(`${request.method} ${path}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (path === 'oauth/access_token') {
      response.end(JSON.stringify({ access_token: 'EAAQbusinessToken'.padEnd(80, 'x') }));
    } else if (path === `${WABA}/phone_numbers`) {
      response.end(
        JSON.stringify({
          data: [{ id: NUMBER, display_phone_number: '+92 300 1234567', verified_name: 'Zari' }],
        }),
      );
    } else if (path === `${WABA}/message_templates` && request.method === 'POST') {
      response.end(JSON.stringify({ id: META_TEMPLATE, status: 'PENDING', category: 'MARKETING' }));
    } else {
      response.end(JSON.stringify({ success: true }));
    }
  });
}

describe.skipIf(!server)(
  "Admin GraphQL API: the shop's own WhatsApp templates (MKT-01, ADR-420)",
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
    let api: TestApi;
    let app: NestFastifyApplication;
    let graph: Server;
    const asked: string[] = [];
    const shop = newId();
    const tokens = { marketing: '', reader: '', settings: '' };

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

    async function webhook(body: unknown) {
      const raw = JSON.stringify(body);
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

    beforeAll(async () => {
      testDb = await createTestDatabase(server);
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`,
        [shop],
      );
      tokens.marketing = await issueToken(['write_marketing_events']);
      tokens.reader = await issueToken(['read_marketing_events']);
      tokens.settings = await issueToken(['write_settings']);
      graph = fakeGraph(asked);
      await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
      api = await startTestApi(testDb, {
        whatsapp: WHATSAPP,
        whatsAppSignup: {
          appId: '1234567890',
          appSecret: WHATSAPP.appSecret,
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

    it("writes a template, which Meta's webhook approves, and deletes it", async () => {
      const connected = await gql(
        tokens.settings,
        `mutation ($input: WhatsAppAccountConnectInput!) {
        whatsAppAccountConnect(input: $input) { userErrors { code } }
      }`,
        { input: { code: 'code', businessAccountId: WABA, phoneNumberId: NUMBER } },
      );
      expect(connected.data.whatsAppAccountConnect.userErrors).toEqual([]);

      const create = `mutation ($input: WhatsAppTemplateInput!) {
      whatsAppTemplateCreate(input: $input) {
        whatsAppTemplate { ${TEMPLATE} } userErrors { field code message }
      }
    }`;
      const input = {
        name: 'eid_sale',
        language: 'EN',
        body: 'Assalam-o-Alaikum {{1}}! Eid lawn is 20% off.',
        buttonText: 'Shop now',
        buttonUrl: 'https://zari.hatti.pk/collections/eid',
      };
      // Reading marketing is not writing it.
      const refused = await gql(tokens.reader, create, { input });
      expect(refused.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');

      const created = await gql(tokens.marketing, create, { input });
      const template = created.data.whatsAppTemplateCreate.whatsAppTemplate;
      expect(template).toEqual({
        id: expect.stringMatching(/^wtm_/),
        ...input,
        status: 'PENDING',
        rejectedReason: null,
      });
      expect(asked.at(-1)).toBe(`POST ${WABA}/message_templates`);

      const approved = await webhook({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: WABA,
            changes: [
              {
                field: 'message_template_status_update',
                value: {
                  event: 'APPROVED',
                  message_template_id: Number(META_TEMPLATE),
                  message_template_name: 'eid_sale',
                  message_template_language: 'en',
                  reason: 'NONE',
                },
              },
            ],
          },
        ],
      });
      expect(approved.json()).toEqual({ received: 1 });
      const listed = await gql(tokens.reader, `{ whatsAppTemplates { ${TEMPLATE} } }`);
      expect(listed.data.whatsAppTemplates).toEqual([{ ...template, status: 'APPROVED' }]);

      const deleted = await gql(
        tokens.marketing,
        `mutation ($id: ID!) {
        whatsAppTemplateDelete(id: $id) { deletedWhatsAppTemplateId userErrors { code } }
      }`,
        { id: template.id },
      );
      expect(deleted.data.whatsAppTemplateDelete).toEqual({
        deletedWhatsAppTemplateId: template.id,
        userErrors: [],
      });
      expect(asked.at(-1)).toBe(`DELETE ${WABA}/message_templates`);
      expect((await gql(tokens.reader, `{ whatsAppTemplates { id } }`)).data).toEqual({
        whatsAppTemplates: [],
      });
    });
  },
);
