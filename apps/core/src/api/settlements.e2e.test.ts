import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const STATEMENT = [
  'Safepay settlement report',
  'Transaction ID,Gross Amount (Rs),MDR,WHT,Net Amount',
  'track_A1,"2,000.00",50.00,20.00,"1,930.00"',
  'track_B2,1500,37.50,15,1447.50',
  'track_zz,900,22.5,9,868.5',
  'Total,4400,110,44,4246',
].join('\n');

const IMPORT = `mutation ($accountId: ID!, $csv: String, $reference: String, $dryRun: Boolean) {
  paymentSettlementImport(accountId: $accountId, csv: $csv, reference: $reference,
                          dryRun: $dryRun) {
    settlement { id gateway reference lineCount fees { amount } tax { amount } net { amount } }
    rows outcomes { matched differs unmatched repeated refund }
    issues { row transactionRef outcome orderId paid { amount } }
    rowErrorCount dryRun userErrors { field code }
  }
}`;

describe.skipIf(!server)("Admin GraphQL API: gateways' settlements (PAY-07, ADR-491)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const account = newId();
  const order = newId();
  const tokens = { write: '', read: '' };

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

  async function paidSession(orderId: string, gatewayRef: string, amount: number) {
    await admin.query(
      `INSERT INTO payments.sessions (shop_id, id, account_id, order_id, environment, amount,
                                      currency, status, gateway_ref, paid_amount, paid_through,
                                      paid_at)
       VALUES ($1, $2, $3, $4, 'production', $5, 'PKR', 'paid', $6, $5, 'webhook', now())`,
      [shop, newId(), account, orderId, amount, gatewayRef],
    );
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    await admin.query(
      `INSERT INTO payments.gateway_accounts (shop_id, id, gateway, environment, credentials,
                                              credentials_hint)
       VALUES ($1, $2, 'safepay', 'production', 'sealed', 'abcd')`,
      [shop, account],
    );
    await paidSession(order, 'track_A1', 200000);
    await paidSession(newId(), 'track_B2', 160000);
    tokens.write = await issueToken(['write_orders']);
    tokens.read = await issueToken(['read_orders']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('imports a statement, matches it to payments, lists it, and keeps its lines', async () => {
    const accountId = toPublicId('paymentGatewayAccount', account);
    const denied = await gql(tokens.read, IMPORT, { accountId, csv: STATEMENT });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');

    const dry = await data(tokens.write, IMPORT, { accountId, csv: STATEMENT, dryRun: true });
    expect(dry).toMatchObject({
      settlement: null,
      rows: 4,
      outcomes: { matched: 1, differs: 1, unmatched: 1, repeated: 0, refund: 0 },
      rowErrorCount: 0,
      dryRun: true,
      userErrors: [],
    });
    expect(dry.issues.map((line: Json) => [line.transactionRef, line.outcome])).toEqual([
      ['track_B2', 'DIFFERS'],
      ['track_zz', 'UNMATCHED'],
    ]);

    const made = await data(tokens.write, IMPORT, {
      accountId,
      csv: STATEMENT,
      reference: 'SP-2026-10-15',
    });
    expect(made.settlement).toMatchObject({
      gateway: 'safepay',
      reference: 'SP-2026-10-15',
      lineCount: 3,
      fees: { amount: '110.00' },
      tax: { amount: '44.00' },
      net: { amount: '4246.00' },
    });
    const again = await data(tokens.write, IMPORT, {
      accountId,
      csv: STATEMENT,
      reference: 'SP-2026-10-15',
    });
    expect(again.userErrors).toEqual([{ field: ['reference'], code: 'TAKEN' }]);
    const elsewhere = await data(tokens.write, IMPORT, {
      accountId: toPublicId('paymentGatewayAccount', newId()),
      csv: STATEMENT,
    });
    expect(elsewhere.userErrors).toEqual([{ field: ['accountId'], code: 'NOT_FOUND' }]);

    const listed = await data(tokens.read, '{ paymentSettlements { id reference lineCount } }');
    expect(listed).toEqual([{ id: made.settlement.id, reference: 'SP-2026-10-15', lineCount: 3 }]);
    const one = await data(
      tokens.read,
      `query ($id: ID!) { paymentSettlement(id: $id) {
         all: lines { transactionRef outcome }
         matched: lines(outcome: MATCHED) { transactionRef orderId gross { amount } }
       } }`,
      { id: made.settlement.id },
    );
    expect(one.all.map((line: Json) => line.outcome)).toEqual(['MATCHED', 'DIFFERS', 'UNMATCHED']);
    expect(one.matched).toEqual([
      {
        transactionRef: 'track_A1',
        orderId: toPublicId('order', order),
        gross: { amount: '2000.00' },
      },
    ]);
  });
});
