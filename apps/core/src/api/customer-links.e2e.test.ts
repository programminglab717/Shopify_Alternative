import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
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

const SCOPES = ['write_products', 'write_inventory', 'write_locations', 'write_orders'];

const ADDRESS = {
  name: 'Ayesha Khan',
  phone: '0300-1234567',
  address1: 'House 12, Street 4, Block 5',
  city: 'khi',
};

const DRAFT_FIELDS = `
  id name number status source paymentMethod phone linkExpiresAt version
  lineItems { title quantity unitPrice { formatted } totalPrice { formatted } }
  shippingAddress { city }
  totalPrice { formatted } codAmount { formatted }
  location { name }
  order { name source confirmationStatus stage }
`;

const DRAFT_CREATE = `
  mutation ($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { ${DRAFT_FIELDS} } userErrors { field code message }
    }
  }`;

const LINK_CREATE = `
  mutation ($id: ID!, $hours: Int) {
    draftOrderLinkCreate(id: $id, expiresInHours: $hours) {
      draftOrder { version linkExpiresAt } url whatsappUrl userErrors { field code message }
    }
  }`;

describe.skipIf(!server)('Admin GraphQL API: links for customers, to drafts and orders', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shopA = newId();
  const tokens = { a: '', aReader: '' };
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

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
      payload: { query, variables },
    });
    return response.json<{ data?: Json; errors?: Json[] }>();
  }

  /** Runs a mutation and returns its payload, failing the test on GraphQL errors. */
  async function mutate(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  /** The path of a link's page: "/d/…" or "/o/…". */
  const pathOf = (url: string) => new URL(url).pathname;

  /** Posts a page's form. */
  const post = (url: string, form: string) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form,
    });

  /** The digest of what a page showed, from its form. */
  const shownIn = (body: string) => /name="shown" value="([\w-]{22})"/.exec(body)![1]!;

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shopA]);
    tokens.a = await issueToken(shopA, SCOPES);
    tokens.aReader = await issueToken(shopA, ['read_orders']);
    api = await startTestApi(testDb);
    app = api.app;

    const created = await mutate(
      tokens.a,
      `mutation {
        productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,000" }] }) {
          product { variants { id inventoryItem { id } } }
        }
      }`,
    );
    const variant = created.product.variants[0];
    kurta = variant.id;
    const location = (await gql(tokens.a, '{ location { id } }')).data.location.id;
    const counted = await mutate(
      tokens.a,
      `mutation ($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) { userErrors { code } }
      }`,
      {
        input: {
          name: 'available',
          reason: 'received',
          quantities: [
            { inventoryItemId: variant.inventoryItem.id, locationId: location, quantity: 10 },
          ],
        },
      },
    );
    expect(counted.userErrors).toEqual([]);
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('takes an order in a chat, and the customer confirms it through a link', async () => {
    const started = await mutate(tokens.a, DRAFT_CREATE, {
      input: {
        lineItems: [{ variantId: kurta, quantity: 2, price: '1,800' }],
        source: 'WHATSAPP',
        shippingPrice: '250',
      },
    });
    expect(started.userErrors).toEqual([]);
    const draft = started.draftOrder;
    expect(draft).toMatchObject({
      id: expect.stringMatching(/^dft_/),
      name: '#D1',
      status: 'OPEN',
      source: 'WHATSAPP',
      paymentMethod: 'CASH_ON_DELIVERY',
      phone: null,
      shippingAddress: null,
      lineItems: [{ title: 'Kurta', quantity: 2, unitPrice: { formatted: 'Rs 1,800' } }],
      totalPrice: { formatted: 'Rs 3,850' },
      codAmount: { formatted: 'Rs 3,850' },
      location: null,
      order: null,
    });

    // No link without the address to deliver to.
    const early = await mutate(tokens.a, LINK_CREATE, { id: draft.id });
    expect(early.userErrors).toEqual([
      {
        field: ['id'],
        code: 'INVALID',
        message: "Add the customer's address first: the link shows it to them to confirm",
      },
    ]);
    const addressed = await mutate(
      tokens.a,
      `mutation ($id: ID!, $input: DraftOrderInput!) {
        draftOrderUpdate(id: $id, input: $input) {
          draftOrder { version phone shippingAddress { city } } userErrors { code }
        }
      }`,
      { id: draft.id, input: { shippingAddress: ADDRESS } },
    );
    expect(addressed).toMatchObject({
      draftOrder: { version: 2, phone: '+923001234567', shippingAddress: { city: 'Karachi' } },
      userErrors: [],
    });

    const link = await mutate(tokens.a, LINK_CREATE, { id: draft.id, hours: 48 });
    expect(link.userErrors).toEqual([]);
    expect(link.url).toMatch(/^http:\/\/localhost:4000\/d\/[A-Za-z0-9_-]{22}$/);
    expect(link.whatsappUrl).toMatch(/^https:\/\/wa\.me\/923001234567\?text=Please%20confirm/);
    expect(link.draftOrder.version).toBe(3);
    const path = pathOf(link.url);

    // The customer opens it: the order, their number masked, and headers for a private page.
    const page = await app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200);
    expect(page.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': expect.stringMatching(/^default-src 'none'; style-src 'sha256-/),
    });
    expect(page.body).toContain('Confirm your order');
    expect(page.body).toContain('0300 ••••567');
    expect(page.body).toContain('Rs 3,850');
    const shown = shownIn(page.body);

    // A post from a page that is out of date shows the order again.
    const stale = await post(path, 'shown=AAAAAAAAAAAAAAAAAAAAAA&action=confirm');
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain('This order changed after you opened it.');

    const confirmed = await post(path, `shown=${shown}&action=confirm`);
    expect(confirmed.statusCode).toBe(303);
    expect(confirmed.headers.location).toBe(path.split('/').at(-1));
    expect(confirmed.headers['cache-control']).toBe('no-store');
    const done = await app.inject({ method: 'GET', url: path });
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('Your order #1001 is confirmed');
    expect(done.body).toContain('You pay Rs 3,850 when it arrives.');

    // Posting again places nothing more.
    expect((await post(path, `shown=${shown}&action=confirm`)).statusCode).toBe(303);

    const found = await gql(
      tokens.aReader,
      `query ($id: ID!) { draftOrder(id: $id) { ${DRAFT_FIELDS} } }`,
      { id: draft.id },
    );
    expect(found.data.draftOrder).toMatchObject({
      status: 'COMPLETED',
      order: {
        name: '#1001',
        source: 'WHATSAPP',
        confirmationStatus: 'CONFIRMED',
        stage: 'TO_PACK',
      },
    });
    const orders = await gql(tokens.a, '{ orders(first: 5) { nodes { name } } }');
    expect(orders.data.orders.nodes).toEqual([{ name: '#1001' }]);
  });

  it('lets staff complete a draft, and shows nothing for a link that does not work', async () => {
    const draft = (
      await mutate(tokens.a, DRAFT_CREATE, {
        input: {
          lineItems: [{ variantId: kurta, quantity: 1 }],
          shippingAddress: ADDRESS,
          paymentMethod: 'PREPAID',
        },
      })
    ).draftOrder;
    const refused = await mutate(tokens.a, LINK_CREATE, { id: draft.id });
    expect(refused.userErrors[0].code).toBe('INVALID');
    const completed = await mutate(
      tokens.a,
      `mutation ($id: ID!) {
        draftOrderComplete(id: $id) {
          draftOrder { status order { name paymentMethod confirmationStatus stage } }
          userErrors { code }
        }
      }`,
      { id: draft.id },
    );
    expect(completed).toEqual({
      draftOrder: {
        status: 'COMPLETED',
        order: {
          name: '#1002',
          paymentMethod: 'PREPAID',
          confirmationStatus: 'NOT_REQUIRED',
          stage: 'TO_PACK',
        },
      },
      userErrors: [],
    });

    const list = await gql(
      tokens.a,
      '{ draftOrders(first: 5, status: COMPLETED) { nodes { name } } }',
    );
    expect(list.data.draftOrders.nodes).toEqual([{ name: '#D2' }, { name: '#D1' }]);

    // Reading needs read_orders; changing needs write_orders.
    const denied = await gql(tokens.aReader, DRAFT_CREATE, {
      input: { lineItems: [{ variantId: kurta, quantity: 1 }] },
    });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const malformed = await gql(tokens.a, '{ draftOrder(id: "ord_1") { id } }');
    expect(malformed.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

    for (const url of ['/d/AAAAAAAAAAAAAAAAAAAAAA', '/d/not-a-link']) {
      const missing = await app.inject({ method: 'GET', url });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers['cache-control']).toBe('no-store');
      expect(missing.body).toContain('This link doesn&#39;t work');
      expect((await post(url, 'shown=x&action=confirm')).statusCode).toBe(404);
    }
    // The link's page needs no Admin API credentials, and takes none.
    const open = (
      await mutate(tokens.a, DRAFT_CREATE, {
        input: { lineItems: [{ variantId: kurta, quantity: 1 }], shippingAddress: ADDRESS },
      })
    ).draftOrder;
    const link = await mutate(tokens.a, LINK_CREATE, { id: open.id });
    await admin.query(
      `UPDATE orders.draft_orders SET link_expires_at = now() - interval '1 minute'
        WHERE link_token_hash IS NOT NULL`,
    );
    const expired = await app.inject({ method: 'GET', url: pathOf(link.url) });
    expect(expired.statusCode).toBe(410);
    expect(expired.body).toContain('This link has expired');
    expect(expired.body).not.toContain('Ayesha');
  });

  it("sends an order's customer a link, where they confirm or cancel it", async () => {
    const ORDER_LINK_CREATE = `
      mutation ($id: ID!) {
        orderLinkCreate(id: $id) {
          order { linkExpiresAt } url whatsappUrl userErrors { field code message }
        }
      }`;
    const place = async () =>
      (
        await mutate(
          tokens.a,
          `mutation ($input: OrderCreateInput!) {
            orderCreate(input: $input) { order { id name } userErrors { code } }
          }`,
          { input: { lineItems: [{ variantId: kurta, quantity: 1 }], shippingAddress: ADDRESS } },
        )
      ).order;
    const ORDER = `query ($id: ID!) {
      order(id: $id) {
        status cancelReason confirmationStatus stage linkExpiresAt
        events(first: 1) { nodes { kind message } }
      }
    }`;

    const declined = await place();
    const link = await mutate(tokens.a, ORDER_LINK_CREATE, { id: declined.id });
    expect(link.userErrors).toEqual([]);
    expect(link.url).toMatch(/^http:\/\/localhost:4000\/o\/[A-Za-z0-9_-]{22}$/);
    expect(link.whatsappUrl).toMatch(/^https:\/\/wa\.me\/923001234567\?text=Please%20confirm/);
    expect(link.order.linkExpiresAt).toEqual(expect.any(String));
    const path = pathOf(link.url);
    const page = await app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200);
    expect(page.headers).toMatchObject({
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': expect.stringMatching(/^default-src 'none'/),
    });
    expect(page.body).toContain('Confirm your order');
    expect(page.body).toContain(declined.name);

    // Asking to cancel is a question, which changes nothing; so does a post that asks for neither.
    const asking = await app.inject({ method: 'GET', url: `${path}?cancel` });
    expect(asking.statusCode).toBe(200);
    expect(asking.body).toContain('Cancel your order?');
    const shown = shownIn(page.body);
    expect((await post(path, `shown=${shown}&action=refund`)).statusCode).toBe(400);
    expect((await gql(tokens.aReader, ORDER, { id: declined.id })).data.order.status).toBe('OPEN');

    const cancelled = await post(path, `shown=${shown}&action=cancel`);
    expect(cancelled.statusCode).toBe(303);
    expect(cancelled.headers.location).toBe(path.split('/').at(-1));
    expect((await app.inject({ method: 'GET', url: path })).body).toContain('Order cancelled');
    expect((await gql(tokens.aReader, ORDER, { id: declined.id })).data.order).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'CUSTOMER',
      confirmationStatus: 'REJECTED',
      stage: 'CANCELLED',
      events: {
        nodes: [{ kind: 'cancelled', message: 'Cancelled by the customer through their link' }],
      },
    });

    const kept = await place();
    const keptPath = pathOf((await mutate(tokens.a, ORDER_LINK_CREATE, { id: kept.id })).url);
    const keptPage = await app.inject({ method: 'GET', url: keptPath });
    const confirmed = await post(keptPath, `shown=${shownIn(keptPage.body)}&action=confirm`);
    expect(confirmed.statusCode).toBe(303);
    expect((await app.inject({ method: 'GET', url: keptPath })).body).toContain(
      `Your order ${kept.name} is confirmed`,
    );
    expect((await gql(tokens.aReader, ORDER, { id: kept.id })).data.order).toMatchObject({
      confirmationStatus: 'CONFIRMED',
      stage: 'TO_PACK',
    });

    // Making links needs write_orders.
    const denied = await gql(tokens.aReader, ORDER_LINK_CREATE, { id: kept.id });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });
});
