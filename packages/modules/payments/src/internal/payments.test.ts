import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { toPublicId } from '@hatti/ids';
import { orderLinkPage } from '@hatti/orders/public';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_LIMITS } from './online-payment.service.js';
import { errorsOf, paymentsFixture, unwrap, type PaymentsFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Payments online', () => {
  let f: PaymentsFixture;
  let kurta: string;

  beforeAll(async () => {
    f = await paymentsFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
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
          gateway: 'jazzcash',
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
      gateway: { name: 'Test gateway', origin: null },
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
      gateway: { name: 'Test gateway', origin: null },
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
      gateway: { name: 'Test gateway (test)', origin: null },
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
});
