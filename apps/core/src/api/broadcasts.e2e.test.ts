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

const BROADCAST = `id name templateName templateLanguage segmentName status recipients
  counts { pending sent delivered read failed skipped }`;

describe.skipIf(!server)('Admin GraphQL API: WhatsApp broadcasts (MKT-01, ADR-421)', () => {
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

  it('estimates a broadcast, schedules it to a segment, lists it and cancels it', async () => {
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
      { input: { name: 'eid_sale', language: 'EN', body: 'Eid Mubarak {{1}}! 20% off.' } },
    );
    expect(template.whatsAppTemplate.status).toBe('APPROVED');
    const segment = await data(
      tokens.owner,
      `mutation ($name: String!, $query: String!) {
        segmentCreate(name: $name, query: $query) { segment { id } }
      }`,
      { name: 'VIPs', query: "customer_tags CONTAINS 'vip'" },
    );

    const estimate = `query ($segmentId: ID) {
      broadcastEstimate(segmentId: $segmentId) {
        recipients pricePerMessage { formatted } cost { amount formatted }
      }
    }`;
    expect(await data(tokens.reader, estimate)).toEqual({
      recipients: 2,
      pricePerMessage: { formatted: 'Rs 14.58' },
      cost: { amount: '29.16', formatted: 'Rs 29.16' },
    });
    expect(await data(tokens.reader, estimate, { segmentId: segment.segment.id })).toMatchObject({
      recipients: 1,
      cost: { amount: '14.58' },
    });

    const create = `mutation ($input: BroadcastInput!) {
      broadcastCreate(input: $input) { broadcast { ${BROADCAST} } userErrors { field code } }
    }`;
    const input = {
      name: 'Eid sale',
      templateId: template.whatsAppTemplate.id,
      segmentId: segment.segment.id,
      sendAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const refused = await gql(tokens.reader, create, { input });
    expect(refused.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const created = await data(tokens.owner, create, { input });
    expect(created).toEqual({
      broadcast: {
        id: expect.stringMatching(/^bdc_/),
        name: 'Eid sale',
        templateName: 'eid_sale',
        templateLanguage: 'EN',
        segmentName: 'VIPs',
        status: 'SCHEDULED',
        recipients: 0,
        counts: { pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 },
      },
      userErrors: [],
    });

    const listed = await data(tokens.reader, `{ broadcasts(first: 5) { nodes { id status } } }`);
    expect(listed.nodes).toEqual([{ id: created.broadcast.id, status: 'SCHEDULED' }]);
    const cancelled = await data(
      tokens.owner,
      `mutation ($id: ID!) { broadcastCancel(id: $id) { broadcast { status } userErrors { code } } }`,
      { id: created.broadcast.id },
    );
    expect(cancelled).toEqual({ broadcast: { status: 'CANCELLED' }, userErrors: [] });
    expect(
      (
        await data(tokens.reader, `query ($id: ID!) { broadcast(id: $id) { status } }`, {
          id: created.broadcast.id,
        })
      ).status,
    ).toBe('CANCELLED');
  });
});
