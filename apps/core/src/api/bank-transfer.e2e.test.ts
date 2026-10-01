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

  /** Posts a page's receipt form to `url`, as a browser encodes it. */
  async function postReceipt(url: string, file: Blob, filename: string) {
    const form = new FormData();
    form.append('action', 'receipt');
    form.append('receipt', file, filename);
    const request = new Request('http://localhost', { method: 'POST', body: form });
    return app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': request.headers.get('content-type')! },
      payload: Buffer.from(await request.arrayBuffer()),
    });
  }

  /** A PNG's first bytes, and some more: a receipt's photo, as far as its kind goes. */
  const PHOTO = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(56, 3),
  ]);

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

    // The Raast ID its bank registered, beside the IBAN.
    const raast = await gql(
      tokens.owner,
      `mutation {
        bankTransferSettingsUpdate(input: { account: {
          title: "Zari Textiles", bankName: "Standard Chartered",
          iban: "PK36SCBL0000001123456702", raastId: "0300 1234567"
        } }) {
          bankTransferSettings { account { iban raastId } }
          userErrors { field message }
        }
      }`,
    );
    expect(raast.data?.bankTransferSettingsUpdate).toEqual({
      bankTransferSettings: {
        account: { iban: 'PK36SCBL0000001123456702', raastId: '+923001234567' },
      },
      userErrors: [],
    });
  });

  it('asks for an advance on cash on delivery, and records it by hand', async () => {
    const created = await gql(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Dupatta", status: ACTIVE, variants: [{ price: "1,500" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const placed = await gql(
      tokens.clerk,
      `mutation ($variantId: ID!) {
        orderCreate(input: {
          lineItems: [{ variantId: $variantId, quantity: 1 }],
          shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                             address1: "House 12, Street 4", city: "Lahore" },
          advanceDue: "300"
        }) {
          order { id stage confirmationStatus advanceDue { amount } codAmount { amount } }
          userErrors { field message }
        }
      }`,
      { variantId: created.data?.productCreate.product.variants[0].id },
    );
    const order = placed.data?.orderCreate.order;
    expect(order).toMatchObject({
      stage: 'AWAITING_PAYMENT',
      confirmationStatus: 'NOT_REQUIRED',
      advanceDue: { amount: '300.00' },
      codAmount: { amount: '1200.00' },
    });
    const recorded = await gql(
      tokens.clerk,
      `mutation ($id: ID!) {
        orderCreateManualPayment(id: $id) {
          order { stage financialStatus amountPaid { amount } }
          userErrors { field message }
        }
      }`,
      { id: order.id },
    );
    expect(recorded.data?.orderCreateManualPayment).toEqual({
      order: {
        stage: 'TO_PACK',
        financialStatus: 'PARTIALLY_PAID',
        amountPaid: { amount: '300.00' },
      },
      userErrors: [],
    });
  });

  it("takes the receipt the customer sends through the order's page, and shows it the shop", async () => {
    const created = await gql(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Shawl", status: ACTIVE, variants: [{ price: "3,000" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const placed = await gql(
      tokens.clerk,
      `mutation ($variantId: ID!) {
        orderCreate(input: {
          lineItems: [{ variantId: $variantId, quantity: 1 }],
          shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                             address1: "House 12, Street 4", city: "Lahore" },
          paymentMethod: BANK_TRANSFER
        }) { order { id name } }
      }`,
      { variantId: created.data?.productCreate.product.variants[0].id },
    );
    const order = placed.data?.orderCreate.order;
    const linked = await gql(
      tokens.clerk,
      'mutation ($id: ID!) { orderLinkCreate(id: $id) { url } }',
      { id: order.id },
    );
    const path = new URL(linked.data?.orderLinkCreate.url).pathname;
    expect((await app.inject({ method: 'GET', url: path })).body).toContain(
      '<form method="post" enctype="multipart/form-data">',
    );

    const send = (file: Blob, filename: string, url = path) => postReceipt(url, file, filename);
    const photo = PHOTO;
    const nothing = await send(new Blob([]), '');
    expect(nothing.statusCode).toBe(422);
    expect(nothing.body).toContain('Choose the photo or PDF of your receipt first.');
    const page = await send(new Blob(['<html></html>'], { type: 'image/png' }), 'receipt.png');
    expect(page.statusCode).toBe(422);
    expect(page.body).toContain('That file isn&#39;t a photo or a PDF.');
    const large = await send(new Blob([photo, Buffer.alloc(10 * 1024 * 1024)]), 'big.png');
    expect(large.statusCode).toBe(422);
    expect(large.body).toContain('That file is larger than 10 MB.');
    // No other page takes a file: not a checkout's, say.
    const checkout = await send(new Blob([photo]), 'receipt.png', '/checkouts/anything');
    expect(checkout.statusCode).toBe(415);

    const sent = await send(new Blob([photo], { type: 'image/png' }), 'IMG_2041.png');
    expect(sent.statusCode).toBe(303);
    expect(sent.headers.location).toBe(`${path.split('/').pop()}?sent`);
    const thanked = await app.inject({ method: 'GET', url: `${path}?sent` });
    expect(thanked.body).toContain('Thank you: Zari has your receipt');
    expect(thanked.body).toContain('You sent a receipt.');

    const shown = await gql(
      tokens.clerk,
      `query ($id: ID!) {
        order(id: $id) { transferReceipts { id mimeType fileSize url createdAt } }
      }`,
      { id: order.id },
    );
    const [receipt] = shown.data!.order.transferReceipts;
    expect(receipt).toMatchObject({
      id: expect.stringMatching(/^rcpt_/),
      mimeType: 'image/png',
      fileSize: 64,
      url: expect.stringMatching(
        new RegExp(`^http://localhost:4000/storage/shops/${shop}/receipts/[0-9a-f-]{36}/`),
      ),
    });
    const file = await app.inject({
      method: 'GET',
      url: receipt.url.replace('http://localhost:4000', ''),
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toBe(
      `inline; filename="Receipt ${order.name}-1.png"; filename*=UTF-8''Receipt%20%23${order.name.slice(1)}-1.png`,
    );
    expect(file.rawPayload.equals(photo)).toBe(true);

    // The home counts it among the transfers to check, and the list finds it.
    const toCheck = await gql(
      tokens.clerk,
      `{
        home { transfersToCheck { count total { amount } } }
        orders(first: 5, stage: AWAITING_PAYMENT, hasTransferReceipt: true) { nodes { name } }
      }`,
    );
    expect(toCheck.data).toEqual({
      home: { transfersToCheck: { count: 1, total: { amount: '3000.00' } } },
      orders: { nodes: [{ name: order.name }] },
    });
  });

  it('asks for an advance on a draft, whose link takes the receipt once its customer confirms', async () => {
    const created = await gql(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Dupatta", status: ACTIVE, variants: [{ price: "1,500" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const drafted = await gql(
      tokens.clerk,
      `mutation ($variantId: ID!) {
        draftOrderCreate(input: {
          lineItems: [{ variantId: $variantId, quantity: 1 }],
          shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                             address1: "House 12, Street 4", city: "Lahore" },
          shippingPrice: "250",
          advanceDue: "250"
        }) {
          draftOrder { id advanceDue { amount } codAmount { amount } }
          userErrors { field message }
        }
      }`,
      { variantId: created.data?.productCreate.product.variants[0].id },
    );
    const draft = drafted.data?.draftOrderCreate.draftOrder;
    expect(draft).toMatchObject({
      advanceDue: { amount: '250.00' },
      codAmount: { amount: '1500.00' },
    });
    const linked = await gql(
      tokens.clerk,
      'mutation ($id: ID!) { draftOrderLinkCreate(id: $id) { url } }',
      { id: draft.id },
    );
    const path = new URL(linked.data?.draftOrderLinkCreate.url).pathname;
    const open = (await app.inject({ method: 'GET', url: path })).body;
    expect(open).toContain('Once you confirm, pay Rs 250 in advance by bank transfer');
    const confirmed = await app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `action=confirm&shown=${/name="shown" value="([\w-]{22})"/.exec(open)![1]}`,
    });
    expect(confirmed.statusCode).toBe(303);
    expect((await app.inject({ method: 'GET', url: path })).body).toContain(
      '<form method="post" enctype="multipart/form-data">',
    );
    const sent = await postReceipt(path, new Blob([PHOTO], { type: 'image/png' }), 'advance.png');
    expect(sent.statusCode).toBe(303);
    expect(sent.headers.location).toBe(`${path.split('/').pop()}?sent`);
    const thanked = await app.inject({ method: 'GET', url: `${path}?sent` });
    expect(thanked.body).toContain('Thank you: Zari has your receipt');
    expect(thanked.body).toContain('You sent a receipt.');
    // The shop sees it with the order, as a transfer's.
    const seen = await gql(
      tokens.clerk,
      `query ($id: ID!) {
        draftOrder(id: $id) {
          order { stage advanceDue { amount } transferReceipts { mimeType fileSize } }
        }
      }`,
      { id: draft.id },
    );
    expect(seen.data?.draftOrder.order).toEqual({
      stage: 'AWAITING_PAYMENT',
      advanceDue: { amount: '250.00' },
      transferReceipts: [{ mimeType: 'image/png', fileSize: 64 }],
    });
  });
});
