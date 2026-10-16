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

const WABA = '102290129340398';
const NUMBER = '106540352242922';

/** Meta's Graph API as connecting a number and sending a template ask it. */
function fakeGraph(): Server {
  return createServer((request, response) => {
    const path = new URL(request.url!, 'http://graph').pathname.replace(/^\/v26\.0\//, '');
    response.writeHead(200, { 'content-type': 'application/json' });
    if (path === 'oauth/access_token') {
      response.end(JSON.stringify({ access_token: 'EAAQbusinessToken'.padEnd(80, 'x') }));
    } else if (path === `${WABA}/phone_numbers`) {
      response.end(
        JSON.stringify({
          data: [{ id: NUMBER, display_phone_number: '+92 300 1234567', verified_name: 'Zari' }],
        }),
      );
    } else if (path === `${WABA}/message_templates`) {
      response.end(JSON.stringify({ id: '594425479261596', status: 'APPROVED' }));
    } else {
      response.end(JSON.stringify({ success: true }));
    }
  });
}

describe.skipIf(!server)('Admin GraphQL API: marketing automations (MKT-04, ADR-425)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  let graph: Server;
  const shop = newId();
  const tokens = { owner: '', reader: '' };

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

  async function data(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    // Three customers: two agreed to hear on WhatsApp, one of them a VIP.
    for (const [phone, consent, tags] of [
      ['+923001110001', 'subscribed', ['vip']],
      ['+923001110002', 'subscribed', []],
      ['+923001110003', 'unsubscribed', ['vip']],
    ] as const) {
      await admin.query(
        `WITH added AS (
           INSERT INTO customers.customers (shop_id, id, phone, whatsapp_consent, tags)
           VALUES ($1, platform.uuidv7(), $2, $3, $4)
           RETURNING shop_id, id, phone)
         INSERT INTO customers.customer_phones (shop_id, phone, customer_id)
         SELECT shop_id, phone, id FROM added`,
        [shop, phone, consent, tags],
      );
    }
    tokens.owner = await issueToken(['write_settings', 'write_marketing_events', 'write_segments']);
    tokens.reader = await issueToken(['read_marketing_events']);
    graph = fakeGraph();
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

  it('lists the automations, off at first, and turns one on with an approved template', async () => {
    await data(
      tokens.owner,
      `mutation ($input: WhatsAppAccountConnectInput!) {
        whatsAppAccountConnect(input: $input) { userErrors { code } }
      }`,
      { input: { code: 'code', businessAccountId: WABA, phoneNumberId: NUMBER } },
    );
    const template = await data(
      tokens.owner,
      `mutation ($input: WhatsAppTemplateInput!) {
        whatsAppTemplateCreate(input: $input) { whatsAppTemplate { id status } }
      }`,
      { input: { name: 'welcome_offer', language: 'EN', body: 'Welcome {{1}}! 10% off.' } },
    );

    const list = `{
      marketingAutomations { kind enabled afterDays creditAmount { formatted } template { name } }
    }`;
    expect(await data(tokens.reader, list)).toEqual([
      { kind: 'WELCOME', enabled: false, afterDays: null, creditAmount: null, template: null },
      { kind: 'WIN_BACK', enabled: false, afterDays: 60, creditAmount: null, template: null },
      {
        kind: 'BACK_IN_STOCK',
        enabled: false,
        afterDays: null,
        creditAmount: null,
        template: null,
      },
      // COD to prepaid offers Rs 100 of store credit until the shop says otherwise (ADR-432).
      {
        kind: 'COD_PREPAID',
        enabled: false,
        afterDays: null,
        creditAmount: { formatted: 'Rs 100' },
        template: null,
      },
      { kind: 'CASHBACK', enabled: false, afterDays: null, creditAmount: null, template: null },
    ]);

    const update = `mutation ($kind: MarketingAutomationKind!, $input: MarketingAutomationInput!) {
      marketingAutomationUpdate(kind: $kind, input: $input) {
        marketingAutomation { kind enabled afterDays template { name } }
        userErrors { field code message }
      }
    }`;
    const refused = await gql(tokens.reader, update, { kind: 'WELCOME', input: { enabled: true } });
    expect(refused.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    expect(await data(tokens.owner, update, { kind: 'WELCOME', input: { enabled: true } })).toEqual(
      {
        marketingAutomation: null,
        userErrors: [
          {
            field: ['input', 'templateId'],
            code: 'BLANK',
            message: 'Choose the template it sends',
          },
        ],
      },
    );
    expect(
      await data(tokens.owner, update, {
        kind: 'WIN_BACK',
        input: { enabled: true, templateId: template.whatsAppTemplate.id, afterDays: 90 },
      }),
    ).toEqual({
      marketingAutomation: {
        kind: 'WIN_BACK',
        enabled: true,
        afterDays: 90,
        template: { name: 'welcome_offer' },
      },
      userErrors: [],
    });
    expect((await data(tokens.reader, list))[1]).toMatchObject({ kind: 'WIN_BACK', enabled: true });

    // Cashback: a share of delivered orders in store credit, from Hatti's number (ADR-453).
    expect(
      await data(
        tokens.owner,
        `mutation ($input: MarketingAutomationInput!) {
          marketingAutomationUpdate(kind: CASHBACK, input: $input) {
            marketingAutomation { kind enabled cashbackPercent creditDays template { name } }
            userErrors { field code message }
          }
        }`,
        { input: { enabled: true, cashbackPercent: 3, creditDays: 30 } },
      ),
    ).toEqual({
      marketingAutomation: {
        kind: 'CASHBACK',
        enabled: true,
        cashbackPercent: 3,
        creditDays: 30,
        template: null,
      },
      userErrors: [],
    });
  });
});
