import 'reflect-metadata';
import {
  constants,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
} from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InputChecker } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { toPublicId } from '@hatti/ids';
import { checkAddress, orderLinkPage, type PrepaidDiscountInput } from '@hatti/orders/public';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jazzCashHash } from './gateways.js';
import {
  PAYMENT_INQUIRIES,
  RETURN_INQUIRY_SECONDS,
  SESSION_LIMITS,
  paymentsUnderwayIn,
} from './online-payment.service.js';
import { errorsOf, paymentsFixture, unwrap, type PaymentsFixture } from './test-support.js';

const server = testDatabaseServer();

/** A stand-in for Easypaisa's inquiry (ADR-214): what it was asked, and what it answers next. */
class FakeEasypaisa {
  readonly asked: unknown[] = [];
  next: Record<string, unknown> = {};
  url = '';
  readonly server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      this.asked.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(this.next));
    });
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** A stand-in for Baadmay's order status (ADR-226): what it was asked, and what it answers next. */
class FakeBaadmay {
  readonly asked: { path: string; authorization: string | undefined }[] = [];
  next: Record<string, unknown> = {};
  url = '';
  readonly server = createServer((request, response) => {
    this.asked.push({ path: request.url ?? '', authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(this.next));
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** A stand-in for PayFast's tokens (ADR-227): what it was asked, as forms. */
class FakePayFast {
  readonly asked: Record<string, string>[] = [];
  url = '';
  readonly server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      this.asked.push(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ MERCHANT_ID: '102', ACCESS_TOKEN: 'tok-of-the-basket' }));
    });
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/**
 * A stand-in for Bank Alfalah's handshake and order status (ADR-228): what it was asked, and what
 * its status answers next.
 */
class FakeAlfalah {
  readonly asked: { method: string; path: string; form: Record<string, string> }[] = [];
  status: Record<string, unknown> = {};
  url = '';
  readonly server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      this.asked.push({ method: request.method ?? '', path: request.url ?? '', form });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        request.method === 'POST'
          ? JSON.stringify({
              success: 'true',
              AuthToken: 'tok%2bof%3d%3d',
              ReturnURL: form.HS_ReturnURL,
            })
          : JSON.stringify(JSON.stringify(this.status)),
      );
    });
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/**
 * A stand-in for HBL's session API (ADR-229), its own keys made for the test: the orders it was
 * asked for, opened with its private key.
 */
class FakeHbl {
  readonly keys = generateKeyPairSync('rsa', { modulusLength: 2_048 });
  readonly orders: ({ ADDITIONAL_DATA: Record<string, unknown> } & Record<string, unknown>)[] = [];
  url = '';
  readonly server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>;
      const [key, iv] = privateDecrypt(
        { key: this.keys.privateKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(body.Data3!, 'base64'),
      )
        .toString('utf8')
        .split('||');
      const decipher = createDecipheriv('aes-256-cbc', Buffer.from(key!), Buffer.from(iv!));
      this.orders.push(
        JSON.parse(
          Buffer.concat([decipher.update(body.Data4!, 'base64'), decipher.final()]).toString(),
        ),
      );
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ IsSuccess: true, ResponseCode: 0, Data: { SESSION_ID: 'sess-of-zari' } }),
      );
    });
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server.close(resolve));
  }
}

describe.skipIf(!server)('Payments online', () => {
  let f: PaymentsFixture;
  let kurta: string;
  const easypaisa = new FakeEasypaisa();
  const baadmay = new FakeBaadmay();
  const payfast = new FakePayFast();
  const alfalah = new FakeAlfalah();
  const hbl = new FakeHbl();

  beforeAll(async () => {
    await easypaisa.start();
    await baadmay.start();
    await payfast.start();
    await alfalah.start();
    await hbl.start();
    f = await paymentsFixture(server!, {
      easypaisaUrl: easypaisa.url,
      baadmayUrl: baadmay.url,
      payfastUrl: payfast.url,
      alfalahUrl: alfalah.url,
      hblUrl: hbl.url,
    });
  });

  afterAll(async () => {
    await f?.close();
    await easypaisa.stop();
    await baadmay.stop();
    await payfast.stop();
    await alfalah.stop();
    await hbl.stop();
  });

  beforeEach(async () => {
    await f.reset();
    kurta = await f.variantOf(f.a, 'Kurta', '2,000');
  });

  /** The test gateway's account of the shop, opened as the gateway is called with it. */
  const opened = async (accountId: string) => {
    const { rows } = await f.admin.query<{ environment: 'sandbox' | 'production' }>(
      'SELECT environment FROM payments.gateway_accounts WHERE id = $1',
      [accountId],
    );
    const { rows: shops } = await f.admin.query<{ shop_id: string }>(
      'SELECT shop_id FROM payments.gateway_accounts WHERE id = $1',
      [accountId],
    );
    return {
      environment: rows[0]!.environment,
      credentials: { secret: `secret-${shops[0]!.shop_id.slice(0, 8)}` },
    };
  };

  /** The form the test gateway sends the customer back with, from the address it gave. */
  const formOf = (url: string) => Object.fromEntries(new URL(url).searchParams);

  it("connects the shop's own account with a gateway, sealed, one live account a gateway", async () => {
    expect(errorsOf(await f.accounts.connect(f.a, {}))).toEqual([['input.gateway', 'BLANK']]);
    expect(
      errorsOf(
        await f.accounts.connect(f.a, {
          gateway: 'paypal',
          environment: 'staging' as 'sandbox',
          credentials: [],
        }),
      ),
    ).toEqual([
      ['input.gateway', 'INVALID'],
      ['input.environment', 'INVALID'],
    ]);
    const safepay = (credentials: { key: string; value: string }[]) =>
      f.accounts.connect(f.a, { gateway: 'safepay', credentials });
    const missing = await safepay([{ key: 'apiKey', value: 'sec_abc' }]);
    expect(errorsOf(missing)).toEqual([['input.credentials', 'BLANK']]);
    expect(missing.ok ? null : missing.errors[0]!.message).toBe(
      'Safepay needs its Secret key and Webhook secret',
    );
    expect(
      errorsOf(
        await safepay([
          { key: 'apiKey', value: 'sec abc' },
          { key: 'apiKey', value: 'sec_abc' },
          { key: 'token', value: 'x' },
        ]),
      ),
    ).toEqual([
      ['input.credentials.0.value', 'INVALID'],
      ['input.credentials.2.key', 'INVALID'],
      ['input.credentials', 'BLANK'],
    ]);

    const connected = unwrap(
      await safepay([
        { key: 'apiKey', value: ' sec_c50daabe-49a4-4a62-8adf-25391c36e204 ' },
        { key: 'secretKey', value: 'the-secret-key' },
        { key: 'webhookSecret', value: 'the-webhook-secret' },
      ]),
    );
    expect(connected).toMatchObject({
      gateway: 'safepay',
      gatewayName: 'Safepay',
      environment: 'production',
      credentialsHint: 'e204',
      webhookUrl: `https://hatti.test/webhooks/payments/${toPublicId('paymentGatewayAccount', connected.id)}`,
      archivedAt: null,
    });
    // Sealed: the secrets are nowhere in the row, and never in the audit log.
    const { rows } = await f.admin.query<{ credentials: string }>(
      'SELECT credentials FROM payments.gateway_accounts',
    );
    expect(rows[0]!.credentials).not.toContain('the-secret-key');
    const { rows: audit } = await f.admin.query<{ action: string; details: unknown }>(
      'SELECT action, details FROM platform.audit_log ORDER BY occurred_at',
    );
    expect(audit).toEqual([
      {
        action: 'payment_gateway_account.connected',
        details: { gateway: 'safepay', environment: 'production', credentialsHint: 'e204' },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain('secret-key');
    // One live account a gateway.
    expect(
      errorsOf(
        await safepay([
          { key: 'apiKey', value: 'sec_2' },
          { key: 'secretKey', value: 's' },
          { key: 'webhookSecret', value: 'w' },
        ]),
      ),
    ).toEqual([['input.gateway', 'TAKEN']]);

    // Its sandbox needs its own credentials.
    expect(
      errorsOf(await f.accounts.update(f.a, connected.id, { environment: 'sandbox' })),
    ).toEqual([['input.credentials', 'BLANK']]);
    expect(errorsOf(await f.accounts.update(f.a, connected.id, { gateway: 'test' }))).toEqual([
      ['input.gateway', 'INVALID'],
    ]);
    const sandbox = unwrap(
      await f.accounts.update(f.a, connected.id, {
        environment: 'sandbox',
        credentials: [
          { key: 'apiKey', value: 'sec_sandbox-0001' },
          { key: 'secretKey', value: 'sandbox-secret' },
          { key: 'webhookSecret', value: 'sandbox-webhook' },
        ],
      }),
    );
    expect(sandbox).toMatchObject({ environment: 'sandbox', credentialsHint: '0001' });
    // Nothing given, nothing changed.
    expect(unwrap(await f.accounts.update(f.a, connected.id, {})).updatedAt).toEqual(
      sandbox.updatedAt,
    );
    expect(
      (await f.outbox())
        .filter((event) => event.event_type.startsWith('payment_gateway_account.'))
        .map((event) => [event.event_type, event.payload.changed]),
    ).toEqual([
      ['payment_gateway_account.connected', undefined],
      ['payment_gateway_account.updated', ['environment', 'credentials']],
    ]);

    // The other shop sees none of it.
    expect(await f.accounts.list(f.b)).toEqual([]);
    expect(await f.accounts.get(f.b, connected.id)).toBeNull();
    expect(errorsOf(await f.accounts.archive(f.b, connected.id))).toEqual([['id', 'NOT_FOUND']]);

    const archived = unwrap(await f.accounts.archive(f.a, connected.id));
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(await f.accounts.list(f.a)).toEqual([]);
    expect((await f.accounts.list(f.a, { archived: true })).map((each) => each.id)).toEqual([
      connected.id,
    ]);
    expect(
      errorsOf(
        await f.accounts.update(f.a, connected.id, {
          credentials: [{ key: 'apiKey', value: 'x' }],
        }),
      ),
    ).toEqual([['id', 'INVALID']]);
    // Archived, another may be connected.
    await f.connectTest(f.a);
    expect((await f.accounts.list(f.a)).map((each) => each.gateway)).toEqual(['test']);
  });

  it("takes what a transfer order waits for through the shop's gateway, from its page", async () => {
    const order = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    // No gateway: transfers alone.
    const before = await f.links.viewLink(token);
    if (before.kind !== 'order') throw new Error(before.kind);
    expect(before.onlinePayment).toBeNull();
    expect(await f.links.payOnline(token)).toMatchObject({
      problem: { kind: 'too_late', action: 'pay' },
    });

    const accountId = await f.connectTest(f.a);
    const view = await f.links.viewLink(token);
    if (view.kind !== 'order') throw new Error(view.kind);
    expect(view.onlinePayment).toEqual({
      gateways: [{ gateway: 'test', name: 'Test gateway', origin: null }],
      amount: 2_000_00n,
    });
    const page = orderLinkPage(view).html;
    expect(page).toContain('<input type="hidden" name="action" value="pay" />');
    expect(page).toContain('Pay Rs 2,000 by card or wallet, through Test gateway.');

    const started = await f.links.payOnline(token);
    if (!('url' in started)) throw new Error(JSON.stringify(started));
    expect(started.url.startsWith(`https://hatti.test/o/${token}/paid?`)).toBe(true);
    expect(f.testGateway.checkouts).toMatchObject([
      {
        amount: 2_000_00n,
        currency: 'PKR',
        orderName: `#${order.number}`,
        returnUrl: `https://hatti.test/o/${token}/paid`,
        cancelUrl: `https://hatti.test/o/${token}`,
      },
    ]);
    // Asked again soon after, the same checkout.
    expect(await f.links.payOnline(token)).toEqual(started);
    expect(f.testGateway.checkouts).toHaveLength(1);
    const [open] = await f.payments.sessionsOf(f.a.shopId, order.id);
    expect(open).toMatchObject({
      accountId,
      status: 'open',
      amount: 2_000_00n,
      environment: 'production',
      gatewayRef: f.testGateway.checkouts[0]!.ref,
      paidAt: null,
    });

    // Back with a form that is not the gateway's: nothing recorded, and the page says so.
    const forged = await f.links.paidOnline(token, { ...formOf(started.url), sig: '00' });
    expect(forged).toMatchObject({ problem: { kind: 'payment', reason: 'pending' } });
    expect((await f.orders.get(f.a, order.id))!.amountPaid).toBe(0n);

    // Back with the gateway's signed form: paid, once, however often the page is reloaded.
    for (let i = 0; i < 2; i++) {
      const back = await f.links.paidOnline(token, formOf(started.url));
      if (back.kind !== 'order') throw new Error(back.kind);
      expect(back.problem).toBeNull();
    }
    expect(await f.orders.get(f.a, order.id)).toMatchObject({
      amountPaid: 2_000_00n,
      financialStatus: 'paid',
      stage: 'to_pack',
    });
    const reference = formOf(started.url).reference!;
    expect((await f.timeline(f.a, order.id))[0]).toBe(
      `Rs 2,000 paid online through Test gateway, reference ${reference}, paying it in full`,
    );
    expect(await f.payments.sessionsOf(f.a.shopId, order.id)).toMatchObject([
      {
        status: 'paid',
        paidAmount: 2_000_00n,
        applied: 2_000_00n,
        reference,
        paidThrough: 'return',
      },
    ]);
    expect(
      (await f.outbox())
        .map((event) => event.event_type)
        .filter((type) => type.startsWith('payment_session') || type === 'order.paid'),
    ).toEqual(['payment_session.started', 'order.paid', 'payment_session.paid']);
    // Paid, the page offers nothing more to pay.
    const after = await f.links.viewLink(token);
    if (after.kind !== 'order') throw new Error(after.kind);
    expect(after.onlinePayment).toBeNull();
    expect(await f.links.payOnline(token)).toMatchObject({
      problem: { kind: 'too_late', action: 'pay' },
    });
    // The other shop sees none of it.
    expect(await f.payments.sessionsOf(f.b.shopId, order.id)).toEqual([]);
  });

  it("offers each of the shop's live accounts on the order's page, the customer choosing which (ADR-219)", async () => {
    const order = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    const testAccount = await f.connectTest(f.a);
    const jazzcash = unwrap(
      await f.accounts.connect(f.a, {
        gateway: 'jazzcash',
        environment: 'production',
        credentials: [
          { key: 'merchantId', value: 'MC12345' },
          { key: 'password', value: 'x0y1z2w3' },
          { key: 'integritySalt', value: 'salt-of-zari' },
        ],
      }),
    );
    const view = await f.links.viewLink(token);
    if (view.kind !== 'order') throw new Error(view.kind);
    // In the order the shop added them, each a button of its own.
    expect(view.onlinePayment?.gateways.map((each) => each.gateway)).toEqual(['test', 'jazzcash']);
    const page = orderLinkPage(view);
    expect(page.html).toContain(
      '<button class="button stack" type="submit" name="gateway" value="jazzcash">',
    );
    expect(page.html).toContain('Pay with JazzCash');
    expect(page.html).toContain(
      'Pay Rs 2,000 by card or wallet, through Test gateway or JazzCash.',
    );
    expect(page.contentSecurityPolicy).toContain(
      "form-action 'self' https://payments.jazzcash.com.pk",
    );

    // Through the one chosen: JazzCash's form, on its account.
    const started = await f.links.payOnline(token, 'jazzcash');
    if ('url' in started || started.kind !== 'order' || !started.gatewayForm) {
      throw new Error(JSON.stringify(started));
    }
    expect(started.gatewayForm.gateway).toBe('JazzCash');
    expect(orderLinkPage(started).html).toContain('Continue to JazzCash');
    // None chosen, as a page from before: the first. One the shop has no live account with: not.
    expect('url' in (await f.links.payOnline(token))).toBe(true);
    expect(await f.links.payOnline(token, 'easypaisa')).toMatchObject({
      problem: { kind: 'payment', reason: 'unavailable' },
    });
    const sessions = await f.payments.sessionsOf(f.a.shopId, order.id);
    expect(sessions.map((each) => each.accountId).sort()).toEqual(
      [testAccount, jazzcash.id].sort(),
    );
  });

  it("offers the shop's live accounts in the order it puts them, one connected later last (ADR-221)", async () => {
    const testAccount = await f.connectTest(f.a);
    const jazzcash = unwrap(
      await f.accounts.connect(f.a, {
        gateway: 'jazzcash',
        credentials: [
          { key: 'merchantId', value: 'MC12345' },
          { key: 'password', value: 'x0y1z2w3' },
          { key: 'integritySalt', value: 'salt-of-zari' },
        ],
      }),
    );
    const safepay = unwrap(
      await f.accounts.connect(f.a, {
        gateway: 'safepay',
        credentials: [
          { key: 'apiKey', value: 'sec_abc' },
          { key: 'secretKey', value: 'secret-key' },
          { key: 'webhookSecret', value: 'webhook-secret' },
        ],
      }),
    );
    const offered = async () =>
      (await f.db.tenant(f.a.shopId, (tx) => f.payments.gatewaysOf(tx, f.a.shopId, 'PKR'))).map(
        (each) => each.gateway,
      );
    // In the order the shop connected them, until it puts them in its own.
    expect(await offered()).toEqual(['test', 'jazzcash', 'safepay']);
    await f.admin.query('DELETE FROM platform.outbox_events');
    await f.admin.query('DELETE FROM platform.audit_log');

    const order = [safepay.id, testAccount, jazzcash.id];
    const reordered = unwrap(await f.accounts.reorder(f.a, order));
    expect(reordered.map((each) => each.gateway)).toEqual(['safepay', 'test', 'jazzcash']);
    expect(await offered()).toEqual(['safepay', 'test', 'jazzcash']);
    expect((await f.accounts.list(f.a)).map((each) => each.id)).toEqual(order);
    // The same order again changes nothing.
    expect(unwrap(await f.accounts.reorder(f.a, order)).map((each) => each.id)).toEqual(order);
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      [
        'payment_gateway_accounts.reordered',
        {
          gateways: ['safepay', 'test', 'jazzcash'],
          actorKind: 'app',
          actorId: expect.any(String),
        },
      ],
    ]);
    const { rows: audit } = await f.admin.query<{ action: string; details: unknown }>(
      'SELECT action, details FROM platform.audit_log ORDER BY occurred_at',
    );
    expect(audit).toEqual([
      {
        action: 'payment_gateway_accounts.reordered',
        details: {
          before: ['test', 'jazzcash', 'safepay'],
          after: ['safepay', 'test', 'jazzcash'],
        },
      },
    ]);

    // Each live account once, and none else.
    const missing = await f.accounts.reorder(f.a, [safepay.id, testAccount]);
    expect(errorsOf(missing)).toEqual([['ids', 'INVALID']]);
    expect(missing.ok ? null : missing.errors[0]!.message).toBe(
      "List each of the shop's live accounts: JazzCash is missing",
    );
    expect(errorsOf(await f.accounts.reorder(f.a, [safepay.id, safepay.id, jazzcash.id]))).toEqual([
      ['ids.1', 'INVALID'],
    ]);
    expect(errorsOf(await f.accounts.reorder(f.a, [...order, safepay.id]))).toEqual([
      ['ids', 'TOO_MANY'],
    ]);
    // An archived account is offered to nobody; one connected after goes last.
    unwrap(await f.accounts.archive(f.a, testAccount));
    expect(errorsOf(await f.accounts.reorder(f.a, [testAccount, jazzcash.id]))).toEqual([
      ['ids.0', 'NOT_FOUND'],
    ]);
    const again = await f.connectTest(f.a);
    expect(await offered()).toEqual(['safepay', 'jazzcash', 'test']);
    expect((await f.accounts.list(f.a, { archived: true })).map((each) => each.id)).toEqual([
      safepay.id,
      jazzcash.id,
      again,
      testAccount,
    ]);
    // Another shop's accounts are its own.
    await f.connectTest(f.b);
    expect(errorsOf(await f.accounts.reorder(f.b, [jazzcash.id]))).toEqual([
      ['ids.0', 'NOT_FOUND'],
    ]);
    expect(await offered()).toEqual(['safepay', 'jazzcash', 'test']);
  });

  it("keeps the shop's discount for paying online, checked and audited, which an order placed online keeps (ADR-222)", async () => {
    const update = (discount: PrepaidDiscountInput | null) => f.settings.update(f.a, { discount });
    const blank = await update({});
    expect(errorsOf(blank)).toEqual([['input.discount.percentage', 'BLANK']]);
    expect(blank.ok ? null : blank.errors[0]!.message).toBe(
      'Say what paying online takes off: a percentage or an amount',
    );
    expect(errorsOf(await update({ amount: '100', cap: '50' }))).toEqual([
      ['input.discount.cap', 'INVALID'],
    ]);
    expect(await f.settings.get(f.a)).toEqual({ discount: null, updatedAt: null });

    const fivePercent = { kind: 'percentage', percentageBps: 500, cap: 300_00n } as const;
    expect(unwrap(await update({ percentage: 5, cap: '300' })).discount).toEqual(fivePercent);
    // The same again changes nothing; another shop's are its own.
    unwrap(await update({ percentage: 5.0, cap: '300.00' }));
    expect((await f.settings.get(f.b)).discount).toBeNull();
    const offered = () => f.db.tenant(f.a.shopId, (tx) => f.payments.discountOf(tx, f.a.shopId));
    expect(await offered()).toEqual(fivePercent);
    unwrap(await update({ amount: '150' }));
    expect(unwrap(await update(null)).discount).toBeNull();
    expect(await offered()).toBeNull();
    expect(
      (await f.outbox())
        .filter((event) => event.event_type.startsWith('online_payment_settings.'))
        .map((event) => event.payload),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        changed: ['discount'],
        actorKind: 'app',
        actorId: expect.any(String),
      })),
    );
    const { rows: audit } = await f.admin.query<{
      details: { discount: unknown; before: unknown };
    }>('SELECT details FROM platform.audit_log ORDER BY occurred_at');
    const percentage = { percentage: 5, cap: '300.00' };
    expect(audit.map((row) => [row.details.discount, row.details.before])).toEqual([
      [percentage, { discount: null }],
      [{ amount: '150.00' }, { discount: percentage }],
      [null, { discount: { amount: '150.00' } }],
    ]);

    // An order placed online as checkout places it: Rs 200 off by a code, then Rs 100 for paying
    // online, apart.
    await f.connectTest(f.a);
    const place = (paymentMethod: 'online' | 'bank_transfer', discount: bigint, off: bigint) =>
      f.db.tenant(f.a.shopId, (tx) =>
        f.orders.placeIn(
          tx,
          {
            shopId: f.a.shopId,
            currency: 'PKR',
            actor: 'system',
            source: 'online_store',
            how: 'from the online store',
          },
          {
            field: [],
            lines: [{ variantId: kurta, quantity: 1, price: null }],
            address: checkAddress(new InputChecker(), [], {
              name: 'Ayesha Khan',
              phone: '0300 1234567',
              address1: 'House 12, Street 4',
              city: 'Lahore',
            })!,
            email: null,
            paymentMethod,
            shipping: 250_00n,
            discount,
            onlineDiscount: off,
            discountCodes: ['EID10'],
            advance: 0n,
            locationId: null,
            note: '',
            tags: [],
          },
        ),
      );
    const order = unwrap(await place('online', 300_00n, 100_00n));
    expect(order).toMatchObject({
      paymentMethod: 'online',
      subtotal: 2_000_00n,
      discount: 300_00n,
      onlineDiscount: 100_00n,
      transferDiscount: 0n,
      total: 1_950_00n,
    });
    // Only an order paid online has it, and it is part of the order's discount.
    await expect(place('bank_transfer', 100_00n, 100_00n)).rejects.toThrow(
      'Only an order paid online has a discount for it',
    );
    await expect(place('online', 0n, 100_00n)).rejects.toThrow(
      "The discount for paying online is part of the order's discount",
    );
    // Its page says it apart from the code's.
    const view = await f.links.viewLink(await f.linkOf(f.a, order.id));
    if (view.kind !== 'order') throw new Error(view.kind);
    expect(orderLinkPage(view).html).toMatch(
      /Discount<\/span>[\s\S]*?-Rs 200[\s\S]*?Online payment discount<\/span>[\s\S]*?-Rs 100/,
    );
  });

  it("takes what an order waits for through JazzCash's page, by a signed form (ADR-163)", async () => {
    const order = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    // Its wallet's MPIN, which its wallet refunds alone ask for, is checked when given (ADR-255).
    const pin = await f.accounts.connect(f.a, {
      gateway: 'jazzcash',
      environment: 'production',
      credentials: [
        { key: 'merchantId', value: 'MC12345' },
        { key: 'password', value: 'x0y1z2w3' },
        { key: 'integritySalt', value: 'salt-of-zari' },
        { key: 'walletPin', value: '12ab' },
      ],
    });
    expect(
      pin.ok ? null : pin.errors.map((error) => [error.field.join('.'), error.message]),
    ).toEqual([
      ['input.credentials.3.value', "Value must be the merchant wallet's MPIN: 4 to 6 digits"],
    ]);
    unwrap(
      await f.accounts.connect(f.a, {
        gateway: 'jazzcash',
        environment: 'production',
        credentials: [
          { key: 'merchantId', value: 'MC12345' },
          { key: 'password', value: 'x0y1z2w3' },
          { key: 'integritySalt', value: 'salt-of-zari' },
        ],
      }),
    );
    const view = await f.links.viewLink(token);
    if (view.kind !== 'order') throw new Error(view.kind);
    expect(view.onlinePayment).toEqual({
      gateways: [
        { gateway: 'jazzcash', name: 'JazzCash', origin: 'https://payments.jazzcash.com.pk' },
      ],
      amount: 2_000_00n,
    });

    // Its page takes a form: the page with it, its fields hidden, and its policy letting it go.
    const started = await f.links.payOnline(token);
    if ('url' in started || started.kind !== 'order' || !started.gatewayForm) {
      throw new Error(JSON.stringify(started));
    }
    const { url, form } = started.gatewayForm;
    expect(url).toBe(
      'https://payments.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/',
    );
    expect(form).toMatchObject({
      pp_MerchantID: 'MC12345',
      pp_Amount: '200000',
      pp_BillReference: String(order.number),
      pp_ReturnURL: `https://hatti.test/o/${token}/paid`,
    });
    const page = orderLinkPage(started);
    expect(page.html).toContain(`<form method="post" action="${url}">`);
    expect(page.html).toContain(
      `<input type="hidden" name="pp_TxnRefNo" value="${form.pp_TxnRefNo}" />`,
    );
    expect(page.html).toContain('Continue to JazzCash');
    expect(page.html).toContain('Pay Rs 2,000 on JazzCash&#39;s page, by card, wallet or voucher.');
    expect(page.contentSecurityPolicy).toContain(
      "form-action 'self' https://payments.jazzcash.com.pk",
    );
    // Its form is never kept, so another is made each time it is asked for.
    const again = await f.links.payOnline(token);
    if ('url' in again || again.kind !== 'order' || !again.gatewayForm) throw new Error();
    expect(again.gatewayForm.form.pp_TxnRefNo).not.toBe(form.pp_TxnRefNo);
    const { rows } = await f.admin.query<{ checkout_url: string | null }>(
      'SELECT checkout_url FROM payments.sessions WHERE order_id = $1',
      [order.id],
    );
    expect(rows).toEqual([{ checkout_url: null }, { checkout_url: null }]);

    // Back from JazzCash, signed with the account's salt: paid, once.
    const back = {
      pp_Amount: '200000',
      pp_MerchantID: 'MC12345',
      pp_ResponseCode: '000',
      pp_RetreivalReferenceNo: '261002143512',
      pp_TxnCurrency: 'PKR',
      pp_TxnRefNo: form.pp_TxnRefNo!,
    };
    const signed = { ...back, pp_SecureHash: jazzCashHash('salt-of-zari', back, false) };
    expect(await f.links.paidOnline(token, { ...signed, pp_Amount: '100' })).toMatchObject({
      problem: { kind: 'payment', reason: 'pending' },
    });
    const paid = await f.links.paidOnline(token, signed);
    if (paid.kind !== 'order') throw new Error(paid.kind);
    expect(paid.problem).toBeNull();
    expect(await f.orders.get(f.a, order.id)).toMatchObject({
      amountPaid: 2_000_00n,
      financialStatus: 'paid',
    });
    expect((await f.timeline(f.a, order.id))[0]).toBe(
      'Rs 2,000 paid online through JazzCash, reference 261002143512, paying it in full',
    );
  });

  it("takes what an order waits for through Easypaisa's pages, believing its return once its inquiry agrees (ADR-214)", async () => {
    const order = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    const credentials = (hashKey: string) => [
      { key: 'storeId', value: '43512' },
      { key: 'hashKey', value: hashKey },
      { key: 'accountNum', value: '03001234567' },
      { key: 'username', value: 'zari' },
      { key: 'password', value: 'pw-of-zari' },
    ];
    // Its hash key is a key for AES: 16, 24 or 32 characters.
    const short = await f.accounts.connect(f.a, {
      gateway: 'easypaisa',
      environment: 'production',
      credentials: credentials('short-key'),
    });
    if (short.ok) throw new Error('connected');
    expect(short.errors.map((error) => [error.field.join('.'), error.message])).toEqual([
      ['input.credentials.1.value', 'Value must be the 16, 24 or 32 characters Easypaisa gave'],
      ['input.credentials', 'Easypaisa needs its Hash key'],
    ]);
    unwrap(
      await f.accounts.connect(f.a, {
        gateway: 'easypaisa',
        environment: 'production',
        credentials: credentials('ZARIHASHKEY12345'),
      }),
    );

    // Its page takes a form, posted from the order's page.
    const started = await f.links.payOnline(token);
    if ('url' in started || started.kind !== 'order' || !started.gatewayForm) {
      throw new Error(JSON.stringify(started));
    }
    const back = `https://hatti.test/o/${token}/paid`;
    expect(started.gatewayForm.url).toBe(`${easypaisa.url}/easypay/Index.jsf`);
    expect(started.gatewayForm.form).toMatchObject({
      amount: '2000.0',
      storeId: '43512',
      postBackURL: back,
    });
    const ref = started.gatewayForm.form.orderRefNum!;

    // Back with its token: on to its next page, posted there with the address to come back to.
    const partway = await f.links.paidOnline(token, { auth_token: 'tok-9cXq2' });
    if (partway.kind !== 'order') throw new Error(partway.kind);
    expect(partway.gatewayForm).toEqual({
      url: `${easypaisa.url}/easypay/Confirm.jsf`,
      form: { auth_token: 'tok-9cXq2', postBackURL: back },
      gateway: 'Easypaisa',
    });
    const page = orderLinkPage(partway);
    expect(page.html).toContain(
      `<form method="post" action="${easypaisa.url}/easypay/Confirm.jsf">`,
    );
    expect(page.html).toContain('Continue to Easypaisa');
    expect(easypaisa.asked).toEqual([]);

    // Back saying it is paid: Easypaisa's inquiry is asked at once, and believed alone.
    const answer = {
      orderId: ref,
      storeId: '43512',
      transactionStatus: 'PENDING',
      transactionAmount: '2000.0',
      transactionId: '24681357',
      responseCode: '0000',
      responseDesc: 'SUCCESS',
    };
    easypaisa.next = answer;
    const returned = { status: '0000', desc: 'Success', orderRefNumber: ref };
    expect(await f.links.paidOnline(token, returned)).toMatchObject({
      problem: { kind: 'payment', reason: 'pending' },
    });
    expect(easypaisa.asked).toEqual([
      { orderId: ref, storeId: '43512', accountNum: '03001234567' },
    ]);
    // Asked again within the minute, it waits; a return naming no session of the order asks none.
    easypaisa.next = { ...answer, transactionStatus: 'PAID' };
    expect(await f.links.paidOnline(token, returned)).toMatchObject({
      problem: { kind: 'payment', reason: 'pending' },
    });
    expect(await f.links.paidOnline(token, { ...returned, orderRefNumber: 'E1' })).toMatchObject({
      problem: { kind: 'payment', reason: 'pending' },
    });
    expect(easypaisa.asked).toHaveLength(1);
    await f.admin.query(
      `UPDATE payments.sessions
          SET inquired_at = now() - make_interval(secs => $2)
        WHERE order_id = $1`,
      [order.id, RETURN_INQUIRY_SECONDS + 1],
    );
    const paid = await f.links.paidOnline(token, returned);
    if (paid.kind !== 'order') throw new Error(paid.kind);
    expect(paid.problem).toBeNull();
    expect(easypaisa.asked).toHaveLength(2);
    expect(await f.orders.get(f.a, order.id)).toMatchObject({
      amountPaid: 2_000_00n,
      financialStatus: 'paid',
    });
    const [session] = await f.payments.sessionsOf(f.a.shopId, order.id);
    expect(session).toMatchObject({
      gateway: 'easypaisa',
      gatewayName: 'Easypaisa',
      status: 'paid',
      gatewayRef: ref,
      paidThrough: 'return',
      reference: '24681357',
    });
    expect((await f.timeline(f.a, order.id))[0]).toBe(
      'Rs 2,000 paid online through Easypaisa, reference 24681357, paying it in full',
    );
    // Paid, its return asks nothing more.
    expect(await f.links.paidOnline(token, returned)).toMatchObject({ problem: null });
    expect(easypaisa.asked).toHaveLength(2);
  });

  it('takes what an order waits for through Baadmay, believing its return once its status agrees (ADR-226)', async () => {
    const order = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    const apiKey = '6f1c2a9e-1b7d-4c3a-9d5e-2f8b7a6c5d4e';
    unwrap(
      await f.accounts.connect(f.a, {
        gateway: 'baadmay',
        environment: 'production',
        credentials: [{ key: 'apiKey', value: apiKey }],
      }),
    );

    // Its page is linked to, the order in its address: the order's item and its customer.
    const started = await f.links.payOnline(token);
    if (!('url' in started)) throw new Error(JSON.stringify(started));
    expect(started.url.startsWith(`${baadmay.url}/?q=`)).toBe(true);
    const sent = JSON.parse(
      Buffer.from(started.url.slice(started.url.indexOf('?q=') + 3), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    const ref = sent.orderId as string;
    expect(sent).toMatchObject({
      apiKey,
      totalAmount: 2000,
      items: [{ itemId: '1', name: 'Kurta', qty: 1, price: 2000 }],
      customer: {
        firstname: 'Ayesha',
        lastname: 'Khan',
        address: ['House 12, Street 4', ''],
        city: 'Lahore',
        telephone: '03001234567',
      },
      shipping: { cost: 0 },
      successUrl: `https://hatti.test/o/${token}/paid?order_ref=${ref}`,
      failedUrl: `https://hatti.test/o/${token}`,
    });
    expect(baadmay.asked).toEqual([]);

    // Back with Baadmay's ID for it: its status is asked at once, by that ID, with the API key.
    const answer = { baadmayOrderId: '88123', orderId: ref, status: 'pending', totalAmount: 2000 };
    baadmay.next = answer;
    const returned = { order_ref: ref, baadmayOrderId: '88123' };
    expect(await f.links.paidOnline(token, returned)).toMatchObject({
      problem: { kind: 'payment', reason: 'pending' },
    });
    expect(baadmay.asked).toEqual([{ path: '/v1/orders/88123', authorization: apiKey }]);
    await f.admin.query(
      `UPDATE payments.sessions
          SET inquired_at = now() - make_interval(secs => $2)
        WHERE order_id = $1`,
      [order.id, RETURN_INQUIRY_SECONDS + 1],
    );
    baadmay.next = { ...answer, status: 'success' };
    const paid = await f.links.paidOnline(token, returned);
    if (paid.kind !== 'order') throw new Error(paid.kind);
    expect(paid.problem).toBeNull();
    expect(await f.orders.get(f.a, order.id)).toMatchObject({
      amountPaid: 2_000_00n,
      financialStatus: 'paid',
    });
    const [session] = await f.payments.sessionsOf(f.a.shopId, order.id);
    expect(session).toMatchObject({
      gateway: 'baadmay',
      gatewayName: 'Baadmay',
      status: 'paid',
      gatewayRef: ref,
      paidThrough: 'return',
      reference: '88123',
    });
    expect(baadmay.asked).toHaveLength(2);
  });

  it("takes what an order waits for through PayFast's page, its word signed with the secured key (ADR-227)", async () => {
    const order = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    const connected = unwrap(
      await f.accounts.connect(f.a, {
        gateway: 'payfast',
        environment: 'production',
        credentials: [
          { key: 'merchantId', value: '102' },
          { key: 'securedKey', value: 'zU3pQ8vX1kL9' },
          { key: 'merchantName', value: 'Zari' },
        ],
      }),
    );

    // A token asked for the basket first, then a form posted to its page, from the order's page.
    const started = await f.links.payOnline(token);
    if ('url' in started || started.kind !== 'order' || !started.gatewayForm) {
      throw new Error(JSON.stringify(started));
    }
    expect(started.gatewayForm.url).toBe(
      `${payfast.url}/Ecommerce/api/Transaction/PostTransaction`,
    );
    const basket = started.gatewayForm.form.BASKET_ID!;
    expect(payfast.asked).toEqual([
      {
        MERCHANT_ID: '102',
        SECURED_KEY: 'zU3pQ8vX1kL9',
        BASKET_ID: basket,
        TXNAMT: '2000.00',
        CURRENCY_CODE: 'PKR',
      },
    ]);
    expect(started.gatewayForm.form).toMatchObject({
      TOKEN: 'tok-of-the-basket',
      TXNAMT: '2000.00',
      SUCCESS_URL: `https://hatti.test/o/${token}/paid`,
      FAILURE_URL: `https://hatti.test/o/${token}`,
      CHECKOUT_URL: connected.webhookUrl,
      CUSTOMER_MOBILE_NO: '03001234567',
    });
    expect(Object.values(started.gatewayForm.form)).not.toContain('zU3pQ8vX1kL9');

    // Its word at the webhook, signed with the secured key: paid once, and again as paid.
    const outcome = {
      basket_id: basket,
      err_code: '000',
      err_msg: 'Success',
      transaction_id: '8820261002143512',
      validation_hash: createHash('sha256').update(`${basket}|zU3pQ8vX1kL9|102|000`).digest('hex'),
    };
    const publicId = connected.webhookUrl.split('/').at(-1)!;
    const word = { body: Buffer.from(new URLSearchParams(outcome).toString()), headers: {} };
    expect(await f.payments.webhook(publicId, word)).toBe('paid');
    expect(await f.payments.webhook(publicId, word)).toBe('paid');
    expect(await f.orders.get(f.a, order.id)).toMatchObject({
      amountPaid: 2_000_00n,
      financialStatus: 'paid',
    });
    const [session] = await f.payments.sessionsOf(f.a.shopId, order.id);
    expect(session).toMatchObject({
      gateway: 'payfast',
      gatewayName: 'PayFast',
      status: 'paid',
      gatewayRef: basket,
      paidThrough: 'webhook',
      reference: '8820261002143512',
    });
    // The customer back with the same outcome: nothing more.
    expect(await f.links.paidOnline(token, outcome)).toMatchObject({ problem: null });
    // Made with another key: refused.
    const forged = { ...outcome, validation_hash: createHash('sha256').update('x').digest('hex') };
    expect(
      await f.payments.webhook(publicId, {
        body: Buffer.from(new URLSearchParams(forged).toString()),
        headers: {},
      }),
    ).toBe('unsigned');
  });

  it("takes what an order waits for through Bank Alfalah's page, believing its return once its status agrees (ADR-228)", async () => {
    const order = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    const credentials = (key2: string) => [
      { key: 'merchantId', value: '12345' },
      { key: 'storeId', value: '000456' },
      { key: 'merchantHash', value: 'OUU362MB1upzA1ZUyK3oyD7NZ2ICm6qy' },
      { key: 'merchantUsername', value: 'zari-apg' },
      { key: 'merchantPassword', value: 'pw-of-zari' },
      { key: 'key1', value: 'Kx9qT2mR7vB4nH1w' },
      { key: 'key2', value: key2 },
    ];
    // Its keys are AES's: 16 characters each.
    const short = await f.accounts.connect(f.a, {
      gateway: 'alfalah',
      environment: 'production',
      credentials: credentials('short'),
    });
    if (short.ok) throw new Error('connected');
    expect(short.errors.map((error) => [error.field.join('.'), error.message])).toEqual([
      ['input.credentials.6.value', 'Value must be the 16 characters Bank Alfalah gave'],
      ['input.credentials', 'Bank Alfalah needs its Key 2'],
    ]);
    unwrap(
      await f.accounts.connect(f.a, {
        gateway: 'alfalah',
        environment: 'production',
        credentials: credentials('P3sL8dF6jZ0cY5gE'),
      }),
    );

    // Its handshake first, then its page takes a form, posted from the order's page.
    const started = await f.links.payOnline(token);
    if ('url' in started || started.kind !== 'order' || !started.gatewayForm) {
      throw new Error(JSON.stringify(started));
    }
    expect(alfalah.asked.map((each) => [each.method, each.path])).toEqual([['POST', '/HS/HS/HS']]);
    expect(started.gatewayForm.url).toBe(`${alfalah.url}/SSO/SSO/SSO`);
    const ref = started.gatewayForm.form.TransactionReferenceNumber!;
    expect(started.gatewayForm.form).toMatchObject({
      AuthToken: 'tok%2bof%3d%3d',
      ReturnURL: `https://hatti.test/o/${token}/paid`,
      TransactionAmount: '2000',
      MerchantUsername: 'zari-apg',
    });

    // Back saying it is paid: its status is asked at once, and believed alone.
    alfalah.status = {
      ResponseCode: '00',
      MerchantId: '12345',
      StoreId: '000456',
      TransactionReferenceNumber: ref,
      TransactionId: 'T6612345',
      TransactionAmount: '2000',
      TransactionStatus: 'Paid',
    };
    const paid = await f.links.paidOnline(token, { TS: 'P', RC: '00', RD: '', O: ref });
    if (paid.kind !== 'order') throw new Error(paid.kind);
    expect(paid.problem).toBeNull();
    expect(alfalah.asked.at(-1)).toMatchObject({
      method: 'GET',
      path: `/HS/api/IPN/OrderStatus/12345/000456/${ref}`,
    });
    expect(await f.orders.get(f.a, order.id)).toMatchObject({
      amountPaid: 2_000_00n,
      financialStatus: 'paid',
    });
    const [session] = await f.payments.sessionsOf(f.a.shopId, order.id);
    expect(session).toMatchObject({
      gateway: 'alfalah',
      gatewayName: 'Bank Alfalah',
      status: 'paid',
      gatewayRef: ref,
      paidThrough: 'return',
      reference: 'T6612345',
    });
  });

  it("takes what an order waits for through HBL's page, its return opened with the shop's private key (ADR-229)", async () => {
    const order = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    const shop = generateKeyPairSync('rsa', { modulusLength: 2_048 });
    // The keys as staff paste them, PEM, armour and line breaks and all.
    const pem = (key: string) => key.trim();
    const credentials = (privateKey: string) => [
      { key: 'userId', value: 'zari-mid' },
      { key: 'password', value: 'pw-of-zari' },
      { key: 'channel', value: 'HBLPay_Zari_Website' },
      {
        key: 'hblPublicKey',
        value: pem(hbl.keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
      },
      { key: 'privateKey', value: privateKey },
    ];
    const wrong = await f.accounts.connect(f.a, {
      gateway: 'hbl',
      environment: 'production',
      credentials: credentials('my-private-key'),
    });
    if (wrong.ok) throw new Error('connected');
    expect(wrong.errors.map((error) => [error.field.join('.'), error.message])).toEqual([
      [
        'input.credentials.4.value',
        "Value must be the shop's own private key, whose public key HBL was given, as PEM or XML",
      ],
      ['input.credentials', 'HBL needs its Private key'],
    ]);
    unwrap(
      await f.accounts.connect(f.a, {
        gateway: 'hbl',
        environment: 'production',
        credentials: credentials(
          pem(shop.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
        ),
      }),
    );

    // A session asked for, and the customer sent to HBL's page with it.
    const started = await f.links.payOnline(token);
    if (!('url' in started)) throw new Error(JSON.stringify(started));
    expect(started.url).toBe(
      `${hbl.url}/page#/checkout?data=${Buffer.from('sess-of-zari').toString('base64')}`,
    );
    const asked = hbl.orders.at(-1)!;
    const ref = asked.ADDITIONAL_DATA.REFERENCE_NUMBER as string;
    expect(asked).toMatchObject({
      RETURN_URL: `https://hatti.test/o/${token}/paid`,
      ORDER: { SUBTOTAL: '2000.00' },
      ADDITIONAL_DATA: { BILL_TO_FORENAME: 'Ayesha', BILL_TO_PHONE: '03001234567' },
    });

    // Back with the outcome encrypted to the shop's public key: paid.
    const text = `RESPONSE_CODE=100&RESPONSE_MESSAGE=Success&ORDER_REF_NUMBER=${ref}&GUID=g-77`;
    const data = publicEncrypt(
      { key: shop.publicKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(text),
    ).toString('base64');
    const paid = await f.links.paidOnline(token, { data: data.replace(/\+/g, ' ') });
    if (paid.kind !== 'order') throw new Error(paid.kind);
    expect(paid.problem).toBeNull();
    expect(await f.orders.get(f.a, order.id)).toMatchObject({
      amountPaid: 2_000_00n,
      financialStatus: 'paid',
    });
    const [session] = await f.payments.sessionsOf(f.a.shopId, order.id);
    expect(session).toMatchObject({
      gateway: 'hbl',
      gatewayName: 'HBL',
      status: 'paid',
      gatewayRef: ref,
      paidThrough: 'return',
      reference: 'g-77',
    });
  });

  it('records what its webhook says is paid, once, and what was paid beyond what was owed', async () => {
    const order = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    const accountId = await f.connectTest(f.a);
    const account = await opened(accountId);
    const publicId = toPublicId('paymentGatewayAccount', accountId);
    const first = await f.links.payOnline(token);
    if (!('url' in first)) throw new Error(JSON.stringify(first));
    const ref = f.testGateway.checkouts[0]!.ref;

    // Not signed with the account's secret, an account not known, or a payment not started here.
    const webhook = f.testGateway.webhookFor(account, { ref, amount: 2_000_00n });
    expect(
      await f.payments.webhook(publicId, {
        ...webhook,
        headers: { 'x-test-signature': 'f'.repeat(64) },
      }),
    ).toBe('unsigned');
    expect(await f.payments.webhook('pga_nothing', webhook)).toBe('not_found');
    expect(await f.payments.webhook(toPublicId('paymentGatewayAccount', order.id), webhook)).toBe(
      'not_found',
    );
    expect(
      await f.payments.webhook(
        publicId,
        f.testGateway.webhookFor(account, { ref: 'test_elsewhere', amount: 1_00n }),
      ),
    ).toBe('ignored');

    // Before the customer is back: paid, once.
    expect(await f.payments.webhook(publicId, webhook)).toBe('paid');
    expect(await f.payments.webhook(publicId, webhook)).toBe('paid');
    expect((await f.orders.get(f.a, order.id))!.amountPaid).toBe(2_000_00n);
    expect(await f.payments.sessionsOf(f.a.shopId, order.id)).toMatchObject([
      { status: 'paid', paidThrough: 'webhook', applied: 2_000_00n },
    ]);
    // The customer coming back changes nothing.
    const back = await f.links.paidOnline(token, formOf(first.url));
    expect(back).toMatchObject({ kind: 'order', problem: null });
    expect(
      (await f.timeline(f.a, order.id)).filter((entry) => entry.includes('paid online')),
    ).toHaveLength(1);

    // A second payment the customer started in another tab, paid after the order was: all of it
    // beyond what the order owed, for the shop to give back.
    await f.admin.query(
      `INSERT INTO payments.sessions (shop_id, account_id, order_id, environment, amount, currency,
                                      gateway_ref)
       VALUES ($1, $2, $3, 'production', 200000, 'PKR', 'test_second')`,
      [f.a.shopId, accountId, order.id],
    );
    expect(
      await f.payments.webhook(
        publicId,
        f.testGateway.webhookFor(account, {
          ref: 'test_second',
          amount: 2_000_00n,
          reference: 'R2',
        }),
      ),
    ).toBe('paid');
    expect((await f.orders.get(f.a, order.id))!.amountPaid).toBe(2_000_00n);
    expect((await f.timeline(f.a, order.id))[0]).toBe(
      `Rs 2,000 paid online through Test gateway, reference R2 beyond what #${order.number} owed: give it back to the customer`,
    );
    expect((await f.payments.sessionsOf(f.a.shopId, order.id))[0]).toMatchObject({
      gatewayRef: 'test_second',
      status: 'paid',
      paidAmount: 2_000_00n,
      applied: 0n,
    });
  });

  it('takes what an order placed to be paid online waits for, from its page alone', async () => {
    await f.connectTest(f.a);
    const placed = unwrap(
      await f.orders.create(f.a, {
        lineItems: [{ variantId: kurta, quantity: 1 }],
        shippingAddress: {
          name: 'Ayesha Khan',
          phone: '0300 1234567',
          address1: 'House 12, Street 4',
          city: 'Lahore',
        },
        paymentMethod: 'online',
      }),
    );
    expect(placed).toMatchObject({
      paymentMethod: 'online',
      stage: 'awaiting_payment',
      bankAccount: null,
    });
    expect((await f.timeline(f.a, placed.id)).at(-1)).toBe(
      `Order #${placed.number} placed through the API: Rs 2,000, to pay online`,
    );
    const token = await f.linkOf(f.a, placed.id);
    const view = await f.links.viewLink(token);
    if (view.kind !== 'order') throw new Error(view.kind);
    const page = orderLinkPage(view).html;
    expect(page).toContain(
      `Your order #${placed.number} is placed. Pay Rs 2,000 online, by card or wallet: Zari ` +
        'sends your order once it is paid.',
    );
    expect(page).toContain('Pay Rs 2,000 by card or wallet, through Test gateway.');
    // No transfer, so no account to pay into and no receipt to send.
    expect(page).not.toContain('Or transfer it to the account below.');
    expect(page).not.toContain('enctype="multipart/form-data"');
    expect(page).not.toContain('Pay by bank transfer');
    expect(page).toMatch(/Pay online<\/span>[\s\S]*?Rs 2,000/);
    // The gateway refusing: the customer is told to ask the shop, as there is no transfer.
    f.testGateway.refusing = 'Test gateway: down';
    const refused = await f.links.payOnline(token);
    if ('url' in refused || refused.kind !== 'order') throw new Error('Expected the page');
    expect(orderLinkPage(refused).html).toContain(
      'Paying online isn&#39;t working right now. Try again in a while, or ask the shop in your chat.',
    );
    f.testGateway.refusing = null;
    const started = await f.links.payOnline(token);
    if (!('url' in started)) throw new Error(JSON.stringify(started));
    expect(await f.links.paidOnline(token, formOf(started.url))).toMatchObject({ problem: null });
    expect(await f.orders.get(f.a, placed.id)).toMatchObject({
      amountPaid: 2_000_00n,
      financialStatus: 'paid',
      stage: 'to_pack',
    });
  });

  it("takes a cash-on-delivery order's advance online", async () => {
    const order = await f.awaiting(f.a, kurta, { advanceDue: '500' });
    expect(order.stage).toBe('awaiting_payment');
    const token = await f.linkOf(f.a, order.id);
    await f.connectTest(f.a);
    const view = await f.links.viewLink(token);
    if (view.kind !== 'order') throw new Error(view.kind);
    expect(view.onlinePayment).toEqual({
      gateways: [{ gateway: 'test', name: 'Test gateway', origin: null }],
      amount: 500_00n,
    });
    const started = await f.links.payOnline(token);
    if (!('url' in started)) throw new Error(JSON.stringify(started));
    expect(await f.links.paidOnline(token, formOf(started.url))).toMatchObject({ problem: null });
    expect(await f.orders.get(f.a, order.id)).toMatchObject({
      amountPaid: 500_00n,
      financialStatus: 'partially_paid',
      stage: 'to_pack',
    });
    expect((await f.timeline(f.a, order.id))[0]).toMatch(
      /^Rs 500 paid online through Test gateway, reference T-\w+: the advance it asked for$/,
    );
  });

  it("pays nothing through a gateway's sandbox: a test, said on the page and the timeline", async () => {
    const order = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    await f.connectTest(f.a, 'sandbox');
    const view = await f.links.viewLink(token);
    if (view.kind !== 'order') throw new Error(view.kind);
    expect(view.onlinePayment).toEqual({
      gateways: [{ gateway: 'test', name: 'Test gateway (test)', origin: null }],
      amount: 2_000_00n,
    });
    const started = await f.links.payOnline(token);
    if (!('url' in started)) throw new Error(JSON.stringify(started));
    const back = await f.links.paidOnline(token, formOf(started.url));
    expect(back).toMatchObject({ problem: { kind: 'payment', reason: 'test' } });
    if (back.kind !== 'order') throw new Error(back.kind);
    const page = orderLinkPage(back);
    expect(page.status).toBe(200);
    expect(page.html).toContain('That was a test payment');
    expect(await f.orders.get(f.a, order.id)).toMatchObject({
      amountPaid: 0n,
      stage: 'awaiting_payment',
    });
    expect((await f.timeline(f.a, order.id))[0]).toMatch(
      /^Rs 2,000 paid online through Test gateway, reference T-\w+, in its sandbox: a test, so nothing is paid on the order$/,
    );
    expect(await f.payments.sessionsOf(f.a.shopId, order.id)).toMatchObject([
      { environment: 'sandbox', status: 'paid', applied: 0n },
    ]);
    expect(
      (await f.outbox()).find((event) => event.event_type === 'payment_session.paid'),
    ).toMatchObject({ payload: { test: true, applied: '0' } });
  });

  it('says why not: the gateway refusing, and an order that started too many', async () => {
    const order = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    const accountId = await f.connectTest(f.a);
    f.testGateway.refusing = 'Test gateway: the account is not active';
    const refused = await f.links.payOnline(token);
    expect(refused).toMatchObject({ problem: { kind: 'payment', reason: 'unavailable' } });
    if ('url' in refused || refused.kind !== 'order') throw new Error('Expected the page');
    expect(orderLinkPage(refused).status).toBe(503);
    expect(await f.payments.sessionsOf(f.a.shopId, order.id)).toMatchObject([
      { status: 'failed', error: 'Test gateway: the account is not active', gatewayRef: null },
    ]);
    expect((await f.outbox()).at(-1)).toMatchObject({
      event_type: 'payment_session.failed',
      payload: { error: 'Test gateway: the account is not active', amount: '200000' },
    });

    f.testGateway.refusing = null;
    await f.admin.query(
      `INSERT INTO payments.sessions (shop_id, account_id, order_id, environment, amount, currency,
                                      status, error)
       SELECT $1, $2, $3, 'production', 200000, 'PKR', 'failed', 'refused'
         FROM generate_series(2, $4)`,
      [f.a.shopId, accountId, order.id, SESSION_LIMITS.perOrder],
    );
    expect(
      await f.payments.start(f.a.shopId, order.id, {
        returnUrl: 'https://hatti.test/r',
        cancelUrl: 'https://hatti.test/c',
      }),
    ).toEqual({ error: 'The order started as many payments as it may' });
    // Nothing owed: nothing to start.
    unwrap(await f.orders.recordPayment(f.a, order.id));
    expect(
      await f.payments.start(f.a.shopId, order.id, {
        returnUrl: 'https://hatti.test/r',
        cancelUrl: 'https://hatti.test/c',
      }),
    ).toEqual({ error: 'The order waits for no payment' });
  });

  it('names the orders with a payment started online and not paid, which an order never paid waits for (ADR-168)', async () => {
    const order = await f.awaiting(f.a, kurta);
    const other = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    await f.connectTest(f.a);
    const started = await f.links.payOnline(token);
    if (!('url' in started)) throw new Error(JSON.stringify(started));
    const underway = (since: Date, orderIds = [order.id, other.id], owner = f.a) =>
      f.db.tenant(owner.shopId, (tx) => paymentsUnderwayIn(tx, owner.shopId, orderIds, since));
    const dayAgo = new Date(Date.now() - 86_400_000);
    expect(await underway(dayAgo)).toEqual(new Set([order.id]));
    // Started before the time asked about, another shop's, or none asked about: none.
    expect(await underway(new Date(Date.now() + 60_000))).toEqual(new Set());
    expect(await underway(dayAgo, [order.id], f.b)).toEqual(new Set());
    expect(await underway(dayAgo, [])).toEqual(new Set());
    // Paid, it is underway no more.
    expect(await f.links.paidOnline(token, formOf(started.url))).toMatchObject({ problem: null });
    expect(await underway(dayAgo)).toEqual(new Set());
  });

  it('asks the gateway after a payment whose customer never came back, and records it paid (ADR-208)', async () => {
    const order = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    await f.connectTest(f.a);
    const started = await f.links.payOnline(token);
    if (!('url' in started)) throw new Error(JSON.stringify(started));
    const ref = new URL(started.url).searchParams.get('ref')!;
    const now = Date.now();
    const at = (minutes: number) => new Date(now + minutes * 60_000);
    // Not asked after for its first quarter of an hour: the customer may still come back.
    expect(await f.payments.shopsWithInquiriesDue(at(0))).toEqual([]);
    expect(await f.payments.inquireDue(f.a.shopId, at(10))).toEqual({ asked: 0, paid: 0 });
    expect(await f.payments.shopsWithInquiriesDue(at(20))).toEqual([f.a.shopId]);

    // Not paid yet: asked, and asked again only an hour later.
    f.testGateway.inquiries.set(ref, { status: 'unpaid', message: 'Voucher not paid yet' });
    expect(await f.payments.inquireDue(f.a.shopId, at(20))).toEqual({ asked: 1, paid: 0 });
    expect(await f.payments.inquireDue(f.a.shopId, at(50))).toEqual({ asked: 0, paid: 0 });
    expect(await f.payments.shopsWithInquiriesDue(at(50))).toEqual([]);
    expect(f.testGateway.asked.filter((each) => each === ref)).toHaveLength(1);
    expect((await f.orders.get(f.a, order.id))!.amountPaid).toBe(0n);
    // Another shop's sweep asks nothing of it.
    expect(await f.payments.inquireDue(f.b.shopId, at(90))).toEqual({ asked: 0, paid: 0 });

    // Paid at the gateway: recorded paid through the inquiry, as its return would have been.
    f.testGateway.inquiries.set(ref, {
      status: 'paid',
      payment: { ref, amount: null, currency: null, reference: 'T-INQ01' },
    });
    expect(await f.payments.inquireDue(f.a.shopId, at(90))).toEqual({ asked: 1, paid: 1 });
    expect(await f.orders.get(f.a, order.id)).toMatchObject({
      amountPaid: 2_000_00n,
      financialStatus: 'paid',
    });
    const [session] = await f.payments.sessionsOf(f.a.shopId, order.id);
    expect(session).toMatchObject({ status: 'paid', paidThrough: 'inquiry', reference: 'T-INQ01' });
    expect((await f.timeline(f.a, order.id))[0]).toBe(
      'Rs 2,000 paid online through Test gateway, reference T-INQ01, paying it in full',
    );
    // Paid, it is asked after no more; nor one older than two days.
    expect(await f.payments.shopsWithInquiriesDue(at(200))).toEqual([]);
    const late = new Date(now + PAYMENT_INQUIRIES.withinMs + 60_000);
    expect(await f.payments.inquireDue(f.a.shopId, late)).toEqual({ asked: 0, paid: 0 });
  });

  /** An order of a kurta, Rs 2,000, paid online through the test gateway: it, and the payment's. */
  async function paidOnline() {
    const order = await f.awaiting(f.a, kurta);
    const token = await f.linkOf(f.a, order.id);
    const started = await f.links.payOnline(token);
    if (!('url' in started)) throw new Error(JSON.stringify(started));
    expect(await f.links.paidOnline(token, formOf(started.url))).toMatchObject({ problem: null });
    const [session] = await f.payments.sessionsOf(f.a.shopId, order.id);
    return { order, session: session! };
  }

  it('gives what was paid online back through the gateway, written on its order as a refund', async () => {
    await f.connectTest(f.a);
    const { order, session } = await paidOnline();
    // Part of it, then the rest.
    const first = unwrap(
      await f.refunds.refund(f.a, order.id, {
        amount: '500',
        method: 'online',
        note: 'One kurta came back',
      }),
    );
    const [given] = f.testGateway.refunds;
    expect(given).toMatchObject({ ref: session.gatewayRef, amount: 500_00n, currency: 'PKR' });
    expect(first.refund).toMatchObject({
      amount: 500_00n,
      method: 'online',
      reference: given!.reference,
      note: 'One kurta came back',
    });
    expect(first.order).toMatchObject({
      amountRefunded: 500_00n,
      financialStatus: 'partially_refunded',
    });
    expect((await f.timeline(f.a, order.id))[0]).toBe(
      `Refunded Rs 500 online through Test gateway, reference ${given!.reference}`,
    );
    // More than was paid and not refunded yet: refused before the gateway is asked.
    expect(
      errorsOf(await f.refunds.refund(f.a, order.id, { amount: '1,600', method: 'online' })),
    ).toEqual([['input.amount', 'INVALID']]);
    // The gateway names its own reference.
    expect(
      errorsOf(
        await f.refunds.refund(f.a, order.id, {
          amount: '1',
          method: 'online',
          reference: 'IBFT-1',
        }),
      ),
    ).toEqual([['input.reference', 'INVALID']]);
    const rest = unwrap(
      await f.refunds.refund(f.a, order.id, { amount: '1,500', method: 'online' }),
    );
    expect(rest.order).toMatchObject({ amountRefunded: 2_000_00n, financialStatus: 'refunded' });
    expect(
      errorsOf(await f.refunds.refund(f.a, order.id, { amount: '1', method: 'online' })),
    ).toEqual([['id', 'INVALID']]);
    expect(f.testGateway.refunds).toHaveLength(2);
    const [after] = await f.payments.sessionsOf(f.a.shopId, order.id);
    expect(after!.refunds).toMatchObject([
      { amount: 500_00n, status: 'refunded', refundId: first.refund.id, error: null },
      { amount: 1_500_00n, status: 'refunded', refundId: rest.refund.id },
    ]);
    expect(
      (await f.outbox())
        .map((event) => event.event_type)
        .filter((type) => type.startsWith('payment_refund') || type === 'order.refunded'),
    ).toEqual([
      'order.refunded',
      'payment_refund.refunded',
      'order.refunded',
      'payment_refund.refunded',
    ]);
    // The other shop can give none of it back.
    expect(
      errorsOf(await f.refunds.refund(f.b, order.id, { amount: '1', method: 'online' })),
    ).toEqual([['id', 'NOT_FOUND']]);
  });

  it('keeps how the customer paid, as the gateway said, and gives it back by it (ADR-255)', async () => {
    await f.connectTest(f.a);
    const paidBy = async (method: string) => {
      const order = await f.awaiting(f.a, kurta);
      const token = await f.linkOf(f.a, order.id);
      const started = await f.links.payOnline(token);
      if (!('url' in started)) throw new Error(JSON.stringify(started));
      await f.links.paidOnline(token, { ...formOf(started.url), method });
      return order;
    };
    const wallet = await paidBy('MWALLET');
    expect(await f.payments.sessionsOf(f.a.shopId, wallet.id)).toMatchObject([
      { status: 'paid', method: 'MWALLET' },
    ]);
    unwrap(await f.refunds.refund(f.a, wallet.id, { amount: '500', method: 'online' }));
    expect(f.testGateway.refunds.at(-1)).toMatchObject({ amount: 500_00n, method: 'MWALLET' });
    // Said in no shape kept, it is not kept.
    const odd = await paidBy('M WALLET!');
    expect((await f.payments.sessionsOf(f.a.shopId, odd.id))[0]!.method).toBeNull();
    unwrap(await f.refunds.refund(f.a, odd.id, { amount: '500', method: 'online' }));
    expect(f.testGateway.refunds.at(-1)!.method).toBeNull();
  });

  it("gives back only what the gateway can: nothing, a whole payment, or one payment's part", async () => {
    await f.connectTest(f.a);
    // Paid by transfer, recorded by staff: nothing online to give back.
    const transferred = await f.awaiting(f.a, kurta);
    unwrap(await f.orders.recordPayment(f.a, transferred.id));
    const nothing = await f.refunds.refund(f.a, transferred.id, {
      amount: '2,000',
      method: 'online',
    });
    expect(nothing.ok ? null : nothing.errors).toEqual([
      {
        field: ['input', 'method'],
        code: 'INVALID',
        message: 'Nothing was paid online on this order: refund it another way, then record it',
      },
    ]);

    const { order } = await paidOnline();
    const said = async (amount: string) => {
      const result = await f.refunds.refund(f.a, order.id, { amount, method: 'online' });
      return result.ok
        ? null
        : result.errors.map((error) => [error.field.join('.'), error.message]);
    };
    // A gateway that gives nothing back through Hatti.
    f.testGateway.info.refunds = 'none';
    expect(await said('2,000')).toEqual([
      [
        'input.method',
        'Test gateway gives nothing back through Hatti: refund it in its dashboard, then record it',
      ],
    ]);
    // One that gives a payment back whole, as Safepay does: the whole of it, or nothing.
    f.testGateway.info.refunds = 'whole';
    expect(await said('500')).toEqual([
      [
        'input.amount',
        'Test gateway gives a payment back whole through Hatti: Rs 2,000. Refund part of it in ' +
          'its dashboard, then record it',
      ],
    ]);
    expect(f.testGateway.refunds).toEqual([]);
    expect(await said('2,000')).toBeNull();
    expect(f.testGateway.refunds).toMatchObject([{ amount: 2_000_00n }]);
    // A refund is not more than one payment's part: an order paid twice gives back each apart.
    f.testGateway.info.refunds = 'partial';
    const other = await f.awaiting(f.a, kurta, { advanceDue: '500' });
    const token = await f.linkOf(f.a, other.id);
    for (const _ of [1, 2]) {
      const started = await f.links.payOnline(token);
      if (!('url' in started)) throw new Error(JSON.stringify(started));
      await f.links.paidOnline(token, formOf(started.url));
      // The advance is in: the rest of the cash-on-delivery order is paid online too.
      await f.admin.query(
        `UPDATE orders.orders SET stage = 'awaiting_payment', advance_due = total
                            WHERE id = $1`,
        [other.id],
      );
    }
    expect((await f.orders.get(f.a, other.id))!.amountPaid).toBe(2_000_00n);
    const twice = await f.refunds.refund(f.a, other.id, { amount: '1,600', method: 'online' });
    expect(twice.ok ? null : twice.errors[0]!.message).toBe(
      'A refund online goes back on one payment: at most Rs 1,500',
    );
    // The latest payment that can take it gives it back.
    unwrap(await f.refunds.refund(f.a, other.id, { amount: '1,500', method: 'online' }));
    unwrap(await f.refunds.refund(f.a, other.id, { amount: '500', method: 'online' }));
    expect(
      (await f.payments.sessionsOf(f.a.shopId, other.id)).map((session) => [
        session.applied,
        session.refunds.map((refund) => refund.amount),
      ]),
    ).toEqual([
      [1_500_00n, [1_500_00n]],
      [500_00n, [500_00n]],
    ]);
  });

  it('records a refusal, holds what got no answer, and settles it by hand from the dashboard', async () => {
    await f.connectTest(f.a);
    const { order } = await paidOnline();
    f.testGateway.refundAnswer = { refuse: 'Test gateway: refunds are off for this account' };
    const refused = await f.refunds.refund(f.a, order.id, { amount: '2,000', method: 'online' });
    expect(refused.ok ? null : refused.errors[0]!.message).toBe(
      'Test gateway would not give it back: Test gateway: refunds are off for this account',
    );
    expect((await f.orders.get(f.a, order.id))!.amountRefunded).toBe(0n);

    // No answer: it may have gone back, so it holds its amount until staff settle it.
    f.testGateway.refundAnswer = 'silent';
    const silent = await f.refunds.refund(f.a, order.id, { amount: '2,000', method: 'online' });
    expect(silent.ok ? null : silent.errors[0]!.message).toBe(
      'Test gateway did not answer, so it may have given it back: check its dashboard, then ' +
        'settle the refund with what it shows (Test gateway did not answer in time)',
    );
    f.testGateway.refundAnswer = null;
    const held = await f.refunds.refund(f.a, order.id, { amount: '2,000', method: 'online' });
    expect(held.ok ? null : held.errors[0]!.message).toBe(
      "What was paid online on this order is given back, or asked to be: see its payments' " +
        'refunds',
    );
    const [session] = await f.payments.sessionsOf(f.a.shopId, order.id);
    expect(session!.refunds).toMatchObject([
      { status: 'refused', error: 'Test gateway: refunds are off for this account' },
      { status: 'unknown', error: 'Test gateway did not answer in time', refundId: null },
    ]);
    const unknown = session!.refunds[1]!;
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'payment_refund.failed')
        .map((event) => event.payload.unknown),
    ).toEqual([false, true]);

    // A refused one, or one still waiting for its answer, is not settled by hand.
    expect(
      errorsOf(await f.payments.settleRefund(f.a, session!.refunds[0]!.id, { refunded: true })),
    ).toEqual([['id', 'INVALID']]);
    f.testGateway.whileRefunding = async () => {
      const { rows } = await f.admin.query<{ id: string }>(
        `SELECT id FROM payments.refunds WHERE status = 'pending'`,
      );
      expect(
        errorsOf(await f.payments.settleRefund(f.a, rows[0]!.id, { refunded: false })),
      ).toEqual([['id', 'INVALID']]);
    };
    // The dashboard shows it given back: written on the order now.
    expect(
      errorsOf(await f.payments.settleRefund(f.a, unknown.id, { refunded: false, reference: 'x' })),
    ).toEqual([['input.reference', 'INVALID']]);
    expect(errorsOf(await f.payments.settleRefund(f.b, unknown.id, { refunded: true }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    const settled = unwrap(
      await f.payments.settleRefund(f.a, unknown.id, { refunded: true, reference: 'SP-RF-88' }),
    );
    expect(settled).toMatchObject({ status: 'refunded', reference: 'SP-RF-88', error: null });
    expect(await f.orders.get(f.a, order.id)).toMatchObject({
      amountRefunded: 2_000_00n,
      financialStatus: 'refunded',
    });
    expect((await f.orders.get(f.a, order.id))!.refunds).toMatchObject([
      {
        id: settled.refundId,
        method: 'online',
        reference: 'SP-RF-88',
        note: "Given back, as the gateway's dashboard showed",
      },
    ]);
    expect(errorsOf(await f.payments.settleRefund(f.a, unknown.id, { refunded: true }))).toEqual([
      ['id', 'INVALID'],
    ]);
    const { rows: audit } = await f.admin.query<{ action: string; details: unknown }>(
      `SELECT action, details FROM platform.audit_log WHERE action = 'payment_refund.settled'`,
    );
    expect(audit).toEqual([
      {
        action: 'payment_refund.settled',
        details: { paymentRefundId: toPublicId('paymentRefund', unknown.id), refunded: true },
      },
    ]);

    // Another, which the dashboard shows was not given back: it frees what it held.
    const second = await paidOnline();
    f.testGateway.refundAnswer = 'silent';
    await f.refunds.refund(f.a, second.order.id, { amount: '2,000', method: 'online' });
    f.testGateway.refundAnswer = null;
    const [lost] = (await f.payments.sessionsOf(f.a.shopId, second.order.id))[0]!.refunds;
    expect(unwrap(await f.payments.settleRefund(f.a, lost!.id, { refunded: false }))).toMatchObject(
      { status: 'refused', error: "Not given back, as the gateway's dashboard showed" },
    );
    f.testGateway.whileRefunding = async () => {
      const { rows } = await f.admin.query<{ id: string }>(
        `SELECT id FROM payments.refunds WHERE status = 'pending'`,
      );
      expect(
        errorsOf(await f.payments.settleRefund(f.a, rows[0]!.id, { refunded: false })),
      ).toEqual([['id', 'INVALID']]);
    };
    unwrap(await f.refunds.refund(f.a, second.order.id, { amount: '2,000', method: 'online' }));
  });

  it('writes on the order no more than it has left, when a refund by hand came meanwhile', async () => {
    await f.connectTest(f.a);
    const { order } = await paidOnline();
    f.testGateway.whileRefunding = async () => {
      unwrap(await f.refunds.refund(f.a, order.id, { amount: '1,500', method: 'cash' }));
    };
    const raced = unwrap(
      await f.refunds.refund(f.a, order.id, { amount: '2,000', method: 'online' }),
    );
    expect(raced.refund.amount).toBe(500_00n);
    expect(raced.order).toMatchObject({ amountRefunded: 2_000_00n, financialStatus: 'refunded' });
    const reference = f.testGateway.refunds[0]!.reference;
    expect((await f.timeline(f.a, order.id)).slice(0, 2)).toEqual([
      `Rs 1,500 given back online through Test gateway, reference ${reference} beyond what was ` +
        'paid on the order and not refunded yet',
      `Refunded Rs 500 online through Test gateway, reference ${reference}`,
    ]);
  });
});
