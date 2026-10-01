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

const SCOPES = [
  'write_products',
  'write_inventory',
  'write_locations',
  'write_orders',
  'write_legal_policies',
];

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
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shopA,
    ]);
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

  it('takes an order in a chat, and the customer adds their address and confirms it through a link', async () => {
    const policy = await mutate(
      tokens.a,
      `mutation ($policy: ShopPolicyInput!) {
        shopPolicyUpdate(shopPolicy: $policy) { userErrors { code } }
      }`,
      { policy: { type: 'REFUND_POLICY', body: '<p>7 days.</p>' } },
    );
    expect(policy.userErrors).toEqual([]);
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

    // The link goes out before the address: the customer adds it, with their number.
    const link = await mutate(tokens.a, LINK_CREATE, { id: draft.id, hours: 48 });
    expect(link.userErrors).toEqual([]);
    expect(link.url).toMatch(/^http:\/\/localhost:4000\/d\/[A-Za-z0-9_-]{22}$/);
    expect(link.whatsappUrl).toMatch(/^https:\/\/wa\.me\/\?text=Please%20add%20your%20address/);
    expect(link.draftOrder.version).toBe(2);
    const path = pathOf(link.url);

    // The customer opens it: the order, a way to add the address, and headers for a private page.
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
    expect(page.body).toContain('Rs 3,850');
    expect(page.body).toContain('<a class="button stack" href="?address">');
    expect(page.body).not.toContain('value="confirm"');
    const form = await app.inject({ method: 'GET', url: `${path}?address` });
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('Add your address');
    expect(form.body).toContain('type="tel"');
    const saveAddress = (fields: string) =>
      post(path, `action=address&shown=${shownIn(form.body)}&${fields}`);
    const invalid = await saveAddress('name=Ayesha+Khan&address1=House+12&city=khi&phone=12345');
    expect(invalid.statusCode).toBe(422);
    expect(invalid.body).toContain('Enter a Pakistani mobile number, like 0300 1234567.');
    expect(invalid.body).toContain('value="12345"');
    const saved = await saveAddress(
      'name=Ayesha+Khan&address1=House+12%2C+Street+4%2C+Block+5&city=khi&phone=0300-1234567',
    );
    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe(`${path.split('/').at(-1)}?saved`);
    const addressed = await gql(
      tokens.aReader,
      `query ($id: ID!) { draftOrder(id: $id) { version phone shippingAddress { city } } }`,
      { id: draft.id },
    );
    expect(addressed.data.draftOrder).toMatchObject({
      version: 3,
      phone: '+923001234567',
      shippingAddress: { city: 'Karachi' },
    });

    // Back on the page: the address saved, their number masked, and the order to confirm.
    const ready = await app.inject({ method: 'GET', url: `${path}?saved` });
    expect(ready.body).toContain('Your new address is saved.');
    expect(ready.body).toContain('0300 ••••567');
    expect(ready.body).toContain('<a href="?address">');
    // What confirming agrees to, above the button: the shop's policies, at its storefront.
    expect(ready.body).toContain(
      "By confirming your order, you agree to the shop's " +
        '<a href="http://zari.localhost:4100/policies/refund-policy" target="_blank" ' +
        'rel="noopener">refund policy</a>.',
    );
    const shown = shownIn(ready.body);

    // A post from a page that is out of date shows the order again.
    const stale = await post(path, 'shown=AAAAAAAAAAAAAAAAAAAAAA&action=confirm');
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain(
      'This order or the shop&#39;s policies changed after you opened it.',
    );

    // Confirmed from the customer's phone, which the order keeps with what they agreed to.
    const confirmed = await app.inject({
      method: 'POST',
      url: path,
      remoteAddress: '203.0.113.9',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Mozilla/5.0 (Linux; Android 14)',
      },
      payload: `shown=${shown}&action=confirm`,
    });
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
    const orders = await gql(
      tokens.a,
      '{ orders(first: 5) { nodes { name agreement { ip userAgent policies { type body } } } } }',
    );
    expect(orders.data.orders.nodes).toEqual([
      {
        name: '#1001',
        agreement: {
          ip: '203.0.113.9',
          userAgent: 'Mozilla/5.0 (Linux; Android 14)',
          policies: [{ type: 'REFUND_POLICY', body: '<p>7 days.</p>' }],
        },
      },
    ]);
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
    // Found by number, with filters among the words (ADR-123).
    const found = await gql(
      tokens.a,
      '{ draftOrders(first: 5, query: "#D1 status:completed") { nodes { name } } }',
    );
    expect(found.data.draftOrders.nodes).toEqual([{ name: '#D1' }]);
    const unknown = await gql(
      tokens.a,
      '{ draftOrders(first: 5, query: "stage:open") { nodes { name } } }',
    );
    expect(unknown.errors?.[0]).toMatchObject({
      message: expect.stringContaining("Drafts can't be filtered by stage"),
      extensions: { code: 'BAD_USER_INPUT' },
    });

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

  it("sends an order's customer a link, where they confirm, cancel or correct it", async () => {
    const ORDER_LINK_CREATE = `
      mutation ($id: ID!) {
        orderLinkCreate(id: $id) {
          order { customerLink { expiresAt } } url whatsappUrl userErrors { field code message }
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
        status cancelReason confirmationStatus stage customerLink { expiresAt }
        events(first: 1) { nodes { kind message } }
      }
    }`;

    const declined = await place();
    const link = await mutate(tokens.a, ORDER_LINK_CREATE, { id: declined.id });
    expect(link.userErrors).toEqual([]);
    expect(link.url).toMatch(/^http:\/\/localhost:4000\/o\/[A-Za-z0-9_-]{22}$/);
    expect(link.whatsappUrl).toMatch(/^https:\/\/wa\.me\/923001234567\?text=Please%20confirm/);
    // It lasts until 30 days after the order ends.
    expect(link.order.customerLink).toEqual({ expiresAt: null });
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
    const cancelledOrder = (await gql(tokens.aReader, ORDER, { id: declined.id })).data.order;
    expect(Date.parse(cancelledOrder.customerLink.expiresAt)).toBeGreaterThan(
      Date.now() + 29 * 86_400_000,
    );
    expect(cancelledOrder).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'CUSTOMER',
      confirmationStatus: 'REJECTED',
      stage: 'CANCELLED',
      events: {
        nodes: [{ kind: 'cancelled', message: 'Cancelled by the customer through their link' }],
      },
    });

    // Placed by an app, it agreed to nothing: its page says what confirming agrees to, and the
    // order keeps it, with where and when the customer confirmed it.
    const kept = await place();
    const keptPath = pathOf((await mutate(tokens.a, ORDER_LINK_CREATE, { id: kept.id })).url);
    const keptPage = await app.inject({ method: 'GET', url: keptPath });
    expect(keptPage.body).toContain(
      "By confirming your order, you agree to the shop's " +
        '<a href="http://zari.localhost:4100/policies/refund-policy" target="_blank" ' +
        'rel="noopener">refund policy</a>.',
    );
    const confirmed = await app.inject({
      method: 'POST',
      url: keptPath,
      remoteAddress: '203.0.113.10',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      },
      payload: `shown=${shownIn(keptPage.body)}&action=confirm`,
    });
    expect(confirmed.statusCode).toBe(303);
    expect((await app.inject({ method: 'GET', url: keptPath })).body).toContain(
      `Your order ${kept.name} is confirmed`,
    );
    const agreed = await gql(
      tokens.a,
      `query ($id: ID!) {
        order(id: $id) {
          confirmationStatus stage confirmedAt
          agreement { agreedAt ip userAgent policies { type } }
        }
      }`,
      { id: kept.id },
    );
    expect(agreed.data.order).toEqual({
      confirmationStatus: 'CONFIRMED',
      stage: 'TO_PACK',
      confirmedAt: expect.any(String),
      agreement: {
        agreedAt: agreed.data.order.confirmedAt,
        ip: '203.0.113.10',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
        policies: [{ type: 'REFUND_POLICY' }],
      },
    });

    // Until the order is packed, the customer can correct its address; one that does not check
    // out comes back with what is wrong. Saved, the page says so.
    const form = await app.inject({ method: 'GET', url: `${keptPath}?address` });
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('Change the address');
    expect(form.body).toContain('value="House 12, Street 4, Block 5"');
    const saveAddress = (fields: string) =>
      post(keptPath, `action=address&shown=${shownIn(form.body)}&${fields}`);
    const invalid = await saveAddress('name=&address1=Flat+3&city=lahore');
    expect(invalid.statusCode).toBe(422);
    expect(invalid.body).toContain('Enter the name of who receives the parcel.');
    expect(invalid.body).toContain('value="Flat 3"');
    const saved = await saveAddress(
      'name=Ayesha+Khan&address1=Flat+3%2C+Gulberg+III&address2=&city=lahore&province=&zip=54660',
    );
    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe(`${keptPath.split('/').at(-1)}?saved`);
    const savedPage = await app.inject({ method: 'GET', url: `${keptPath}?saved` });
    expect(savedPage.body).toContain('Your new address is saved.');
    expect(savedPage.body).toContain('Flat 3, Gulberg III');
    const ADDRESS_OF = `query ($id: ID!) {
      order(id: $id) {
        stage shippingAddress { address1 city provinceCode zip }
        events(first: 1) { nodes { kind message } }
      }
    }`;
    expect((await gql(tokens.aReader, ADDRESS_OF, { id: kept.id })).data.order).toMatchObject({
      stage: 'TO_PACK',
      shippingAddress: {
        address1: 'Flat 3, Gulberg III',
        city: 'Lahore',
        provinceCode: 'PB',
        zip: '54660',
      },
      events: {
        nodes: [
          {
            kind: 'updated',
            message: 'The customer changed the shipping address through their link',
          },
        ],
      },
    });

    // Packed, it is for the shop: the form is gone, and a stale one is turned away.
    const packed = await mutate(
      tokens.a,
      `mutation ($id: ID!) { orderMarkPacked(id: $id) { userErrors { code } } }`,
      { id: kept.id },
    );
    expect(packed.userErrors).toEqual([]);
    const packedPage = await app.inject({ method: 'GET', url: `${keptPath}?address` });
    expect(packedPage.statusCode).toBe(200);
    expect(packedPage.body).not.toContain('<form');
    const late = await post(
      keptPath,
      `action=address&shown=${shownIn(form.body)}&name=A&address1=B&city=lahore`,
    );
    expect(late.statusCode).toBe(409);
    expect(late.body).toContain('The address can&#39;t be changed here any more.');

    // Making links needs write_orders.
    const denied = await gql(tokens.aReader, ORDER_LINK_CREATE, { id: kept.id });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });

  it('lets a customer cancel after confirming, until the order is packed, as the shop allows', async () => {
    const settingsToken = await issueToken(shopA, ['write_settings']);
    const SETTINGS = '{ orderSettings { customerCancellation updatedAt } }';
    expect((await gql(settingsToken, SETTINGS)).data.orderSettings).toEqual({
      customerCancellation: 'UNTIL_PACKED',
      updatedAt: null,
    });
    /** An order confirmed by its customer through its link: the link's path. */
    const confirmedThroughLink = async () => {
      const placed = await mutate(
        tokens.a,
        `mutation ($input: OrderCreateInput!) {
          orderCreate(input: $input) { order { id name } userErrors { code } }
        }`,
        { input: { lineItems: [{ variantId: kurta, quantity: 1 }], shippingAddress: ADDRESS } },
      );
      const link = await mutate(
        tokens.a,
        'mutation ($id: ID!) { orderLinkCreate(id: $id) { url userErrors { code } } }',
        { id: placed.order.id },
      );
      const path = pathOf(link.url);
      const page = await app.inject({ method: 'GET', url: path });
      await post(path, `shown=${shownIn(page.body)}&action=confirm`);
      return { id: placed.order.id, path };
    };

    const changedMind = await confirmedThroughLink();
    const confirmedPage = (await app.inject({ method: 'GET', url: changedMind.path })).body;
    expect(confirmedPage).toContain('is confirmed');
    expect(confirmedPage).toContain('href="?cancel"');
    // The customer asks to cancel, and is asked whether they are sure.
    const asking = (await app.inject({ method: 'GET', url: `${changedMind.path}?cancel` })).body;
    expect(asking).toContain('Cancel your order?');
    const cancelled = await post(changedMind.path, `shown=${shownIn(asking)}&action=cancel`);
    expect(cancelled.statusCode).toBe(303);
    const ORDER = `query ($id: ID!) {
      order(id: $id) { status confirmationStatus events(first: 1) { nodes { message } } }
    }`;
    expect((await gql(tokens.aReader, ORDER, { id: changedMind.id })).data.order).toEqual({
      status: 'CANCELLED',
      confirmationStatus: 'CONFIRMED',
      events: {
        nodes: [{ message: 'Cancelled by the customer through their link, after confirming it' }],
      },
    });

    // A shop whose customers cancel only until they confirm: the page offers it no more.
    const updated = await mutate(
      settingsToken,
      `mutation {
        orderSettingsUpdate(input: { customerCancellation: UNTIL_CONFIRMED }) {
          orderSettings { customerCancellation } userErrors { code }
        }
      }`,
    );
    expect(updated).toEqual({
      orderSettings: { customerCancellation: 'UNTIL_CONFIRMED' },
      userErrors: [],
    });
    const decided = await confirmedThroughLink();
    const decidedPage = (await app.inject({ method: 'GET', url: decided.path })).body;
    expect(decidedPage).not.toContain('href="?cancel"');
    const stillAsking = (await app.inject({ method: 'GET', url: `${decided.path}?cancel` })).body;
    expect(stillAsking).not.toContain('Cancel your order?');
    const late = await post(decided.path, `shown=${'A'.repeat(22)}&action=cancel`);
    expect(late.statusCode).toBe(409);
    expect((await gql(tokens.aReader, ORDER, { id: decided.id })).data.order.status).toBe('OPEN');
    // Changing them needs write_settings.
    const denied = await gql(
      tokens.a,
      'mutation { orderSettingsUpdate(input: {}) { userErrors { code } } }',
    );
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });
});
