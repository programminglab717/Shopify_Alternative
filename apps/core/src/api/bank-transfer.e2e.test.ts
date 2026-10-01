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

const SETTINGS = `{
  bankTransferSettings { enabled account { title bankName iban instructions } discount { kind } }
}`;

const UPDATE = `mutation ($input: BankTransferSettingsInput!) {
  bankTransferSettingsUpdate(input: $input) {
    bankTransferSettings { enabled account { title bankName iban } updatedAt }
    userErrors { field code message }
  }
}`;

const ORDER = `
  name stage paymentMethod confirmationStatus financialStatus
  codAmount { amount } transferDiscount { amount } bankAccount { title bankName iban instructions }`;

const DISCOUNT = `mutation ($input: BankTransferSettingsInput!) {
  bankTransferSettingsUpdate(input: $input) {
    bankTransferSettings {
      discount { kind percentage cap { amount formatted } amount { amount } }
    }
    userErrors { field code message }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: bank transfer', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { owner: '', clerk: '' };

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
    tokens.owner = await issueToken(['write_settings', 'write_products', 'write_orders']);
    tokens.clerk = await issueToken(['write_orders']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("keeps the shop's account, and places orders that wait for the transfer", async () => {
    expect((await gql(tokens.owner, SETTINGS)).data?.bankTransferSettings).toEqual({
      enabled: false,
      account: null,
      discount: null,
    });
    expect((await gql(tokens.clerk, SETTINGS)).errors?.[0]?.message).toContain('read_settings');
    const account = { title: 'Zari Textiles', bankName: 'Standard Chartered' };
    const mistyped = await gql(tokens.owner, UPDATE, {
      input: { enabled: true, account: { ...account, iban: 'PK37 SCBL 0000 0011 2345 6702' } },
    });
    expect(mistyped.data?.bankTransferSettingsUpdate).toEqual({
      bankTransferSettings: null,
      userErrors: [
        {
          field: ['input', 'account', 'iban'],
          code: 'INVALID',
          message: "The IBAN's check digits don't match it: check it for a mistyped character",
        },
      ],
    });
    const saved = await gql(tokens.owner, UPDATE, {
      input: { enabled: true, account: { ...account, iban: 'PK36 SCBL 0000 0011 2345 6702' } },
    });
    expect(saved.data?.bankTransferSettingsUpdate).toMatchObject({
      bankTransferSettings: {
        enabled: true,
        account: { ...account, iban: 'PK36SCBL0000001123456702' },
      },
      userErrors: [],
    });

    const created = await gql(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,499" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const variantId = created.data?.productCreate.product.variants[0].id;
    const placed = await gql(
      tokens.clerk,
      `mutation ($variantId: ID!) {
        orderCreate(input: {
          lineItems: [{ variantId: $variantId, quantity: 1 }],
          shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                             address1: "House 12, Street 4", city: "Lahore" },
          paymentMethod: BANK_TRANSFER
        }) { order { id ${ORDER} } userErrors { code message } }
      }`,
      { variantId },
    );
    const order = placed.data?.orderCreate.order;
    expect(order).toMatchObject({
      name: '#1001',
      stage: 'AWAITING_PAYMENT',
      paymentMethod: 'BANK_TRANSFER',
      confirmationStatus: 'NOT_REQUIRED',
      financialStatus: 'PENDING',
      codAmount: { amount: '0.00' },
      // Checkout takes something off for paying by transfer, where the shop does; staff don't.
      transferDiscount: { amount: '0.00' },
      bankAccount: { ...account, iban: 'PK36SCBL0000001123456702', instructions: '' },
    });
    const waiting = await gql(
      tokens.clerk,
      `{
        home { awaitingPayment { count total { amount } } }
        orders(first: 5, stage: AWAITING_PAYMENT) { nodes { name } }
      }`,
    );
    expect(waiting.data).toEqual({
      home: { awaitingPayment: { count: 1, total: { amount: '2499.00' } } },
      orders: { nodes: [{ name: '#1001' }] },
    });
    const shipped = await gql(
      tokens.clerk,
      `mutation ($id: ID!) { orderFulfill(id: $id, input: {}) { userErrors { message } } }`,
      { id: order.id },
    );
    expect(shipped.data?.orderFulfill.userErrors).toEqual([
      { message: 'Mark the order paid once its bank transfer is in' },
    ]);
    const paid = await gql(
      tokens.clerk,
      `mutation ($id: ID!) { orderMarkAsPaid(id: $id) { order { stage financialStatus } } }`,
      { id: order.id },
    );
    expect(paid.data?.orderMarkAsPaid.order).toEqual({ stage: 'TO_PACK', financialStatus: 'PAID' });
  });

  it('keeps what paying by transfer takes off: a percentage, up to a cap, or an amount', async () => {
    const update = async (discount: unknown) =>
      (await gql(tokens.owner, DISCOUNT, { input: { discount } })).data?.bankTransferSettingsUpdate;
    expect(await update({ percentage: 5, amount: '100' })).toEqual({
      bankTransferSettings: null,
      userErrors: [
        {
          field: ['input', 'discount', 'amount'],
          code: 'INVALID',
          message: 'Take a percentage or an amount off, not both',
        },
      ],
    });
    expect((await update({ percentage: 5, cap: '500' })).bankTransferSettings.discount).toEqual({
      kind: 'PERCENTAGE',
      percentage: 5,
      cap: { amount: '500.00', formatted: 'Rs 500' },
      amount: null,
    });
    expect((await update({ amount: '150' })).bankTransferSettings.discount).toEqual({
      kind: 'FIXED_AMOUNT',
      percentage: null,
      cap: null,
      amount: { amount: '150.00' },
    });
    expect((await update(null)).bankTransferSettings.discount).toBeNull();
  });
});
