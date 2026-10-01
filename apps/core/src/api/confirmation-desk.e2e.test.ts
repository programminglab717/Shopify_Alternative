import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const QUEUE = `{
  confirmationQueue(first: 10) {
    nodes { order { name } unansweredCalls lastCall { outcome note } claimedByYou }
    dueCount laterCount
  }
}`;

const NEXT = `mutation {
  confirmationQueueNext { item { order { id name } claimedUntil claimedByYou } }
}`;

const CALL = `mutation ($id: ID!, $outcome: ConfirmationCallOutcome!, $callBackAt: DateTime, $note: String) {
  orderConfirmationCall(id: $id, outcome: $outcome, callBackAt: $callBackAt, note: $note) {
    order { name stage confirmationStatus } userErrors { field code message }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: the Confirmation Desk', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { ali: '', sana: '', reader: '', settings: '' };

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
    tokens.ali = await issueToken(['write_products', 'write_orders']);
    tokens.sana = await issueToken(['write_orders']);
    tokens.reader = await issueToken(['read_orders']);
    tokens.settings = await issueToken(['read_settings', 'write_settings']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('deals orders to agents one each, and keeps the calls that did not settle them', async () => {
    const created = await gql(
      tokens.ali,
      `mutation {
        productCreate(input: { title: "Shawl", status: ACTIVE, variants: [{ price: "5,000" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const variantId = created.data?.productCreate.product.variants[0].id;
    for (const phone of ['0300 1234567', '0333 7654321']) {
      await gql(
        tokens.ali,
        `mutation ($variantId: ID!, $phone: String!) {
          orderCreate(input: {
            lineItems: [{ variantId: $variantId, quantity: 1 }],
            shippingAddress: { name: "Ayesha Khan", phone: $phone,
                               address1: "House 12, Street 4", city: "Lahore" }
          }) { order { id } }
        }`,
        { variantId, phone },
      );
    }

    expect((await gql(tokens.reader, QUEUE)).data?.confirmationQueue).toEqual({
      nodes: [
        { order: { name: '#1001' }, unansweredCalls: 0, lastCall: null, claimedByYou: false },
        { order: { name: '#1002' }, unansweredCalls: 0, lastCall: null, claimedByYou: false },
      ],
      dueCount: 2,
      laterCount: 0,
    });

    // One each, never the same.
    const ali = (await gql(tokens.ali, NEXT)).data?.confirmationQueueNext.item;
    const sana = (await gql(tokens.sana, NEXT)).data?.confirmationQueueNext.item;
    expect([ali.order.name, sana.order.name]).toEqual(['#1001', '#1002']);
    expect(ali).toMatchObject({ claimedUntil: expect.any(String), claimedByYou: true });

    // No answer: due again later, and let go.
    const missed = await gql(tokens.ali, CALL, {
      id: ali.order.id,
      outcome: 'NO_ANSWER',
      note: 'Rang twice',
    });
    expect(missed.data?.orderConfirmationCall).toEqual({
      order: { name: '#1001', stage: 'NEEDS_CONFIRMATION', confirmationStatus: 'PENDING' },
      userErrors: [],
    });
    expect((await gql(tokens.reader, QUEUE)).data?.confirmationQueue).toMatchObject({
      nodes: [{ order: { name: '#1002' } }],
      dueCount: 1,
      laterCount: 1,
    });
    const noTime = await gql(tokens.ali, CALL, { id: ali.order.id, outcome: 'CALL_BACK' });
    expect(noTime.data?.orderConfirmationCall.userErrors).toEqual([
      { field: ['callBackAt'], code: 'BLANK', message: 'Say when to call back' },
    ]);

    // Confirmed, the other leaves the queue: nothing is due.
    await gql(
      tokens.sana,
      `mutation ($id: ID!) { orderConfirm(id: $id) { userErrors { code } } }`,
      {
        id: sana.order.id,
      },
    );
    expect((await gql(tokens.sana, NEXT)).data?.confirmationQueueNext.item).toBeNull();

    // Reading the queue is not taking from it.
    const denied = await gql(tokens.reader, NEXT);
    expect(denied.errors?.[0]?.extensions).toMatchObject({
      code: 'ACCESS_DENIED',
      requiredAccess: ['write_orders'],
    });

    // What each agent did, apps by their access tokens: the one who settled an order first.
    const agents = await gql(
      tokens.reader,
      `query ($from: DateTime!, $before: DateTime!) {
        confirmationAgents(from: $from, before: $before) {
          kind id confirmed cancelled confirmationRate
          calls { noAnswer callBack wrongNumber }
          activeHours confirmationsPerHour
          delivery { shipped returnRate }
        }
      }`,
      {
        from: new Date(Date.now() - 3_600_000).toISOString(),
        before: new Date(Date.now() + 3_600_000).toISOString(),
      },
    );
    const nothingShipped = { shipped: 0, returnRate: null };
    expect(agents.data?.confirmationAgents).toEqual([
      {
        kind: 'APP',
        id: expect.stringMatching(/^tok_/),
        confirmed: 1,
        cancelled: 0,
        confirmationRate: 1,
        calls: { noAnswer: 0, callBack: 0, wrongNumber: 0 },
        activeHours: 1,
        confirmationsPerHour: 1,
        delivery: nothingShipped,
      },
      {
        kind: 'APP',
        id: expect.stringMatching(/^tok_/),
        confirmed: 0,
        cancelled: 0,
        confirmationRate: null,
        calls: { noAnswer: 1, callBack: 0, wrongNumber: 0 },
        activeHours: 1,
        confirmationsPerHour: 0,
        delivery: nothingShipped,
      },
    ]);
  });
  it("keeps the shop's calling hours and first-call target, as the queue says", async () => {
    // Hours that are not now in Karachi.
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        hourCycle: 'h23',
        timeZone: 'Asia/Karachi',
      }).format(new Date()),
    );
    const callingHours =
      hour < 12 ? { opens: '13:00', closes: '14:00' } : { opens: '01:00', closes: '02:00' };
    const set = await gql(
      tokens.settings,
      `mutation ($input: OrderSettingsInput!) {
        orderSettingsUpdate(input: $input) {
          orderSettings { callingHours { opens closes } firstCallMinutes cancelUnreachableAfterDays }
          userErrors { field code message }
        }
      }`,
      { input: { callingHours, firstCallMinutes: 5, cancelUnreachableAfterDays: 3 } },
    );
    expect(set.data?.orderSettingsUpdate).toEqual({
      orderSettings: { callingHours, firstCallMinutes: 5, cancelUnreachableAfterDays: 3 },
      userErrors: [],
    });

    // An order placed two days ago and never called has waited longer than five minutes of them.
    const variantId = (
      await gql(
        tokens.ali,
        `mutation {
          productCreate(input: { title: "Dupatta", status: ACTIVE, variants: [{ price: "1,500" }] }) {
            product { variants { id } }
          }
        }`,
      )
    ).data?.productCreate.product.variants[0].id;
    const placed = await gql(
      tokens.ali,
      `mutation ($variantId: ID!) {
        orderCreate(input: {
          lineItems: [{ variantId: $variantId, quantity: 1 }],
          shippingAddress: { name: "Sadia Noor", phone: "0345 1112233",
                             address1: "House 7, Street 2", city: "Lahore" }
        }) { order { name } }
      }`,
      { variantId },
    );
    const name = placed.data?.orderCreate.order.name;
    await admin.query(
      `UPDATE orders.orders SET created_at = now() - interval '2 days'
        WHERE shop_id = $1 AND number = $2`,
      [shop, Number(name.slice(1))],
    );
    const queue = (
      await gql(
        tokens.reader,
        `{ confirmationQueue { callingNow callingOpensAt overdueCount nodes { order { name } overdue } } }`,
      )
    ).data?.confirmationQueue;
    expect(queue).toMatchObject({
      callingNow: false,
      callingOpensAt: expect.any(String),
      overdueCount: 1,
      nodes: [{ order: { name }, overdue: true }],
    });
    expect(new Date(queue.callingOpensAt).getTime()).toBeGreaterThan(Date.now());
    // Outside them, nothing is dealt, and the payload says when they open.
    const next = await gql(
      tokens.ali,
      `mutation { confirmationQueueNext { item { order { name } } callingOpensAt } }`,
    );
    expect(next.data?.confirmationQueueNext).toEqual({
      item: null,
      callingOpensAt: queue.callingOpensAt,
    });
  });
});
