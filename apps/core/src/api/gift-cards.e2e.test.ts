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
  errors?: { message: string; extensions?: { code?: string } }[];
}

const CARD_FIELDS = `
  id lastCharacters maskedCode initialValue { formatted } balance { amount currencyCode }
  expiresOn expired enabled note customer { name }
  transactions(first: 10) { nodes { kind amount { amount } balanceAfterTransaction { amount } } }
`;

const CREATE = `
  mutation ($input: GiftCardCreateInput!) {
    giftCardCreate(input: $input) {
      giftCard { ${CARD_FIELDS} }
      giftCardCode
      userErrors { field code message }
    }
  }`;

describe.skipIf(!server)('Admin GraphQL API: gift cards (CAT-12, PAY-13, ADR-448)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const shopB = newId();
  const tokens = { a: '', reader: '', b: '' };

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
    tokens.a = await issueToken(shopA, ['write_gift_cards', 'write_customers']);
    tokens.reader = await issueToken(shopA, ['read_gift_cards']);
    tokens.b = await issueToken(shopB, ['write_gift_cards', 'read_customers']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('issues a card with its code given once, credits and debits it, and deactivates it', async () => {
    const customer = await call(
      tokens.a,
      `mutation { customerCreate(input: { phone: "0300 1234567", name: "Ayesha Khan" }) {
         customer { id } } }`,
    );
    const issued = await call(tokens.a, CREATE, {
      input: { initialValue: '5000', note: 'Eid', customerId: customer.customer.id },
    });
    expect(issued.userErrors).toEqual([]);
    expect(issued.giftCardCode).toMatch(/^(\w{4} ){3}\w{4}$/);
    const last = issued.giftCardCode.slice(-4);
    expect(issued.giftCard).toMatchObject({
      lastCharacters: last,
      maskedCode: `•••• •••• •••• ${last}`,
      initialValue: { formatted: 'Rs 5,000' },
      balance: { amount: '5000.00', currencyCode: 'PKR' },
      expiresOn: null,
      expired: false,
      enabled: true,
      note: 'Eid',
      customer: { name: 'Ayesha Khan' },
      transactions: { nodes: [{ kind: 'ISSUE', amount: { amount: '5000.00' } }] },
    });
    const id = issued.giftCard.id as string;
    expect(id).toMatch(/^gc_/);

    // Its code is never given again: the card itself has only its last characters.
    const found = await call(tokens.reader, `{ giftCard(id: "${id}") { lastCharacters } }`);
    expect(found).toEqual({ lastCharacters: last });

    const debited = await call(
      tokens.a,
      `mutation ($id: ID!) {
         giftCardDebit(id: $id, debitInput: { debitAmount: { amount: "1200", currencyCode: PKR },
                                              note: "Paid at the shop" }) {
           giftCardTransaction { kind amount { amount } balanceAfterTransaction { amount } note }
           giftCard { balance { amount } }
           userErrors { field code message }
         } }`,
      { id },
    );
    expect(debited).toEqual({
      giftCardTransaction: {
        kind: 'DEBIT',
        amount: { amount: '-1200.00' },
        balanceAfterTransaction: { amount: '3800.00' },
        note: 'Paid at the shop',
      },
      giftCard: { balance: { amount: '3800.00' } },
      userErrors: [],
    });
    const refused = await call(
      tokens.a,
      `mutation ($id: ID!) {
         giftCardCredit(id: $id, creditInput: { creditAmount: { amount: "5", currencyCode: USD } }) {
           giftCardTransaction { kind } userErrors { field code message }
         } }`,
      { id },
    );
    expect(refused.userErrors).toEqual([
      {
        field: ['creditInput', 'creditAmount', 'currencyCode'],
        code: 'INVALID',
        message: "Gift cards are in the shop's currency, PKR",
      },
    ]);

    const updated = await call(
      tokens.a,
      `mutation ($id: ID!) {
         giftCardUpdate(id: $id, input: { expiresOn: "2099-12-31", customerId: null }) {
           giftCard { expiresOn customer { name } } userErrors { message }
         } }`,
      { id },
    );
    expect(updated).toEqual({
      giftCard: { expiresOn: '2099-12-31', customer: null },
      userErrors: [],
    });
    const deactivated = await call(
      tokens.a,
      `mutation ($id: ID!) { giftCardDeactivate(id: $id) { giftCard { enabled } userErrors { message } } }`,
      { id },
    );
    expect(deactivated).toEqual({ giftCard: { enabled: false }, userErrors: [] });

    // Listed the newest first, and found by the code's end.
    const listed = await call(
      tokens.reader,
      `query ($query: String) { giftCards(first: 5, query: $query) { nodes { id } } }`,
      { query: last },
    );
    expect(listed.nodes).toEqual([{ id }]);
  });

  it("keeps cards to the scopes that read and write them, and to the shop's own", async () => {
    const own = await call(tokens.a, CREATE, {
      input: { initialValue: '100', code: 'SHOPA12345' },
    });
    expect(own.giftCardCode).toBe('SHOP A123 45');
    const id = own.giftCard.id as string;

    const write = await gql(tokens.reader, CREATE, { input: { initialValue: '100' } });
    expect(write.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    expect(await call(tokens.b, `{ giftCard(id: "${id}") { id } }`)).toBeNull();
    expect((await call(tokens.b, '{ giftCards(first: 5) { nodes { id } } }')).nodes).toEqual([]);
    // Another shop may have the same code: codes are each shop's own.
    const same = await call(tokens.b, CREATE, {
      input: { initialValue: '100', code: 'shopa12345' },
    });
    expect(same.userErrors).toEqual([]);
    const again = await call(tokens.a, CREATE, {
      input: { initialValue: '100', code: 'SHOPA-12345' },
    });
    expect(again.userErrors).toEqual([
      { field: ['input', 'code'], code: 'TAKEN', message: 'Another gift card has this code' },
    ]);
  });
});
