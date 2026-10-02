import { createHmac } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentGateways, SafepayGateway, TestGateway, type GatewayAccount } from './gateways.js';

/** Safepay's own example of a signed webhook, from its .NET SDK's README. */
const SAMPLE = {
  secret: 'a30200d73f7e8a6c7bed2ef2b925d575eb198cf31d1145d9e52c102081cb6065',
  body:
    '{"token":"CNK4P631F43C73AIIF7G","client_id":"sec_c50daabe-49a4-4a62-8adf-25391c36e204",' +
    '"type":"payment:created","endpoint":"https://example.com","notification":{"tracker":' +
    '"track_69b331f2-5ef0-4dd5-bcb4-d288fbdac0ef","reference":"969025","intent":"CYBERSOURCE",' +
    '"fee":"32.77","net":"967.23","user":"hzaidi@getsafepay.com","state":"PAID","amount":' +
    '"1000.00","currency":"PKR","metadata":{"source":"checkout"}},"delivery_attempts":1,' +
    '"resource":"notification","next_attempt_at":"2024-03-06T10:59:36Z","created_at":' +
    '"2024-03-06T10:59:36Z"}',
  signature:
    'ed3b0a78fef22b658e0734a4d9072d148a2cc53c6ebade6323f9bfa6ea1658e5b603f8cea50de1f2887073636' +
    '63f42f50116d777ca634bca6f8ed1adfd462b1a',
};

/** A stand-in for Safepay's API: what it was asked, and what it answers next. */
class FakeSafepay {
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  /** Each request's headers, as {@link requests} lists them. */
  readonly headers: IncomingHttpHeaders[] = [];
  next: { status: number; body: unknown } | null = null;
  /** Answers nothing while set, as a Safepay too slow to answer would. */
  hang = false;
  readonly #held: ServerResponse[] = [];
  server!: Server;
  url = '';

  async start(): Promise<void> {
    this.server = createServer(async (request, response) => {
      this.requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        body: JSON.parse((await bodyOf(request)) || 'null'),
      });
      this.headers.push(request.headers);
      if (this.hang) {
        this.#held.push(response);
        return;
      }
      const answer = this.next ?? {
        status: 201,
        body: {
          data: { token: 'track_6a1f0e8e-0000-4000-8000-000000000001', state: 'TRACKER_STARTED' },
          status: { errors: [], message: 'success' },
        },
      };
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Ends the requests it held unanswered. */
  release(): void {
    for (const response of this.#held.splice(0)) response.destroy();
  }

  async stop(): Promise<void> {
    this.release();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** A port on this machine where nothing listens. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const ACCOUNT: GatewayAccount = {
  environment: 'sandbox',
  credentials: {
    apiKey: 'sec_c50daabe-49a4-4a62-8adf-25391c36e204',
    secretKey: 'v1-secret-of-the-shop',
    webhookSecret: SAMPLE.secret,
  },
};

const REQUEST = {
  amount: 2_500_50n,
  currency: 'PKR' as const,
  orderName: '#1043',
  returnUrl: 'https://hatti.test/o/secret/paid',
  cancelUrl: 'https://hatti.test/o/secret',
};

describe('Safepay', () => {
  const fake = new FakeSafepay();
  let safepay: SafepayGateway;

  beforeAll(async () => {
    await fake.start();
    safepay = new SafepayGateway({
      urls: { sandbox: { api: fake.url, checkout: `${fake.url}/checkout` } },
      timeoutMs: 2_000,
    });
  });

  afterAll(async () => {
    await fake.stop();
  });

  beforeEach(() => {
    fake.requests.length = 0;
    fake.headers.length = 0;
    fake.next = null;
    fake.hang = false;
    fake.release();
  });

  it('starts a tracker for the amount in rupees, then sends the customer to its page', async () => {
    const started = await safepay.checkout(ACCOUNT, REQUEST);
    if (!started.ok) throw new Error(started.message);
    expect(fake.requests).toEqual([
      {
        method: 'POST',
        path: '/order/v1/init',
        body: {
          amount: 2500.5,
          client: ACCOUNT.credentials.apiKey,
          currency: 'PKR',
          environment: 'sandbox',
        },
      },
    ]);
    expect(started.value.ref).toBe('track_6a1f0e8e-0000-4000-8000-000000000001');
    const url = new URL(started.value.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.url}/checkout/pay`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      beacon: 'track_6a1f0e8e-0000-4000-8000-000000000001',
      cancel_url: REQUEST.cancelUrl,
      env: 'sandbox',
      order_id: '#1043',
      redirect_url: REQUEST.returnUrl,
      source: 'custom',
      webhooks: 'true',
    });
  });

  it('says why Safepay refused, and whether trying again may help', async () => {
    fake.next = {
      status: 401,
      body: { data: null, status: { errors: ['invalid client'], message: 'error' } },
    };
    expect(await safepay.checkout(ACCOUNT, REQUEST)).toEqual({
      ok: false,
      retry: false,
      message: 'Safepay: invalid client',
    });
    fake.next = { status: 502, body: {} };
    expect(await safepay.checkout(ACCOUNT, REQUEST)).toEqual({
      ok: false,
      retry: true,
      message: 'Safepay: it answered 502',
    });
    // Safepay nowhere to be reached.
    const nowhere = new SafepayGateway({
      urls: { sandbox: { api: 'http://127.0.0.1:9', checkout: 'http://127.0.0.1:9' } },
      timeoutMs: 1_000,
    });
    const unreachable = await nowhere.checkout(ACCOUNT, REQUEST);
    expect(unreachable).toMatchObject({ ok: false, retry: true });
    if (!unreachable.ok) expect(unreachable.message).toMatch(/^Safepay could not be reached/);
  });

  it("gives a tracker's payment back with the secret key, and says what Safepay answered", async () => {
    const refund = { ref: 'track_1', amount: 4_500_00n, currency: 'PKR' as const };
    fake.next = {
      status: 200,
      body: { data: { token: 'rfnd_7Q2', state: 'REFUNDED' }, status: { errors: [] } },
    };
    expect(await safepay.refund(ACCOUNT, refund)).toEqual({ ok: true, reference: 'rfnd_7Q2' });
    // Its v3 API, which takes amounts in paisa, with the account's secret key.
    expect(fake.requests).toEqual([
      { method: 'POST', path: '/order/payments/v3/track_1/refund', body: { amount: 450000 } },
    ]);
    expect(fake.headers[0]!['x-sfpy-merchant-secret']).toBe(ACCOUNT.credentials.secretKey);
    // Given back with no reference of its own: none.
    fake.next = { status: 201, body: { data: null, status: { errors: [] } } };
    expect(await safepay.refund(ACCOUNT, refund)).toEqual({ ok: true, reference: null });
    // Refused: a 4xx gave nothing back.
    fake.next = {
      status: 400,
      body: { data: null, status: { errors: ['tracker already refunded'], message: 'error' } },
    };
    expect(await safepay.refund(ACCOUNT, refund)).toEqual({
      ok: false,
      unknown: false,
      message: 'Safepay: tracker already refunded',
    });
    // A 5xx, or no answer in time, may have given it back all the same.
    fake.next = { status: 503, body: {} };
    expect(await safepay.refund(ACCOUNT, refund)).toEqual({
      ok: false,
      unknown: true,
      message: 'Safepay: it answered 503',
    });
    fake.hang = true;
    const slow = new SafepayGateway({
      urls: { sandbox: { api: fake.url, checkout: `${fake.url}/checkout` } },
      timeoutMs: 300,
    });
    const late = await slow.refund(ACCOUNT, refund);
    expect(late).toMatchObject({ ok: false, unknown: true });
    if (!late.ok) expect(late.message).toMatch(/^Safepay did not answer/);
    // Never reached, nothing listening where it should be: nothing given back.
    const closed = await closedPort();
    const nowhere = new SafepayGateway({
      urls: { sandbox: { api: `http://127.0.0.1:${closed}`, checkout: 'http://127.0.0.1:9' } },
      timeoutMs: 1_000,
    });
    const unreachable = await nowhere.refund(ACCOUNT, refund);
    expect(unreachable).toMatchObject({ ok: false, unknown: false });
    if (!unreachable.ok) expect(unreachable.message).toMatch(/^Safepay could not be reached/);
    expect(safepay.info.refunds).toBe('whole');
  });

  it('takes the customer back only with the tracker signed with the secret key', () => {
    const tracker = 'track_6a1f0e8e-0000-4000-8000-000000000001';
    const sig = createHmac('sha256', ACCOUNT.credentials.secretKey!).update(tracker).digest('hex');
    expect(
      safepay.returned(ACCOUNT, { tracker, sig, reference: '969025', order_id: '#1043' }),
    ).toEqual({ ref: tracker, amount: null, currency: null, reference: '969025' });
    // Signed in capitals, as some write hex.
    expect(safepay.returned(ACCOUNT, { tracker, sig: sig.toUpperCase() })).toMatchObject({
      ref: tracker,
    });
    // Another tracker, another key, or none at all.
    expect(safepay.returned(ACCOUNT, { tracker: `${tracker}x`, sig })).toBeNull();
    expect(
      safepay.returned(
        { ...ACCOUNT, credentials: { ...ACCOUNT.credentials, secretKey: 'another' } },
        { tracker, sig },
      ),
    ).toBeNull();
    expect(safepay.returned(ACCOUNT, { tracker })).toBeNull();
    expect(safepay.returned(ACCOUNT, {})).toBeNull();
  });

  it("reads Safepay's own signed webhook: the tracker paid, in paisa, and its reference", () => {
    const webhook = {
      body: Buffer.from(SAMPLE.body),
      headers: { 'x-sfpy-signature': SAMPLE.signature },
    };
    expect(safepay.webhook(ACCOUNT, webhook)).toEqual({
      ref: 'track_69b331f2-5ef0-4dd5-bcb4-d288fbdac0ef',
      amount: 1_000_00n,
      currency: 'PKR',
      reference: '969025',
    });
    // Signed with another secret, changed on the way, or not signed.
    expect(
      safepay.webhook(
        { ...ACCOUNT, credentials: { ...ACCOUNT.credentials, webhookSecret: 'another' } },
        webhook,
      ),
    ).toBe('unsigned');
    expect(
      safepay.webhook(ACCOUNT, {
        ...webhook,
        body: Buffer.from(SAMPLE.body.replace('1000.00', '1.00')),
      }),
    ).toBe('unsigned');
    expect(safepay.webhook(ACCOUNT, { ...webhook, headers: {} })).toBe('unsigned');
    expect(safepay.webhook(ACCOUNT, { ...webhook, body: Buffer.from('not json') })).toBe(
      'unsigned',
    );
  });

  it('reads a webhook whose data alone is signed, and leaves what is not a payment made', () => {
    const sign = (data: unknown) =>
      createHmac('sha512', SAMPLE.secret).update(JSON.stringify(data)).digest('hex');
    const event = JSON.parse(SAMPLE.body) as { type: string; notification: { state: string } };
    const wrapped = (data: unknown) => ({
      body: Buffer.from(JSON.stringify({ data })),
      headers: { 'x-sfpy-signature': sign(data) },
    });
    expect(safepay.webhook(ACCOUNT, wrapped(event))).toMatchObject({
      ref: 'track_69b331f2-5ef0-4dd5-bcb4-d288fbdac0ef',
      amount: 1_000_00n,
    });
    // Not paid yet, or a refund: signed, but nothing to record.
    const unpaid = { ...event, notification: { ...event.notification, state: 'PENDING' } };
    expect(safepay.webhook(ACCOUNT, wrapped(unpaid))).toBeNull();
    expect(safepay.webhook(ACCOUNT, wrapped({ ...event, type: 'refund:created' }))).toBeNull();
  });
});

describe('The test gateway', () => {
  it('pays at once: its page is the return address, signed; its webhooks are signed too', async () => {
    const gateway = new TestGateway();
    const account: GatewayAccount = { environment: 'production', credentials: { secret: 's1' } };
    const started = await gateway.checkout(account, REQUEST);
    if (!started.ok) throw new Error(started.message);
    const url = new URL(started.value.url);
    expect(`${url.origin}${url.pathname}`).toBe(REQUEST.returnUrl);
    const form = Object.fromEntries(url.searchParams);
    expect(gateway.returned(account, form)).toEqual({
      ref: started.value.ref,
      amount: null,
      currency: null,
      reference: form.reference,
    });
    expect(gateway.returned({ ...account, credentials: { secret: 's2' } }, form)).toBeNull();
    const webhook = gateway.webhookFor(account, { ref: started.value.ref, amount: 500_00n });
    expect(gateway.webhook(account, webhook)).toMatchObject({
      ref: started.value.ref,
      amount: 500_00n,
    });
    expect(gateway.webhook({ ...account, credentials: { secret: 's2' } }, webhook)).toBe(
      'unsigned',
    );
    gateway.refusing = 'Test gateway: refused';
    expect(await gateway.checkout(account, REQUEST)).toEqual({
      ok: false,
      retry: false,
      message: 'Test gateway: refused',
    });
    expect(gateway.checkouts.map((each) => each.orderName)).toEqual(['#1043']);
  });

  it('gives back any part of a payment, or refuses, or never answers, as a test says', async () => {
    const gateway = new TestGateway();
    const account: GatewayAccount = { environment: 'production', credentials: { secret: 's1' } };
    const refund = { ref: 'test_1', amount: 500_00n, currency: 'PKR' as const };
    expect(gateway.info.refunds).toBe('partial');
    const given = await gateway.refund(account, refund);
    expect(given).toEqual({ ok: true, reference: gateway.refunds[0]!.reference });
    expect(gateway.refunds).toMatchObject([refund]);
    gateway.refundAnswer = { refuse: 'Test gateway: refunds are off' };
    expect(await gateway.refund(account, refund)).toEqual({
      ok: false,
      unknown: false,
      message: 'Test gateway: refunds are off',
    });
    gateway.refundAnswer = 'silent';
    expect(await gateway.refund(account, refund)).toMatchObject({ ok: false, unknown: true });
    expect(gateway.refunds).toHaveLength(1);
  });

  it("says where each gateway's checkout pages are, for the pages that send customers there", () => {
    const safepay = new SafepayGateway();
    expect(safepay.checkoutOrigin('production')).toBe('https://getsafepay.com');
    expect(safepay.checkoutOrigin('sandbox')).toBe('https://sandbox.api.getsafepay.com');
    expect(new TestGateway().checkoutOrigin()).toBeNull();
  });

  it('lists the gateways by name', () => {
    const gateways = new PaymentGateways([new TestGateway(), new SafepayGateway()]);
    expect(gateways.list.map((info) => info.gateway)).toEqual(['safepay', 'test']);
    expect(gateways.of('safepay')?.info.credentials.map((field) => field.key)).toEqual([
      'apiKey',
      'secretKey',
      'webhookSecret',
    ]);
    expect(gateways.of('jazzcash')).toBeNull();
  });
});
