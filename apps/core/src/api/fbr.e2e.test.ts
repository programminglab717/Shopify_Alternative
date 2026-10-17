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

const POS = '{ fbrPos { system posId accessTokenHint environment pctCode } }';

const UPDATE = `mutation ($input: FbrPosInput!) {
  fbrPosUpdate(input: $input) {
    fbrPos { system posId accessTokenHint environment pctCode }
    userErrors { field code message }
  }
}`;

const INVOICES = `query ($status: FiscalInvoiceStatus) {
  fiscalInvoices(status: $status) {
    id system kind usin orderId status fbrInvoiceNumber attempts error
  }
}`;

const RETRY = `mutation ($id: ID!) {
  fiscalInvoiceRetry(id: $id) {
    fiscalInvoice { usin status }
    userErrors { field code message }
  }
}`;

const TOKEN = '1298b5eb-b252-3d97-8622-a4a69d5bf818';

const ADDRESS = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  address1: 'House 12, Street 4, Block 5',
  city: 'khi',
};

describe.skipIf(!server)("Admin GraphQL API: FBR's POS integration (POS-04, ADR-555)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const growth = newId();
  const tokens = { owner: '', reader: '', orders: '', growth: '' };

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
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

  async function data(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'B')`, [
      shop,
      growth,
    ]);
    // Pro includes FBR's connectors; Growth does not.
    await admin.query(
      `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
       VALUES ($1, 'pro', 'monthly', now(), now() + interval '1 month'),
              ($2, 'growth', 'monthly', now(), now() + interval '1 month')`,
      [shop, growth],
    );
    tokens.owner = await issueToken(shop, [
      'write_settings',
      'write_orders',
      'write_products',
      'write_inventory',
    ]);
    tokens.reader = await issueToken(shop, ['read_settings']);
    tokens.orders = await issueToken(shop, ['write_orders']);
    tokens.growth = await issueToken(growth, ['write_settings']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("connects the shop's POS, keeps the invoices it prints for FBR, and lists how each went", async () => {
    expect(await data(tokens.owner, POS)).toBeNull();
    const input = {
      posId: 123456,
      accessToken: TOKEN,
      environment: 'PRODUCTION',
      pctCode: '6204.4200',
    };
    expect((await data(tokens.growth, UPDATE, { input })).userErrors).toEqual([
      {
        field: ['input'],
        code: 'INVALID',
        message:
          "The Growth plan doesn't include FBR's POS integration: choose a bigger plan to connect one",
      },
    ]);
    expect(await data(tokens.owner, UPDATE, { input })).toEqual({
      fbrPos: {
        system: 'POS',
        posId: 123456,
        accessTokenHint: 'f818',
        environment: 'PRODUCTION',
        pctCode: '62044200',
      },
      userErrors: [],
    });
    expect(await data(tokens.reader, POS)).toMatchObject({ posId: 123456 });
    expect(JSON.stringify(await gql(tokens.reader, POS))).not.toContain(TOKEN);
    for (const [token, query] of [
      [tokens.orders, POS],
      [tokens.orders, INVOICES],
      [tokens.reader, UPDATE],
      [tokens.reader, 'mutation { fbrPosDelete { deletedPosId } }'],
    ] as const) {
      const denied = await gql(token, query, { input });
      expect(denied.errors?.[0]?.message).toMatch(/settings/);
    }

    // An order's invoice printed is kept for FBR.
    const product = await data(
      tokens.owner,
      `mutation ($input: ProductCreateInput!) {
         productCreate(input: $input) { product { variants { id } } userErrors { code } }
       }`,
      { input: { title: 'Kurta', status: 'ACTIVE', variants: [{ price: '2,000' }] } },
    );
    const variantId = product.product.variants[0].id as string;
    await admin.query(`UPDATE inventory.items SET inventory_policy = 'continue'`);
    const placed = await data(
      tokens.owner,
      `mutation ($input: OrderCreateInput!) {
         orderCreate(input: $input) { order { id } userErrors { field code message } }
       }`,
      { input: { lineItems: [{ variantId, quantity: 1 }], shippingAddress: ADDRESS } },
    );
    expect(placed.userErrors).toEqual([]);
    const orderId = placed.order.id as string;
    const printed = await data(
      tokens.owner,
      `query ($ids: [ID!]!) {
         orderDocument(ids: $ids, kind: INVOICE) { orders { invoice { number } } }
       }`,
      { ids: [orderId] },
    );
    const usin = printed.orders[0].invoice.number as string;
    const [kept] = (await data(tokens.reader, INVOICES)) as Json[];
    expect(kept).toMatchObject({
      system: 'POS',
      kind: 'INVOICE',
      usin,
      orderId,
      status: 'PENDING',
      fbrInvoiceNumber: null,
      attempts: 0,
    });
    expect(kept.id).toMatch(/^fbr_/);
    // The order's invoice says how it stands with FBR (ADR-556).
    expect(
      await data(
        tokens.owner,
        `query ($id: ID!) { order(id: $id) { invoice { number fbrStatus fbrInvoiceNumber } } }`,
        { id: orderId },
      ),
    ).toEqual({ invoice: { number: usin, fbrStatus: 'PENDING', fbrInvoiceNumber: null } });
    expect(await data(tokens.reader, INVOICES, { status: 'FAILED' })).toEqual([]);

    // Only one not reported is sent again.
    expect((await data(tokens.owner, RETRY, { id: kept.id })).userErrors).toEqual([
      {
        field: ['id'],
        code: 'INVALID',
        message: 'It is pending: only one not reported is sent again',
      },
    ]);
    expect((await data(tokens.owner, RETRY, { id: 'fbr_nope' })).userErrors[0].code).toBe(
      'NOT_FOUND',
    );

    // Disconnected, what waits is not sent.
    expect(
      await data(tokens.owner, 'mutation { fbrPosDelete { deletedSystem deletedPosId } }'),
    ).toEqual({ deletedSystem: 'POS', deletedPosId: 123456 });
    expect(await data(tokens.reader, INVOICES)).toMatchObject([
      { usin, status: 'SKIPPED', error: 'Not reported: the shop disconnected FBR' },
    ]);
  });

  it("connects FBR's digital invoicing for a shop registered for sales tax, without a POS ID (ADR-562)", async () => {
    const input = {
      system: 'DIGITAL_INVOICING',
      accessToken: TOKEN,
      environment: 'SANDBOX',
      pctCode: '6204.4200',
    };
    expect((await data(tokens.owner, UPDATE, { input })).userErrors).toEqual([
      {
        field: ['input', 'system'],
        code: 'INVALID',
        message:
          "FBR's digital invoicing is for sellers registered for sales tax: set the shop's NTN, " +
          'STRN and province in its tax settings first',
      },
    ]);
    await admin.query(
      `INSERT INTO tax.settings (shop_id, ntn, strn, province)
       VALUES ($1, '1234567-8', '3277876175852', 'sindh')`,
      [shop],
    );
    expect(
      (await data(tokens.owner, UPDATE, { input: { ...input, posId: 1 } })).userErrors,
    ).toEqual([
      {
        field: ['input', 'posId'],
        code: 'INVALID',
        message: "FBR's digital invoicing has no POS ID: leave it out",
      },
    ]);
    expect(await data(tokens.owner, UPDATE, { input })).toEqual({
      fbrPos: {
        system: 'DIGITAL_INVOICING',
        posId: null,
        accessTokenHint: 'f818',
        environment: 'SANDBOX',
        pctCode: '62044200',
      },
      userErrors: [],
    });

    // An order's invoice printed is kept for digital invoicing.
    const product = await data(
      tokens.owner,
      `mutation ($input: ProductCreateInput!) {
         productCreate(input: $input) { product { variants { id } } userErrors { code } }
       }`,
      { input: { title: 'Lawn suit', status: 'ACTIVE', variants: [{ price: '3,500' }] } },
    );
    await admin.query(`UPDATE inventory.items SET inventory_policy = 'continue'`);
    const placed = await data(
      tokens.owner,
      `mutation ($input: OrderCreateInput!) {
         orderCreate(input: $input) { order { id } userErrors { field code message } }
       }`,
      {
        input: {
          lineItems: [{ variantId: product.product.variants[0].id, quantity: 1 }],
          shippingAddress: ADDRESS,
        },
      },
    );
    const printed = await data(
      tokens.owner,
      `query ($ids: [ID!]!) {
         orderDocument(ids: $ids, kind: INVOICE) { orders { invoice { number } } }
       }`,
      { ids: [placed.order.id] },
    );
    const [kept] = (await data(tokens.reader, INVOICES)) as Json[];
    expect(kept).toMatchObject({
      system: 'DIGITAL_INVOICING',
      kind: 'INVOICE',
      usin: printed.orders[0].invoice.number,
      status: 'PENDING',
    });

    expect(
      await data(tokens.owner, 'mutation { fbrPosDelete { deletedSystem deletedPosId } }'),
    ).toEqual({ deletedSystem: 'DIGITAL_INVOICING', deletedPosId: null });
  });
});
