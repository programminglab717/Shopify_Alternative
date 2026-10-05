import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
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

interface GraphQLResponse {
  data?: Record<string, Json> | null;
  errors?: { message: string; path?: string[]; extensions?: { code?: string } }[];
}

const SCOPES = [
  'write_products',
  'write_orders',
  'write_customers',
  'read_store_credit_accounts',
  'write_store_credit_account_transactions',
];

const ADDRESS = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  address1: 'House 12, Street 4, Block 5',
  city: 'khi',
};

const ACCOUNT_FIELDS = `
  id balance { amount currencyCode formatted }
  owner { id name }
  transactions(first: 10) {
    nodes {
      kind event amount { amount } balanceAfterTransaction { amount } expiresAt
      remainingAmount { amount } orderId refundId note account { id }
    }
    pageInfo { hasNextPage }
  }
`;

const CREDIT = `
  mutation ($id: ID!, $input: StoreCreditAccountCreditInput!) {
    storeCreditAccountCredit(id: $id, creditInput: $input) {
      storeCreditAccountTransaction {
        kind event amount { formatted } note account { id balance { formatted } }
      }
      userErrors { field code message }
    }
  }`;

const DEBIT = `
  mutation ($id: ID!, $input: StoreCreditAccountDebitInput!) {
    storeCreditAccountDebit(id: $id, debitInput: $input) {
      storeCreditAccountTransaction {
        kind amount { formatted } balanceAfterTransaction { formatted } account { id }
      }
      userErrors { field code message }
    }
  }`;

describe.skipIf(!server)('Admin GraphQL API: store credit (ORD-09, ADR-184)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', aOrders: '', aReader: '', b: '' };
  let kurta = '';

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
    );
    return token;
  }

  async function gql(
    token: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<GraphQLResponse> {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
      payload: { query, variables },
    });
    return response.json() as GraphQLResponse;
  }

  /** Runs a query or mutation and returns its first field, failing the test on GraphQL errors. */
  async function call(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, SCOPES);
    tokens.aOrders = await issueToken(shopA, ['write_orders', 'write_customers']);
    tokens.aReader = await issueToken(shopA, ['read_store_credit_accounts']);
    tokens.b = await issueToken(shopB, SCOPES);
    api = await startTestApi(testDb);
    app = api.app;
    const created = await call(
      tokens.a,
      `mutation {
         productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,000" }] }) {
           product { variants { id } }
         }
       }`,
    );
    kurta = created.product.variants[0].id;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("refunds an order as store credit, and credits and debits it by hand, as Shopify's API does", async () => {
    const placed = await call(
      tokens.a,
      `mutation ($input: OrderCreateInput!) {
         orderCreate(input: $input) { order { id customer { id } } userErrors { code } }
       }`,
      {
        input: {
          lineItems: [{ variantId: kurta, quantity: 1 }],
          shippingAddress: ADDRESS,
          paymentMethod: 'PREPAID',
        },
      },
    );
    const orderId = placed.order.id as string;
    const customerId = placed.order.customer.id as string;
    const REFUND = `
      mutation ($id: ID!, $input: OrderRefundInput!) {
        orderRefund(id: $id, input: $input) {
          refund { id method reference amount { formatted } }
          userErrors { field code message }
        }
      }`;
    const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const input = {
      amount: '1500',
      method: 'STORE_CREDIT',
      note: 'Kept as credit',
      storeCreditExpiresAt: expiresAt,
    };
    // Store credit is given only with its scope, refund or not.
    const denied = await gql(tokens.aOrders, REFUND, { id: orderId, input });
    expect(denied.errors?.[0]).toMatchObject({
      extensions: { code: 'ACCESS_DENIED' },
      message: expect.stringContaining('write_store_credit_account_transactions'),
    });
    const refunded = await call(tokens.a, REFUND, { id: orderId, input });
    expect(refunded).toEqual({
      refund: {
        id: expect.stringMatching(/^rfd_/),
        method: 'STORE_CREDIT',
        reference: expect.stringMatching(/^sct_/),
        amount: { formatted: 'Rs 1,500' },
      },
      userErrors: [],
    });

    const credited = await call(tokens.a, CREDIT, {
      id: customerId,
      input: { creditAmount: { amount: '500', currencyCode: 'PKR' }, note: 'Sorry for the wait' },
    });
    expect(credited).toEqual({
      storeCreditAccountTransaction: {
        kind: 'CREDIT',
        event: 'ADJUSTMENT',
        amount: { formatted: 'Rs 500' },
        note: 'Sorry for the wait',
        account: { id: expect.stringMatching(/^sca_/), balance: { formatted: 'Rs 2,000' } },
      },
      userErrors: [],
    });
    const accountId = credited.storeCreditAccountTransaction.account.id as string;

    const short = await call(tokens.a, DEBIT, {
      id: accountId,
      input: { debitAmount: { amount: '2000.01', currencyCode: 'PKR' } },
    });
    expect(short).toEqual({
      storeCreditAccountTransaction: null,
      userErrors: [
        {
          field: ['debitInput', 'debitAmount', 'amount'],
          code: 'INSUFFICIENT_FUNDS',
          message: 'This customer has Rs 2,000 of store credit',
        },
      ],
    });
    const debited = await call(tokens.a, DEBIT, {
      id: accountId,
      input: { debitAmount: { amount: '700', currencyCode: 'PKR' } },
    });
    expect(debited.storeCreditAccountTransaction).toEqual({
      kind: 'DEBIT',
      amount: { formatted: '-Rs 700' },
      balanceAfterTransaction: { formatted: 'Rs 1,300' },
      account: { id: accountId },
    });

    const customer = await call(
      tokens.a,
      `query ($id: ID!) {
         customer(id: $id) {
           storeCreditAccounts(first: 5) { nodes { ${ACCOUNT_FIELDS} } pageInfo { hasNextPage } }
         }
       }`,
      { id: customerId },
    );
    expect(customer.storeCreditAccounts).toEqual({
      nodes: [
        {
          id: accountId,
          balance: { amount: '1300.00', currencyCode: 'PKR', formatted: 'Rs 1,300' },
          owner: { id: customerId, name: 'Ayesha Khan' },
          transactions: {
            nodes: [
              {
                kind: 'DEBIT',
                event: 'ADJUSTMENT',
                amount: { amount: '-700.00' },
                balanceAfterTransaction: { amount: '1300.00' },
                expiresAt: null,
                remainingAmount: null,
                orderId: null,
                refundId: null,
                note: '',
                account: { id: accountId },
              },
              {
                kind: 'CREDIT',
                event: 'ADJUSTMENT',
                amount: { amount: '500.00' },
                balanceAfterTransaction: { amount: '2000.00' },
                expiresAt: null,
                remainingAmount: { amount: '500.00' },
                orderId: null,
                refundId: null,
                note: 'Sorry for the wait',
                account: { id: accountId },
              },
              {
                kind: 'CREDIT',
                event: 'ORDER_REFUND',
                amount: { amount: '1500.00' },
                balanceAfterTransaction: { amount: '1500.00' },
                expiresAt,
                // Spent first, as it expires and the other does not.
                remainingAmount: { amount: '800.00' },
                orderId,
                refundId: refunded.refund.id,
                note: 'Kept as credit',
                account: { id: accountId },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      ],
      pageInfo: { hasNextPage: false },
    });

    // An app that may see balances sees no ledger nor whose they are, and changes nothing.
    const reader = await gql(
      tokens.aReader,
      `query ($id: ID!) { storeCreditAccount(id: $id) { balance { formatted } } }`,
      { id: accountId },
    );
    expect(reader.data?.storeCreditAccount).toEqual({ balance: { formatted: 'Rs 1,300' } });
    for (const field of ['transactions(first: 1) { nodes { kind } }', 'owner { id }']) {
      const hidden = await gql(
        tokens.aReader,
        `query ($id: ID!) { storeCreditAccount(id: $id) { ${field} } }`,
        { id: accountId },
      );
      expect(hidden.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    }
    const readOnly = await gql(tokens.aReader, CREDIT, {
      id: accountId,
      input: { creditAmount: { amount: '1', currencyCode: 'PKR' } },
    });
    expect(readOnly.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');

    // Another shop finds none of it; an ID of neither an account nor a customer is no account.
    const elsewhere = await call(
      tokens.b,
      `query ($id: ID!) { storeCreditAccount(id: $id) { id } }`,
      { id: accountId },
    );
    expect(elsewhere).toBeNull();
    const fromB = await call(tokens.b, CREDIT, {
      id: accountId,
      input: { creditAmount: { amount: '1', currencyCode: 'PKR' } },
    });
    expect(fromB.userErrors).toEqual([
      { field: ['id'], code: 'NOT_FOUND', message: 'Store credit account not found' },
    ]);
    const wrongKind = await call(tokens.a, CREDIT, {
      id: orderId,
      input: { creditAmount: { amount: '1', currencyCode: 'PKR' } },
    });
    expect(wrongKind.userErrors).toEqual([
      { field: ['id'], code: 'NOT_FOUND', message: 'Store credit account not found' },
    ]);
  });
});
