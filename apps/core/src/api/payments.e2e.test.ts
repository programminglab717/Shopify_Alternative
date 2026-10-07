import 'reflect-metadata';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateAccessToken } from '@hatti/api';
import {
  cartPath,
  checkoutsPath,
  type CartChangeResponse,
  type CheckoutPageResponse,
  type CheckoutStartResponse,
} from '@hatti/storefront-api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import {
  EasypaisaGateway,
  JazzCashGateway,
  PayFastGateway,
  PaymentGateways,
  SafepayGateway,
  TestGateway,
  jazzCashHash,
} from '@hatti/payments/public';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const CREDENTIALS = {
  apiKey: 'sec_c50daabe-49a4-4a62-8adf-25391c36e204',
  secretKey: 'v1-secret-of-zari',
  webhookSecret: 'webhook-secret-of-zari',
};

const ACCOUNT = 'id gateway gatewayName environment credentialsHint webhookUrl archivedAt';

const CONNECT = `mutation ($input: PaymentGatewayAccountInput!) {
  paymentGatewayAccountConnect(input: $input) {
    paymentGatewayAccount { ${ACCOUNT} }
    userErrors { field code message }
  }
}`;

const SESSIONS = `query ($orderId: ID!) {
  paymentSessions(orderId: $orderId) {
    id orderId accountId gatewayName environment status gatewayRef amount { amount }
    paidAmount { amount } applied { amount } reference paidThrough paidAt error
  }
}`;

describe.skipIf(!server)('Admin GraphQL API and order pages: payments online', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  let safepay: Server;
  /** Where the stand-in for Safepay answers. */
  let safepayUrl = '';
  /** What Safepay was asked to start, and the trackers it gave. */
  const trackers: { body: Json; token: string }[] = [];
  /** What Safepay was asked to give back, with which secret, and its references. */
  const refunds: { path: string; body: Json; secret: unknown; token: string }[] = [];
  /** How Safepay answers refunds. */
  let refundStatus = 200;
  /** A stand-in for Easypaisa's pages and inquiry (ADR-214): what it was asked, and its answer. */
  let easypaisa: Server;
  let easypaisaUrl = '';
  /** A stand-in for PayFast's tokens (ADR-227). */
  let payfast: Server;
  let payfastUrl = '';
  const inquiries: Json[] = [];
  let inquiryAnswer: Json = {};
  const shop = newId();
  const tokens = { owner: '', clerk: '', reader: '' };

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

  async function data(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  /** A bank-transfer order of a shawl, and its page's path. */
  async function transferOrder(variantId: string): Promise<{ id: string; path: string }> {
    const placed = await data(
      tokens.clerk,
      `mutation ($variantId: ID!) {
        orderCreate(input: {
          lineItems: [{ variantId: $variantId, quantity: 1 }],
          shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                             address1: "House 12, Street 4", city: "Lahore" },
          paymentMethod: BANK_TRANSFER
        }) { order { id } userErrors { code message } }
      }`,
      { variantId },
    );
    const id = placed.order.id as string;
    const linked = await data(
      tokens.clerk,
      'mutation ($id: ID!) { orderLinkCreate(id: $id) { url } }',
      { id },
    );
    return { id, path: new URL(linked.url).pathname };
  }

  /** Asks to pay online on the page, through `gateway` if given: where it sends the customer. */
  async function pay(path: string, gateway?: string) {
    return app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `action=pay${gateway ? `&gateway=${gateway}` : ''}`,
    });
  }

  beforeAll(async () => {
    safepay = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (request.url?.endsWith('/refund')) {
          const token = `rfnd_${newId()}`;
          refunds.push({
            path: request.url,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            secret: request.headers['x-sfpy-merchant-secret'],
            token,
          });
          response.writeHead(refundStatus, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify(
              refundStatus < 300
                ? { data: { token, state: 'REFUNDED' }, status: { errors: [], message: 'success' } }
                : {},
            ),
          );
          return;
        }
        const token = `track_${newId()}`;
        trackers.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')), token });
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            data: { token, state: 'TRACKER_STARTED' },
            status: { errors: [], message: 'success' },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => safepay.listen(0, '127.0.0.1', resolve));
    safepayUrl = `http://127.0.0.1:${(safepay.address() as AddressInfo).port}`;
    const urls = { api: safepayUrl, checkout: `${safepayUrl}/checkout` };
    easypaisa = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        inquiries.push({
          path: request.url,
          credentials: request.headers.credentials,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(inquiryAnswer));
      });
    });
    await new Promise<void>((resolve) => easypaisa.listen(0, '127.0.0.1', resolve));
    easypaisaUrl = `http://127.0.0.1:${(easypaisa.address() as AddressInfo).port}`;
    payfast = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ MERCHANT_ID: '102', ACCESS_TOKEN: 'tok-of-the-basket' }));
      });
    });
    await new Promise<void>((resolve) => payfast.listen(0, '127.0.0.1', resolve));
    payfastUrl = `http://127.0.0.1:${(payfast.address() as AddressInfo).port}`;

    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    tokens.owner = await issueToken(['write_settings', 'write_products', 'read_orders']);
    tokens.clerk = await issueToken(['write_orders']);
    tokens.reader = await issueToken(['read_orders']);
    api = await startTestApi(testDb, {
      paymentGateways: new PaymentGateways([
        new SafepayGateway({ urls: { sandbox: urls, production: urls }, timeoutMs: 2_000 }),
        new JazzCashGateway(),
        new EasypaisaGateway({
          urls: { sandbox: easypaisaUrl, production: easypaisaUrl },
          timeoutMs: 2_000,
        }),
        new PayFastGateway({
          urls: { sandbox: payfastUrl, production: payfastUrl },
          timeoutMs: 2_000,
        }),
        new TestGateway(),
      ]),
    });
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
    await new Promise((resolve) => safepay?.close(resolve));
    await new Promise((resolve) => easypaisa?.close(resolve));
    await new Promise((resolve) => payfast?.close(resolve));
  });

  it("lists gateways, and connects the shop's Safepay account without showing its credentials", async () => {
    expect(
      await data(
        tokens.owner,
        '{ paymentGateways { gateway name credentials { key label } currencies test } }',
      ),
    ).toEqual([
      {
        gateway: 'easypaisa',
        name: 'Easypaisa',
        credentials: [
          { key: 'storeId', label: 'Store ID' },
          { key: 'hashKey', label: 'Hash key' },
          { key: 'accountNum', label: 'Account number' },
          { key: 'username', label: 'API username' },
          { key: 'password', label: 'API password' },
        ],
        currencies: ['PKR'],
        test: false,
      },
      {
        gateway: 'jazzcash',
        name: 'JazzCash',
        credentials: [
          { key: 'merchantId', label: 'Merchant ID' },
          { key: 'password', label: 'Password' },
          { key: 'integritySalt', label: 'Integrity salt' },
          { key: 'walletPin', label: 'Wallet MPIN' },
        ],
        currencies: ['PKR'],
        test: false,
      },
      {
        gateway: 'payfast',
        name: 'PayFast',
        credentials: [
          { key: 'merchantId', label: 'Merchant ID' },
          { key: 'securedKey', label: 'Secured key' },
          { key: 'merchantName', label: 'Merchant name' },
        ],
        currencies: ['PKR'],
        test: false,
      },
      {
        gateway: 'safepay',
        name: 'Safepay',
        credentials: [
          { key: 'apiKey', label: 'API key' },
          { key: 'secretKey', label: 'Secret key' },
          { key: 'webhookSecret', label: 'Webhook secret' },
        ],
        currencies: ['PKR', 'USD'],
        test: false,
      },
      {
        gateway: 'test',
        name: 'Test gateway',
        credentials: [{ key: 'secret', label: 'Any secret' }],
        currencies: ['PKR', 'USD', 'AED', 'SAR', 'GBP', 'EUR', 'CAD'],
        test: true,
      },
    ]);
    // Settings: not for those who work on orders alone.
    expect(
      (await gql(tokens.reader, '{ paymentGatewayAccounts { id } }')).errors?.[0].extensions.code,
    ).toBe('ACCESS_DENIED');
    const input = {
      gateway: 'safepay',
      credentials: Object.entries(CREDENTIALS).map(([key, value]) => ({ key, value })),
    };
    expect((await gql(tokens.clerk, CONNECT, { input })).errors?.[0].extensions.code).toBe(
      'ACCESS_DENIED',
    );
    const connected = await data(tokens.owner, CONNECT, { input });
    expect(connected.userErrors).toEqual([]);
    const account = connected.paymentGatewayAccount;
    expect(account).toEqual({
      id: expect.stringMatching(/^pga_/),
      gateway: 'safepay',
      gatewayName: 'Safepay',
      environment: 'PRODUCTION',
      credentialsHint: 'e204',
      webhookUrl: `http://localhost:4000/webhooks/payments/${account.id}`,
      archivedAt: null,
    });
    expect(await data(tokens.owner, `{ paymentGatewayAccounts { ${ACCOUNT} } }`)).toEqual([
      account,
    ]);
    expect(
      JSON.stringify(await gql(tokens.owner, `{ paymentGatewayAccounts { ${ACCOUNT} } }`)),
    ).not.toContain(CREDENTIALS.secretKey);
  });

  it("sends the customer to Safepay from the order's page; Safepay's webhook pays the order", async () => {
    const created = await data(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Shawl", status: ACTIVE, variants: [{ price: "5,000" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const variantId = created.product.variants[0].id as string;
    await data(
      tokens.owner,
      `mutation {
        bankTransferSettingsUpdate(input: { enabled: true, account: {
          title: "Zari Textiles", bankName: "Standard Chartered",
          iban: "PK36 SCBL 0000 0011 2345 6702" } }) { userErrors { code } }
      }`,
    );
    const [account] = await data(tokens.owner, '{ paymentGatewayAccounts { id webhookUrl } }');
    const order = await transferOrder(variantId);

    const shown = await app.inject({ method: 'GET', url: order.path });
    const page = shown.body;
    expect(page).toContain('<input type="hidden" name="action" value="pay" />');
    expect(page).toContain('Pay Rs 5,000 by card or wallet, through Safepay.');
    // Browsers hold the form's redirect to Safepay to the page's policy: it names Safepay.
    expect(shown.headers['content-security-policy']).toContain(`form-action 'self' ${safepayUrl};`);
    const sent = await pay(order.path);
    expect(sent.statusCode).toBe(303);
    const tracker = trackers.at(-1)!;
    expect(tracker.body).toEqual({
      amount: 5000,
      client: CREDENTIALS.apiKey,
      currency: 'PKR',
      environment: 'production',
    });
    const checkout = new URL(sent.headers.location as string);
    expect(checkout.pathname).toBe('/checkout/pay');
    expect(checkout.searchParams.get('beacon')).toBe(tracker.token);
    expect(checkout.searchParams.get('redirect_url')).toBe(
      `http://localhost:4000${order.path}/paid`,
    );
    expect(checkout.searchParams.get('cancel_url')).toBe(`http://localhost:4000${order.path}`);

    // Safepay's webhook, signed with the account's webhook secret.
    const body = JSON.stringify({
      token: 'CNK4P631F43C73AIIF7G',
      client_id: CREDENTIALS.apiKey,
      type: 'payment:created',
      notification: {
        tracker: tracker.token,
        reference: '969025',
        state: 'PAID',
        amount: '5000.00',
        currency: 'PKR',
      },
      resource: 'notification',
    });
    const webhookPath = new URL(account.webhookUrl).pathname;
    const deliver = (signature: string, path = webhookPath) =>
      app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/json', 'x-sfpy-signature': signature },
        payload: body,
      });
    const signature = createHmac('sha512', CREDENTIALS.webhookSecret).update(body).digest('hex');
    expect((await deliver('0'.repeat(128))).statusCode).toBe(401);
    expect((await deliver(signature, '/webhooks/payments/pga_nothing')).statusCode).toBe(404);
    const delivered = await deliver(signature);
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json()).toEqual({ received: true });
    // Heard twice, recorded once.
    expect((await deliver(signature)).json()).toEqual({ received: true });

    expect(
      await data(
        tokens.reader,
        'query ($id: ID!) { order(id: $id) { stage financialStatus amountPaid { amount } } }',
        { id: order.id },
      ),
    ).toEqual({ stage: 'TO_PACK', financialStatus: 'PAID', amountPaid: { amount: '5000.00' } });
    expect(await data(tokens.reader, SESSIONS, { orderId: order.id })).toEqual([
      {
        id: expect.stringMatching(/^psn_/),
        orderId: order.id,
        accountId: account.id,
        gatewayName: 'Safepay',
        environment: 'PRODUCTION',
        status: 'PAID',
        gatewayRef: tracker.token,
        amount: { amount: '5000.00' },
        paidAmount: { amount: '5000.00' },
        applied: { amount: '5000.00' },
        reference: '969025',
        paidThrough: 'WEBHOOK',
        paidAt: expect.any(String),
        error: null,
      },
    ]);
    // Paid, the page offers nothing more to pay.
    expect((await app.inject({ method: 'GET', url: order.path })).body).not.toContain(
      'name="action" value="pay"',
    );
  });

  it('records the payment when the customer comes back from Safepay, signed', async () => {
    const [variantId] = (
      await data(tokens.owner, '{ products(first: 1) { nodes { variants { id } } } }')
    ).nodes[0].variants.map((variant: Json) => variant.id);
    const order = await transferOrder(variantId);
    expect((await pay(order.path)).statusCode).toBe(303);
    const tracker = trackers.at(-1)!.token;
    const back = (fields: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: `${order.path}/paid`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(fields).toString(),
      });
    // Not signed with the account's secret key: nothing recorded, and the page says it waits.
    const forged = await back({ tracker, sig: 'f'.repeat(64), reference: '1' });
    expect(forged.statusCode).toBe(200);
    expect(forged.body).toContain('We haven&#39;t heard yet that your payment went through');
    const sig = createHmac('sha256', CREDENTIALS.secretKey).update(tracker).digest('hex');
    const returned = await back({ tracker, sig, reference: '969026', order_id: 'whatever' });
    expect(returned.statusCode).toBe(303);
    expect(returned.headers.location).toBe(`${order.path}?paid`);
    const thanked = await app.inject({ method: 'GET', url: `${order.path}?paid` });
    expect(thanked.body).toContain(
      'Thank you: your payment is in, and Zari will send your order soon.',
    );
    expect(await data(tokens.reader, SESSIONS, { orderId: order.id })).toMatchObject([
      {
        status: 'PAID',
        paidThrough: 'RETURN',
        reference: '969026',
        applied: { amount: '5000.00' },
      },
    ]);
    const timeline = await data(
      tokens.reader,
      'query ($id: ID!) { order(id: $id) { events(first: 1) { nodes { message } } } }',
      { id: order.id },
    );
    expect(timeline.events.nodes[0].message).toBe(
      'Rs 5,000 paid online through Safepay, reference 969026, paying it in full',
    );
  });

  it('gives a Safepay payment back whole by orderRefund, and settles one that got no answer', async () => {
    const [variantId] = (
      await data(tokens.owner, '{ products(first: 1) { nodes { variants { id } } } }')
    ).nodes[0].variants.map((variant: Json) => variant.id);
    /** A transfer order paid through Safepay, its customer back with the tracker signed. */
    const paidOrder = async () => {
      const order = await transferOrder(variantId);
      expect((await pay(order.path)).statusCode).toBe(303);
      const tracker = trackers.at(-1)!.token;
      const sig = createHmac('sha256', CREDENTIALS.secretKey).update(tracker).digest('hex');
      const back = await app.inject({
        method: 'POST',
        url: `${order.path}/paid`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ tracker, sig }).toString(),
      });
      expect(back.statusCode).toBe(303);
      return { ...order, tracker };
    };
    const REFUND = `mutation ($id: ID!, $input: OrderRefundInput!) {
      orderRefund(id: $id, input: $input) {
        order { financialStatus amountRefunded { amount } }
        refund { amount { amount } method reference }
        userErrors { field code message }
      }
    }`;
    const REFUNDS = `query ($orderId: ID!) {
      paymentSessions(orderId: $orderId) {
        refunds { id amount { amount } status reference refundId error }
      }
    }`;
    // JazzCash's wallet MPIN is asked for, for its wallet refunds, but not needed (ADR-255).
    const listed = await data(
      tokens.owner,
      '{ paymentGateways { gateway credentials { key optional } } }',
    );
    expect(
      listed.flatMap((each: Json) =>
        each.credentials
          .filter((credential: Json) => credential.optional)
          .map((credential: Json) => `${each.gateway}.${credential.key}`),
      ),
    ).toEqual(['jazzcash.walletPin']);
    expect(await data(tokens.owner, '{ paymentGateways { gateway refunds } }')).toEqual([
      { gateway: 'easypaisa', refunds: 'NONE' },
      { gateway: 'jazzcash', refunds: 'WHOLE' },
      { gateway: 'payfast', refunds: 'NONE' },
      { gateway: 'safepay', refunds: 'WHOLE' },
      { gateway: 'test', refunds: 'PARTIAL' },
    ]);
    const order = await paidOrder();
    // Part of a Safepay payment is given back in its dashboard.
    expect(
      (
        await data(tokens.clerk, REFUND, {
          id: order.id,
          input: { amount: '1000', method: 'ONLINE' },
        })
      ).userErrors,
    ).toEqual([
      {
        field: ['input', 'amount'],
        code: 'INVALID',
        message:
          'Safepay gives a payment back whole through Hatti: Rs 5,000. Refund part of it in its ' +
          'dashboard, then record it',
      },
    ]);
    expect(refunds).toEqual([]);
    const whole = await data(tokens.clerk, REFUND, {
      id: order.id,
      input: { amount: '5000', method: 'ONLINE', note: 'Out of stock' },
    });
    expect(refunds).toEqual([
      {
        path: `/order/payments/v3/${order.tracker}/refund`,
        body: { amount: 500000 },
        secret: CREDENTIALS.secretKey,
        token: expect.stringMatching(/^rfnd_/),
      },
    ]);
    expect(whole).toEqual({
      order: { financialStatus: 'REFUNDED', amountRefunded: { amount: '5000.00' } },
      refund: { amount: { amount: '5000.00' }, method: 'ONLINE', reference: refunds[0]!.token },
      userErrors: [],
    });
    expect(await data(tokens.reader, REFUNDS, { orderId: order.id })).toEqual([
      {
        refunds: [
          {
            id: expect.stringMatching(/^prf_/),
            amount: { amount: '5000.00' },
            status: 'REFUNDED',
            reference: refunds[0]!.token,
            refundId: expect.stringMatching(/^rfd_/),
            error: null,
          },
        ],
      },
    ]);

    // Safepay failing as it was asked: it may have given it back, so staff settle it by hand.
    const second = await paidOrder();
    refundStatus = 503;
    const lost = await data(tokens.clerk, REFUND, {
      id: second.id,
      input: { amount: '5000', method: 'ONLINE' },
    });
    refundStatus = 200;
    expect(lost.userErrors[0].message).toBe(
      'Safepay did not answer, so it may have given it back: check its dashboard, then settle ' +
        'the refund with what it shows (Safepay: it answered 503)',
    );
    const [session] = await data(tokens.reader, REFUNDS, { orderId: second.id });
    expect(session.refunds).toMatchObject([{ status: 'UNKNOWN', refundId: null }]);
    const SETTLE = `mutation ($id: ID!, $input: PaymentRefundSettleInput!) {
      paymentRefundSettle(id: $id, input: $input) {
        paymentRefund { status reference refundId }
        userErrors { field code message }
      }
    }`;
    const lostId = session.refunds[0].id as string;
    expect(
      (await gql(tokens.reader, SETTLE, { id: lostId, input: { refunded: true } })).errors?.[0]
        .extensions.code,
    ).toBe('ACCESS_DENIED');
    expect(
      await data(tokens.clerk, SETTLE, {
        id: lostId,
        input: { refunded: true, reference: 'SP-RF-1' },
      }),
    ).toEqual({
      paymentRefund: {
        status: 'REFUNDED',
        reference: 'SP-RF-1',
        refundId: expect.stringMatching(/^rfd_/),
      },
      userErrors: [],
    });
    const refunded = await data(
      tokens.reader,
      `query ($id: ID!) {
        order(id: $id) { financialStatus refunds { method reference } events(first: 1) { nodes { message } } }
      }`,
      { id: second.id },
    );
    expect(refunded).toEqual({
      financialStatus: 'REFUNDED',
      refunds: [{ method: 'ONLINE', reference: 'SP-RF-1' }],
      events: {
        nodes: [{ message: 'Refunded Rs 5,000 online through Safepay, reference SP-RF-1' }],
      },
    });
  });

  it("takes an order paid online at checkout: Safepay's page, and back to the thank-you page", async () => {
    const asStorefront = { authorization: `Bearer ${TEST_STOREFRONT_KEY}` };
    const [variantId] = (
      await data(tokens.owner, '{ products(first: 1) { nodes { variants { id } } } }')
    ).nodes[0].variants.map((variant: Json) => fromPublicId(variant.id, 'variant'));
    const added = await app.inject({
      method: 'POST',
      url: cartPath(shop, 'add'),
      headers: asStorefront,
      payload: { items: [{ variantId, quantity: 1 }] },
    });
    const started = await app.inject({
      method: 'POST',
      url: checkoutsPath(shop),
      headers: { ...asStorefront, 'x-hatti-cart': (added.json() as CartChangeResponse).token! },
    });
    const path = (started.json() as CheckoutStartResponse).path;
    const secret = path.split('/').at(-1)!;
    const form = (fields: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(fields).toString(),
      });

    // The page offers paying online through the shop's Safepay account.
    const page = (await app.inject({ method: 'GET', url: path })).body;
    expect(page).toContain('name="payment" value="online"');
    const shown = /name="shown" value="([\w-]{22})"/.exec(page)![1]!;
    const placed = await form({
      shown,
      name: 'Ayesha Khan',
      phone: '0300 1234567',
      city: 'Lahore',
      address1: 'House 12, Street 4',
      payment: 'online',
    });
    expect(placed.statusCode).toBe(303);
    const thanks = await app.inject({ method: 'GET', url: path });
    expect(thanks.body).toContain('Pay Rs 5,000 by card or wallet, through Safepay.');
    expect(thanks.headers['content-security-policy']).toContain(
      `form-action 'self' ${safepayUrl};`,
    );

    // On to Safepay, for the order's total.
    const sent = await form({ action: 'pay' });
    expect(sent.statusCode).toBe(303);
    const tracker = trackers.at(-1)!;
    expect(tracker.body).toMatchObject({ amount: 5000, currency: 'PKR' });
    const checkout = new URL(sent.headers.location as string);
    expect(checkout.searchParams.get('redirect_url')).toBe(`http://localhost:4000${path}/paid`);
    // A storefront relaying the page is told where to send the shopper, as it can't follow.
    const relayed = await app.inject({
      method: 'POST',
      url: `${checkoutsPath(shop)}/${secret}`,
      headers: asStorefront,
      payload: { action: 'pay' },
    });
    expect(relayed.json() as CheckoutPageResponse).toEqual({
      placed: false,
      redirect: expect.stringMatching(/\/checkout\/pay\?beacon=track_/),
    });

    // Back from Safepay with the tracker signed: paid, and the page says so.
    const sig = createHmac('sha256', CREDENTIALS.secretKey).update(tracker.token).digest('hex');
    const back = await app.inject({
      method: 'POST',
      url: `${path}/paid`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ tracker: tracker.token, sig, reference: '969027' }).toString(),
    });
    expect([back.statusCode, back.headers.location]).toEqual([303, `${path}?paid`]);
    const paid = (await app.inject({ method: 'GET', url: `${path}?paid` })).body;
    expect(paid).toContain('Thank you: your payment is in, and Zari will send your order soon.');
    expect(paid).not.toContain('value="pay"');
    const { rows } = await admin.query<{ payment_method: string; financial_status: string }>(
      `SELECT payment_method, financial_status FROM orders.orders
        WHERE id = (SELECT order_id FROM checkout.checkouts WHERE shop_id = $1
                     ORDER BY created_at DESC LIMIT 1)`,
      [shop],
    );
    expect(rows).toEqual([{ payment_method: 'online', financial_status: 'paid' }]);
  });

  it("sends the customer on to JazzCash by its signed form, from the order's page and checkout (ADR-163)", async () => {
    for (const each of await data(tokens.owner, '{ paymentGatewayAccounts { id archivedAt } }')) {
      if (each.archivedAt !== null) continue;
      await data(
        tokens.owner,
        'mutation ($id: ID!) { paymentGatewayAccountArchive(id: $id) { userErrors { code } } }',
        { id: each.id },
      );
    }
    const connected = await data(tokens.owner, CONNECT, {
      input: {
        gateway: 'jazzcash',
        credentials: [
          { key: 'merchantId', value: 'MC12345' },
          { key: 'password', value: 'x0y1z2w3' },
          { key: 'integritySalt', value: 'salt-of-zari' },
        ],
      },
    });
    expect(connected.userErrors).toEqual([]);
    expect(connected.paymentGatewayAccount).toMatchObject({
      gateway: 'jazzcash',
      gatewayName: 'JazzCash',
      credentialsHint: '2345',
    });
    const jazzcashPage =
      'https://payments.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/';
    const field = (body: string, name: string) =>
      new RegExp(`name="${name}" value="([^"]*)"`).exec(body)?.[1];

    // From the order's page: the way on, a form posting there, which its policy lets go.
    const created = await data(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Dupatta", status: ACTIVE, variants: [{ price: "2,500" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const order = await transferOrder(created.product.variants[0].id as string);
    const sent = await pay(order.path);
    expect(sent.statusCode).toBe(200);
    expect(sent.headers['content-security-policy']).toContain(
      "form-action 'self' https://payments.jazzcash.com.pk",
    );
    expect(sent.body).toContain(`<form method="post" action="${jazzcashPage}">`);
    expect([field(sent.body, 'pp_MerchantID'), field(sent.body, 'pp_Amount')]).toEqual([
      'MC12345',
      '250000',
    ]);
    // Back from JazzCash, posted and signed with the salt: paid.
    const back = {
      pp_Amount: '250000',
      pp_MerchantID: 'MC12345',
      pp_ResponseCode: '000',
      pp_RetreivalReferenceNo: '261002143512',
      pp_TxnCurrency: 'PKR',
      pp_TxnRefNo: field(sent.body, 'pp_TxnRefNo')!,
    };
    const returned = await app.inject({
      method: 'POST',
      url: `${order.path}/paid`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        ...back,
        pp_SecureHash: jazzCashHash('salt-of-zari', back, false),
      }).toString(),
    });
    expect([returned.statusCode, returned.headers.location]).toEqual([303, `${order.path}?paid`]);
    const { rows } = await admin.query<{ financial_status: string }>(
      'SELECT financial_status FROM orders.orders WHERE id = $1',
      [fromPublicId(order.id, 'order')],
    );
    expect(rows).toEqual([{ financial_status: 'paid' }]);

    // From checkout's thank-you page, as a storefront relays it: the page with the form.
    const asStorefront = { authorization: `Bearer ${TEST_STOREFRONT_KEY}` };
    const added = await app.inject({
      method: 'POST',
      url: cartPath(shop, 'add'),
      headers: asStorefront,
      payload: {
        items: [
          { variantId: fromPublicId(created.product.variants[0].id, 'variant'), quantity: 1 },
        ],
      },
    });
    const started = await app.inject({
      method: 'POST',
      url: checkoutsPath(shop),
      headers: { ...asStorefront, 'x-hatti-cart': (added.json() as CartChangeResponse).token! },
    });
    const path = (started.json() as CheckoutStartResponse).path;
    const secret = path.split('/').at(-1)!;
    const shown = /name="shown" value="([\w-]{22})"/.exec(
      (await app.inject({ method: 'GET', url: path })).body,
    )![1]!;
    const placed = await app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        shown,
        name: 'Ayesha Khan',
        phone: '0300 1234567',
        city: 'Lahore',
        address1: 'House 12, Street 4',
        payment: 'online',
      }).toString(),
    });
    expect(placed.statusCode).toBe(303);
    const relayed = (
      await app.inject({
        method: 'POST',
        url: `${checkoutsPath(shop)}/${secret}`,
        headers: asStorefront,
        payload: { action: 'pay' },
      })
    ).json() as CheckoutPageResponse & { html?: string; status?: number };
    expect([relayed.placed, relayed.status]).toEqual([false, 200]);
    expect(relayed.html).toContain(`<form method="post" action="${jazzcashPage}">`);
    expect(field(relayed.html!, 'pp_ReturnURL')).toBe(`http://localhost:4000${path}/paid`);
  });

  it("takes the customer through Easypaisa's two pages, and believes its return once its inquiry agrees (ADR-214)", async () => {
    for (const each of await data(tokens.owner, '{ paymentGatewayAccounts { id archivedAt } }')) {
      if (each.archivedAt !== null) continue;
      await data(
        tokens.owner,
        'mutation ($id: ID!) { paymentGatewayAccountArchive(id: $id) { userErrors { code } } }',
        { id: each.id },
      );
    }
    const connected = await data(tokens.owner, CONNECT, {
      input: {
        gateway: 'easypaisa',
        credentials: [
          { key: 'storeId', value: '43512' },
          { key: 'hashKey', value: 'ZARIHASHKEY12345' },
          { key: 'accountNum', value: '03001234567' },
          { key: 'username', value: 'zari' },
          { key: 'password', value: 'pw-of-zari' },
        ],
      },
    });
    expect(connected.userErrors).toEqual([]);
    expect(connected.paymentGatewayAccount).toMatchObject({
      gateway: 'easypaisa',
      gatewayName: 'Easypaisa',
      credentialsHint: '3512',
    });
    const field = (body: string, name: string) =>
      new RegExp(`name="${name}" value="([^"]*)"`).exec(body)?.[1];
    const created = await data(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Shawl", status: ACTIVE, variants: [{ price: "3,000" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const order = await transferOrder(created.product.variants[0].id as string);

    // From the order's page: a form posting to Easypaisa's first page.
    const sent = await pay(order.path);
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toContain(`<form method="post" action="${easypaisaUrl}/easypay/Index.jsf">`);
    const back = `http://localhost:4000${order.path}/paid`;
    expect([field(sent.body, 'amount'), field(sent.body, 'postBackURL')]).toEqual(['3000.0', back]);
    const ref = field(sent.body, 'orderRefNum')!;

    // Back with its token: the page posting it on to Easypaisa's next one, as no script may.
    const partway = await app.inject({
      method: 'GET',
      url: `${order.path}/paid?auth_token=tok-9cXq2`,
    });
    expect(partway.statusCode).toBe(200);
    expect(partway.body).toContain(
      `<form method="post" action="${easypaisaUrl}/easypay/Confirm.jsf">`,
    );
    expect([field(partway.body, 'auth_token'), field(partway.body, 'postBackURL')]).toEqual([
      'tok-9cXq2',
      back,
    ]);
    expect(inquiries).toEqual([]);

    // Back saying it is paid: asked of Easypaisa at once, with the account's API credentials.
    inquiryAnswer = {
      orderId: ref,
      storeId: 43512,
      transactionStatus: 'PAID',
      transactionAmount: 3000,
      transactionId: '24681357',
      responseCode: '0000',
      responseDesc: 'SUCCESS',
    };
    const returned = await app.inject({
      method: 'GET',
      url: `${order.path}/paid?status=0000&desc=Success&orderRefNumber=${ref}`,
    });
    expect([returned.statusCode, returned.headers.location]).toEqual([303, `${order.path}?paid`]);
    expect(inquiries).toEqual([
      {
        path: '/easypay-service/rest/v4/inquire-transaction',
        credentials: Buffer.from('zari:pw-of-zari').toString('base64'),
        body: { orderId: ref, storeId: '43512', accountNum: '03001234567' },
      },
    ]);
    const sessions = await data(tokens.reader, SESSIONS, { orderId: order.id });
    expect(sessions[0]).toMatchObject({
      gatewayName: 'Easypaisa',
      status: 'PAID',
      gatewayRef: ref,
      reference: '24681357',
      paidThrough: 'RETURN',
    });
    const { rows } = await admin.query<{ financial_status: string }>(
      'SELECT financial_status FROM orders.orders WHERE id = $1',
      [fromPublicId(order.id, 'order')],
    );
    expect(rows).toEqual([{ financial_status: 'paid' }]);
  });

  it("offers each of the shop's live accounts on the order's page, the customer choosing which (ADR-219)", async () => {
    for (const each of await data(tokens.owner, '{ paymentGatewayAccounts { id archivedAt } }')) {
      if (each.archivedAt !== null) continue;
      await data(
        tokens.owner,
        'mutation ($id: ID!) { paymentGatewayAccountArchive(id: $id) { userErrors { code } } }',
        { id: each.id },
      );
    }
    for (const input of [
      {
        gateway: 'jazzcash',
        credentials: [
          { key: 'merchantId', value: 'MC12345' },
          { key: 'password', value: 'x0y1z2w3' },
          { key: 'integritySalt', value: 'salt-of-zari' },
        ],
      },
      {
        gateway: 'safepay',
        credentials: Object.entries(CREDENTIALS).map(([key, value]) => ({ key, value })),
      },
    ]) {
      expect((await data(tokens.owner, CONNECT, { input })).userErrors).toEqual([]);
    }
    const created = await data(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Chador", status: ACTIVE, variants: [{ price: "3,000" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const order = await transferOrder(created.product.variants[0].id as string);

    // Both offered, in the order the shop connected them, and either's page let through.
    const page = await app.inject({ method: 'GET', url: order.path });
    expect(page.body).toContain('name="gateway" value="jazzcash"');
    expect(page.body).toContain('name="gateway" value="safepay"');
    expect(page.body).toContain('Pay Rs 3,000 by card or wallet, through JazzCash or Safepay.');
    expect(page.headers['content-security-policy']).toContain(
      `form-action 'self' https://payments.jazzcash.com.pk ${safepayUrl};`,
    );
    // Through the one chosen: Safepay's page, or JazzCash's form.
    const viaSafepay = await pay(order.path, 'safepay');
    expect(viaSafepay.statusCode).toBe(303);
    expect(viaSafepay.headers.location).toMatch(new RegExp(`^${safepayUrl}/checkout`));
    const viaJazzcash = await pay(order.path, 'jazzcash');
    expect(viaJazzcash.statusCode).toBe(200);
    expect(viaJazzcash.body).toContain('Continue to JazzCash');
    // One the shop takes nothing through: the page again, saying paying online isn't working.
    const refused = await pay(order.path, 'easypaisa');
    expect(refused.statusCode).toBe(503);
    const sessions = await data(tokens.reader, SESSIONS, { orderId: order.id });
    expect(sessions.map((each: Json) => each.gatewayName).sort()).toEqual(['JazzCash', 'Safepay']);

    // The shop puts Safepay first (ADR-221): the page offers it first.
    const REORDER = `mutation ($ids: [ID!]!) {
      paymentGatewayAccountsReorder(ids: $ids) {
        paymentGatewayAccounts { gateway }
        userErrors { field code message }
      }
    }`;
    const live = await data(tokens.owner, '{ paymentGatewayAccounts { id gateway } }');
    expect(live.map((each: Json) => each.gateway)).toEqual(['jazzcash', 'safepay']);
    const ids = live.map((each: Json) => each.id).reverse();
    expect((await gql(tokens.clerk, REORDER, { ids })).errors?.[0].extensions.code).toBe(
      'ACCESS_DENIED',
    );
    expect(await data(tokens.owner, REORDER, { ids: ids.slice(1) })).toEqual({
      paymentGatewayAccounts: null,
      userErrors: [
        {
          field: ['ids'],
          code: 'INVALID',
          message: "List each of the shop's live accounts: Safepay is missing",
        },
      ],
    });
    expect(await data(tokens.owner, REORDER, { ids })).toEqual({
      paymentGatewayAccounts: [{ gateway: 'safepay' }, { gateway: 'jazzcash' }],
      userErrors: [],
    });
    const reordered = await app.inject({ method: 'GET', url: order.path });
    expect(reordered.body).toContain(
      'Pay Rs 3,000 by card or wallet, through Safepay or JazzCash.',
    );
    expect(reordered.body.indexOf('value="safepay"')).toBeLessThan(
      reordered.body.indexOf('value="jazzcash"'),
    );
  });

  it("takes the shop's discount for paying online off orders paid online at checkout (ADR-222)", async () => {
    const SETTINGS = `mutation ($input: OnlinePaymentSettingsInput!) {
      onlinePaymentSettingsUpdate(input: $input) {
        onlinePaymentSettings { discount { kind percentage cap { amount } amount { amount } } }
        userErrors { field code message }
      }
    }`;
    expect(
      await data(tokens.owner, '{ onlinePaymentSettings { discount { kind } updatedAt } }'),
    ).toEqual({ discount: null, updatedAt: null });
    const fivePercent = { percentage: 5, cap: '200' };
    expect(
      (await gql(tokens.clerk, SETTINGS, { input: { discount: fivePercent } })).errors?.[0]
        .extensions.code,
    ).toBe('ACCESS_DENIED');
    expect(
      await data(tokens.owner, SETTINGS, { input: { discount: { percentage: 5, amount: '100' } } }),
    ).toEqual({
      onlinePaymentSettings: null,
      userErrors: [
        {
          field: ['input', 'discount', 'amount'],
          code: 'INVALID',
          message: 'Take a percentage or an amount off, not both',
        },
      ],
    });
    expect(await data(tokens.owner, SETTINGS, { input: { discount: fivePercent } })).toEqual({
      onlinePaymentSettings: {
        discount: { kind: 'PERCENTAGE', percentage: 5, cap: { amount: '200.00' }, amount: null },
      },
      userErrors: [],
    });

    // Checkout says it beside paying online, and takes it off the order placed so.
    const asStorefront = { authorization: `Bearer ${TEST_STOREFRONT_KEY}` };
    const created = await data(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Shawl", status: ACTIVE, variants: [{ price: "6,000" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const variantId = fromPublicId(created.product.variants[0].id as string, 'variant');
    const added = await app.inject({
      method: 'POST',
      url: cartPath(shop, 'add'),
      headers: asStorefront,
      payload: { items: [{ variantId, quantity: 1 }] },
    });
    const started = await app.inject({
      method: 'POST',
      url: checkoutsPath(shop),
      headers: { ...asStorefront, 'x-hatti-cart': (added.json() as CartChangeResponse).token! },
    });
    const path = (started.json() as CheckoutStartResponse).path;
    const page = (await app.inject({ method: 'GET', url: path })).body;
    expect(page).toContain('Pay online, by card or wallet, Rs 200 off:');
    const placed = await app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        shown: /name="shown" value="([\w-]{22})"/.exec(page)![1]!,
        name: 'Ayesha Khan',
        phone: '0300 1234567',
        city: 'Lahore',
        address1: 'House 12, Street 4',
        payment: 'online',
      }).toString(),
    });
    expect(placed.statusCode).toBe(303);
    const { rows } = await admin.query<{ order_id: string }>(
      `SELECT order_id FROM checkout.checkouts WHERE shop_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [shop],
    );
    const order = await data(
      tokens.reader,
      `query ($id: ID!) {
        order(id: $id) {
          paymentMethod totalDiscounts { amount } onlineDiscount { amount }
          transferDiscount { amount } subtotalPrice { amount }
        }
      }`,
      { id: toPublicId('order', rows[0]!.order_id) },
    );
    expect(order).toEqual({
      paymentMethod: 'ONLINE',
      totalDiscounts: { amount: '200.00' },
      onlineDiscount: { amount: '200.00' },
      transferDiscount: { amount: '0.00' },
      subtotalPrice: { amount: '6000.00' },
    });
    const thanks = await app.inject({ method: 'GET', url: path });
    expect(thanks.body).toContain('Online payment discount');
    expect(thanks.body).toContain('Pay Rs 5,800 by card or wallet');
  });

  it('sends the customer to PayFast with a token for the basket, and takes its word at the webhook, in the address too (ADR-227)', async () => {
    for (const each of await data(tokens.owner, '{ paymentGatewayAccounts { id archivedAt } }')) {
      if (each.archivedAt !== null) continue;
      await data(
        tokens.owner,
        'mutation ($id: ID!) { paymentGatewayAccountArchive(id: $id) { userErrors { code } } }',
        { id: each.id },
      );
    }
    const connected = await data(tokens.owner, CONNECT, {
      input: {
        gateway: 'payfast',
        credentials: [
          { key: 'merchantId', value: '102' },
          { key: 'securedKey', value: 'zU3pQ8vX1kL9' },
          { key: 'merchantName', value: 'Zari' },
        ],
      },
    });
    expect(connected.userErrors).toEqual([]);
    const field = (body: string, name: string) =>
      new RegExp(`name="${name}" value="([^"]*)"`).exec(body)?.[1];
    const created = await data(
      tokens.owner,
      `mutation {
        productCreate(input: { title: "Ajrak", status: ACTIVE, variants: [{ price: "3,000" }] }) {
          product { variants { id } }
        }
      }`,
    );
    const order = await transferOrder(created.product.variants[0].id as string);

    // From the order's page: a form posting to PayFast with the token, which its policy lets go.
    const sent = await pay(order.path);
    expect(sent.statusCode).toBe(200);
    expect(sent.headers['content-security-policy']).toContain(`form-action 'self' ${payfastUrl}`);
    expect(sent.body).toContain(
      `<form method="post" action="${payfastUrl}/Ecommerce/api/Transaction/PostTransaction">`,
    );
    expect(field(sent.body, 'TOKEN')).toBe('tok-of-the-basket');
    const webhookUrl = connected.paymentGatewayAccount.webhookUrl as string;
    expect(field(sent.body, 'CHECKOUT_URL')).toBe(webhookUrl);
    const basket = field(sent.body, 'BASKET_ID')!;

    // Its word in the webhook's address: refused unless signed with the secured key.
    const webhook = new URL(webhookUrl).pathname;
    const outcome = new URLSearchParams({
      basket_id: basket,
      err_code: '000',
      err_msg: 'Success',
      transaction_id: '8820261002143512',
      validation_hash: createHash('sha256').update(`${basket}|zU3pQ8vX1kL9|102|000`).digest('hex'),
    });
    const forged = new URLSearchParams(outcome);
    forged.set('validation_hash', '0'.repeat(64));
    expect((await app.inject({ method: 'GET', url: `${webhook}?${forged}` })).statusCode).toBe(401);
    const got = await app.inject({ method: 'GET', url: `${webhook}?${outcome}` });
    expect([got.statusCode, got.json()]).toEqual([200, { received: true }]);
    const { rows } = await admin.query<{ financial_status: string }>(
      'SELECT financial_status FROM orders.orders WHERE id = $1',
      [fromPublicId(order.id, 'order')],
    );
    expect(rows).toEqual([{ financial_status: 'paid' }]);
    // Posted as a form as well: paid already, and once.
    const posted = await app.inject({
      method: 'POST',
      url: webhook,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: outcome.toString(),
    });
    expect([posted.statusCode, posted.json()]).toEqual([200, { received: true }]);
    const sessions = await data(tokens.owner, SESSIONS, { orderId: order.id });
    expect(sessions.map((each: Json) => [each.status, each.paidThrough, each.reference])).toEqual([
      ['PAID', 'WEBHOOK', '8820261002143512'],
    ]);
  });
});
