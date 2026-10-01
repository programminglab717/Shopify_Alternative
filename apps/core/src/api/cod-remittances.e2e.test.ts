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

const IMPORT = `mutation ($csv: String!, $reference: String, $dryRun: Boolean) {
  codRemittanceImport(courier: "Leopards", csv: $csv, reference: $reference, dryRun: $dryRun) {
    remittance { id courier reference lineCount received { amount } issueCount }
    rows
    outcomes { received short over unmatched repeated notOwed charged }
    collected { amount } charges { amount } tax { amount } paid { amount } received { amount }
    issues { row trackingNumber outcome orderName owed { amount } received { amount } }
    rowErrorCount
    dryRun
    userErrors { field code message }
  }
}`;

describe.skipIf(!server)("Admin GraphQL API: couriers' remittances", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
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
    tokens.owner = await issueToken(['write_products', 'write_orders']);
    tokens.reader = await issueToken(['read_orders']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("receives a courier's statement on the orders of its parcels", async () => {
    const created = await gql(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Shawl", status: ACTIVE, variants: [{ price: "5,000" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const variantId = created.data?.productCreate.product.variants[0].id;
    const ids: string[] = [];
    for (const number of ['LE7001', 'LE7002']) {
      const placed = await gql(
        tokens.owner,
        `mutation ($variantId: ID!) {
          orderCreate(input: {
            lineItems: [{ variantId: $variantId, quantity: 1 }],
            shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                               address1: "House 12, Street 4", city: "Lahore" }
          }) { order { id } userErrors { code message } }
        }`,
        { variantId },
      );
      const id = placed.data?.orderCreate.order.id;
      ids.push(id);
      await gql(
        tokens.owner,
        `mutation ($id: ID!) { orderConfirm(id: $id) { userErrors { code } } }`,
        {
          id,
        },
      );
      const fulfilled = await gql(
        tokens.owner,
        `mutation ($id: ID!, $number: String!) {
          orderFulfill(id: $id, input: { trackingInfo: { company: "Leopards", number: $number } }) {
            fulfillment { id } userErrors { code message }
          }
        }`,
        { id, number },
      );
      await gql(
        tokens.owner,
        `mutation ($id: ID!) { fulfillmentMarkDelivered(id: $id) { userErrors { code } } }`,
        { id: fulfilled.data?.orderFulfill.fulfillment.id },
      );
    }
    const csv = [
      'CN #,COD Amount,Delivery Charges,WHT,Net Payable',
      'LE7001,"5,000",250,50,"4,700"',
      'LE7002,"4,000",250,40,"3,710"',
      'LE7999,"1,000",250,10,740',
    ].join('\n');

    // A look first, which writes nothing.
    const dry = (await gql(tokens.owner, IMPORT, { csv, dryRun: true })).data?.codRemittanceImport;
    expect(dry).toMatchObject({
      remittance: null,
      rows: 3,
      outcomes: { received: 1, short: 1, unmatched: 1 },
      received: { amount: '9000.00' },
      dryRun: true,
      userErrors: [],
    });

    const imported = (await gql(tokens.owner, IMPORT, { csv, reference: 'LHR-7' })).data
      ?.codRemittanceImport;
    expect(imported).toMatchObject({
      remittance: {
        courier: 'Leopards',
        reference: 'LHR-7',
        lineCount: 3,
        received: { amount: '9000.00' },
        issueCount: 2,
      },
      outcomes: {
        received: 1,
        short: 1,
        over: 0,
        unmatched: 1,
        repeated: 0,
        notOwed: 0,
        charged: 0,
      },
      collected: { amount: '10000.00' },
      charges: { amount: '750.00' },
      tax: { amount: '100.00' },
      paid: { amount: '9150.00' },
      issues: [
        {
          row: 3,
          trackingNumber: 'LE7002',
          outcome: 'SHORT',
          orderName: '#1002',
          owed: { amount: '5000.00' },
          received: { amount: '4000.00' },
        },
        { row: 4, outcome: 'UNMATCHED', orderName: null, owed: null },
      ],
      dryRun: false,
      userErrors: [],
    });
    // The first paid in full; the second in part, its Rs 1,000 still owed.
    const paid = await gql(
      tokens.owner,
      `query ($first: ID!, $second: ID!) {
        first: order(id: $first) { financialStatus amountPaid { amount } stage }
        second: order(id: $second) { financialStatus amountPaid { amount } stage }
        codReceivables { owed { count amount { amount } } }
      }`,
      { first: ids[0], second: ids[1] },
    );
    expect(paid.data).toEqual({
      first: { financialStatus: 'PAID', amountPaid: { amount: '5000.00' }, stage: 'COMPLETED' },
      second: {
        financialStatus: 'PARTIALLY_PAID',
        amountPaid: { amount: '4000.00' },
        stage: 'DELIVERED',
      },
      codReceivables: { owed: { count: 1, amount: { amount: '1000.00' } } },
    });

    // Read back, by those who may; imported again by its reference, refused.
    const id = imported.remittance.id;
    const read = await gql(
      tokens.reader,
      `query ($id: ID!) {
        codRemittances(first: 5) { nodes { id issueCount } }
        codRemittance(id: $id) {
          lines(issuesOnly: true) { row outcome }
          all: lines(first: 1, afterRow: 2) { row trackingNumber outcome }
        }
      }`,
      { id },
    );
    expect(read.data).toEqual({
      codRemittances: { nodes: [{ id, issueCount: 2 }] },
      codRemittance: {
        lines: [
          { row: 3, outcome: 'SHORT' },
          { row: 4, outcome: 'UNMATCHED' },
        ],
        all: [{ row: 3, trackingNumber: 'LE7002', outcome: 'SHORT' }],
      },
    });
    const again = (await gql(tokens.owner, IMPORT, { csv, reference: 'LHR-7' })).data
      ?.codRemittanceImport;
    expect(again.userErrors).toEqual([
      {
        field: ['reference'],
        code: 'TAKEN',
        message: 'The statement LHR-7 from Leopards has been imported already',
      },
    ]);
    // Reading is not receiving: an app needs write_orders to import.
    const denied = await gql(tokens.reader, IMPORT, { csv, dryRun: true });
    expect(denied.errors?.[0]?.extensions).toMatchObject({
      code: 'ACCESS_DENIED',
      requiredAccess: ['write_orders'],
    });
  });
});
