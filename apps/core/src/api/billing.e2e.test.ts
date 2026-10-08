import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { PublicSite, generateAccessToken, type StaffRole } from '@hatti/api';
import { BillingService } from '@hatti/billing/public';
import { base32Decode, totp } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();
const PASSWORD = 'correct horse battery staple';

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SUBSCRIPTION = `{ billingSubscription {
  plan { code name } interval periodStart periodEnd pastDue nextPlan { code }
  openInvoice { id name status amount { amount } }
} }`;

describe.skipIf(!server)('Admin GraphQL API: what shops pay Hatti', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  const shop = newId();
  /** The shop's owner, signed in: there is one. */
  let owner: string;

  const post = (url: string, payload: unknown, token?: string) =>
    api.app.inject({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  /** A member of the shop's staff in `role`, signed in, with a second factor where it needs one. */
  async function member(role: StaffRole): Promise<string> {
    const email = `billing-${randomBytes(4).toString('hex')}@example.pk`;
    const signedUp = await post('/auth/sign-up', { email, password: PASSWORD, name: 'Sana Iqbal' });
    expect(signedUp.statusCode).toBe(201);
    const body = signedUp.json() as { accessToken: string; user: { id: string } };
    await admin.query(
      'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
      [fromPublicId(body.user.id, 'user'), shop, role],
    );
    if (role === 'owner' || role === 'manager') {
      const setup = await post('/auth/two-step/totp/setup', {}, body.accessToken);
      const { secret } = setup.json() as { secret: string };
      const code = totp(base32Decode(secret), Date.now());
      expect(
        (await post('/auth/two-step/totp/confirm', { code }, body.accessToken)).statusCode,
      ).toBe(200);
    }
    return body.accessToken;
  }

  async function gql(token: string, query: string, variables?: Record<string, unknown>) {
    const response = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: token.startsWith('hat_')
        ? { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() }
        : {
            authorization: `Bearer ${token}`,
            'x-hatti-shop-id': toPublicId('shop', shop),
            'idempotency-key': randomUUID(),
          },
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
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    api = await startTestApi(testDb);
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("puts the shop on Free, whose owner chooses Growth and pays it through Hatti's gateway", async () => {
    owner = await member('owner');
    expect(
      await data(
        owner,
        '{ billingPlans { code name monthlyPrice { amount } yearlyPrice { amount } staffLimit locationLimit orderLimit customDomains onlineGateways } }',
      ),
    ).toEqual([
      {
        code: 'FREE',
        name: 'Free',
        monthlyPrice: { amount: '0.00' },
        yearlyPrice: { amount: '0.00' },
        staffLimit: 1,
        locationLimit: 1,
        orderLimit: 50,
        customDomains: false,
        onlineGateways: false,
      },
      {
        code: 'STARTER',
        name: 'Starter',
        monthlyPrice: { amount: '2499.00' },
        yearlyPrice: { amount: '24990.00' },
        staffLimit: 3,
        locationLimit: 1,
        orderLimit: null,
        customDomains: true,
        onlineGateways: true,
      },
      {
        code: 'GROWTH',
        name: 'Growth',
        monthlyPrice: { amount: '6999.00' },
        yearlyPrice: { amount: '69990.00' },
        staffLimit: 8,
        locationLimit: 3,
        orderLimit: null,
        customDomains: true,
        onlineGateways: true,
      },
      {
        code: 'PRO',
        name: 'Pro',
        monthlyPrice: { amount: '17999.00' },
        yearlyPrice: { amount: '179990.00' },
        staffLimit: 20,
        locationLimit: 10,
        orderLimit: null,
        customDomains: true,
        onlineGateways: true,
      },
    ]);
    expect(await data(owner, SUBSCRIPTION)).toEqual({
      plan: { code: 'FREE', name: 'Free' },
      interval: null,
      periodStart: null,
      periodEnd: null,
      pastDue: false,
      nextPlan: null,
      openInvoice: null,
    });

    // Free has room for its owner alone, and one location.
    const invited = await data(
      owner,
      'mutation { staffInvitationCreate(role: PACKER) { invitation { id } userErrors { field code message } } }',
    );
    expect(invited.userErrors).toEqual([
      {
        field: ['role'],
        code: 'TOO_MANY',
        message: 'The Free plan has room for 1 member of staff: choose a bigger plan for more',
      },
    ]);
    const { token: appToken, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, '{read_settings,write_settings,write_inventory,write_locations}')`,
      [shop, hash, hint],
    );
    const ADD = `mutation ($name: String!) { locationAdd(input: { name: $name, address: { city: "Lahore" } }) {
      location { id } userErrors { field code message } } }`;
    expect((await data(appToken, ADD, { name: 'Main' })).userErrors).toEqual([]);
    expect((await data(appToken, ADD, { name: 'Warehouse' })).userErrors).toEqual([
      {
        field: ['input'],
        code: 'TOO_MANY',
        message: 'The Free plan has room for 1 location: choose a bigger plan for more',
      },
    ]);

    // Nor a domain of its own, nor payment gateways (ADR-264).
    const DOMAIN =
      'mutation { domainCreate(domain: { host: "www.zari.pk" }) { domain { host } userErrors { field code message } } }';
    expect((await data(owner, DOMAIN)).userErrors).toEqual([
      {
        field: ['domain', 'host'],
        code: 'INVALID',
        message:
          "The Free plan doesn't include a domain of the shop's own: choose a bigger plan to connect one",
      },
    ]);
    const CONNECT = `mutation ($input: PaymentGatewayAccountInput!) { paymentGatewayAccountConnect(input: $input) {
      paymentGatewayAccount { gateway } userErrors { field code message } } }`;
    const gateway = { gateway: 'test', credentials: [{ key: 'secret', value: 'secret-of-zari' }] };
    expect((await data(owner, CONNECT, { input: gateway })).userErrors).toEqual([
      {
        field: ['input', 'gateway'],
        code: 'INVALID',
        message:
          "The Free plan doesn't include payment gateways: choose a bigger plan to connect one",
      },
    ]);

    // The owner alone chooses the plan: not a manager, nor an app.
    const CHANGE = `mutation ($input: BillingPlanChangeInput!) { billingPlanChange(input: $input) {
      subscription { plan { code } } invoice { id name reason status amount { amount } }
      userErrors { field code message } } }`;
    const manager = await member('manager');
    expect(
      (await gql(manager, CHANGE, { input: { plan: 'GROWTH', interval: 'MONTHLY' } })).errors?.[0]
        .extensions.code,
    ).toBe('ACCESS_DENIED');
    expect(
      (await gql(appToken, CHANGE, { input: { plan: 'GROWTH', interval: 'MONTHLY' } })).errors?.[0]
        .extensions.code,
    ).toBe('ACCESS_DENIED');
    expect((await data(manager, SUBSCRIPTION)).plan.code).toBe('FREE');
    const chosen = await data(owner, CHANGE, { input: { plan: 'GROWTH', interval: 'MONTHLY' } });
    expect(chosen).toEqual({
      subscription: { plan: { code: 'FREE' } },
      invoice: {
        id: expect.stringMatching(/^binv_/),
        name: expect.stringMatching(/^HB-\d{6}$/),
        reason: 'CHANGE',
        status: 'OPEN',
        amount: { amount: '6999.00' },
      },
      userErrors: [],
    });

    // Paid through Hatti's gateway, here the test gateway, back to the invoice's page.
    const PAY =
      'mutation ($id: ID!) { billingInvoicePay(id: $id) { checkoutUrl userErrors { code } } }';
    const pay = await data(owner, PAY, { id: chosen.invoice.id });
    const checkout = new URL(pay.checkoutUrl);
    const page = `/billing/invoices/${chosen.invoice.id}`;
    expect(checkout.pathname).toBe(`${page}/paid`);
    const back = await api.app.inject({
      method: 'GET',
      url: `${checkout.pathname}${checkout.search}`,
    });
    expect([back.statusCode, back.headers.location]).toEqual([303, page]);
    const shown = await api.app.inject({ method: 'GET', url: page });
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['cache-control']).toBe('no-store');
    expect(shown.body).toContain(
      `Thank you: invoice ${chosen.invoice.name} is paid. Zari is on Growth until`,
    );
    expect(await data(owner, SUBSCRIPTION)).toMatchObject({
      plan: { code: 'GROWTH' },
      interval: 'MONTHLY',
      pastDue: false,
      openInvoice: null,
    });
    expect(await data(owner, '{ billingInvoices { name status reference paidAt } }')).toEqual([
      {
        name: chosen.invoice.name,
        status: 'PAID',
        reference: expect.stringMatching(/^T-/),
        paidAt: expect.any(String),
      },
    ]);
    // Growth has room for staff, and three locations.
    expect(
      (
        await data(
          owner,
          'mutation { staffInvitationCreate(role: PACKER) { invitation { id } userErrors { code } } }',
        )
      ).userErrors,
    ).toEqual([]);
    expect((await data(appToken, ADD, { name: 'Warehouse' })).userErrors).toEqual([]);
    // And a domain of its own, and payment gateways.
    expect(await data(owner, DOMAIN)).toEqual({ domain: { host: 'www.zari.pk' }, userErrors: [] });
    expect(await data(owner, CONNECT, { input: gateway })).toEqual({
      paymentGatewayAccount: { gateway: 'test' },
      userErrors: [],
    });
    // A forged return records nothing: the page says it waits.
    const other = await data(owner, CHANGE, { input: { plan: 'PRO', interval: 'MONTHLY' } });
    const forged = await api.app.inject({
      method: 'POST',
      url: `/billing/invoices/${other.invoice.id}/paid`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'ref=test_x&sig=00',
    });
    expect(forged.statusCode).toBe(303);
    expect(
      (await api.app.inject({ method: 'GET', url: `/billing/invoices/${other.invoice.id}` })).body,
    ).toContain('It waits for its payment');
    expect(
      (await api.app.inject({ method: 'GET', url: '/billing/invoices/binv_nothing' })).statusCode,
    ).toBe(404);
    // Its webhook answers only what Hatti's secret signs.
    const unsigned = await api.app.inject({
      method: 'POST',
      url: '/webhooks/billing',
      headers: { 'content-type': 'application/json', 'x-test-signature': '00' },
      payload: { ref: 'test_x', paid: true },
    });
    expect(unsigned.statusCode).toBe(401);
  });

  it('sells the shop credit for its messages, at the prices it lists, and lists what changed it', async () => {
    const WALLET = `{ billingWallet { balance { amount }
      openInvoice { id reason plan { code } interval amount { amount } } } }`;
    const BUY = `mutation ($input: BillingCreditsBuyInput!) { billingCreditsBuy(input: $input) {
      invoice { id name reason plan { code } interval status amount { amount } }
      userErrors { field code message } } }`;
    const manager = await member('manager');
    // Owners and managers see the credit, and what messages cost; the owner alone buys it.
    expect(await data(manager, WALLET)).toEqual({ balance: { amount: '0.00' }, openInvoice: null });
    expect(
      await data(manager, '{ billingMessagePrices { channel category price { amount } } }'),
    ).toEqual([
      { channel: 'WHATSAPP', category: 'UTILITY', price: { amount: '4.62' } },
      { channel: 'WHATSAPP', category: 'AUTHENTICATION', price: { amount: '4.62' } },
      { channel: 'WHATSAPP', category: 'MARKETING', price: { amount: '14.58' } },
      { channel: 'SMS', category: 'UTILITY', price: { amount: '1.73' } },
      { channel: 'SMS', category: 'AUTHENTICATION', price: { amount: '1.73' } },
      { channel: 'SMS', category: 'MARKETING', price: { amount: '1.73' } },
    ]);
    expect(
      (await gql(manager, BUY, { input: { amount: '1000' } })).errors?.[0].extensions.code,
    ).toBe('ACCESS_DENIED');
    expect((await data(owner, BUY, { input: { amount: '250' } })).userErrors).toEqual([
      {
        field: ['input', 'amount'],
        code: 'INVALID',
        message: 'Credit is bought from Rs 500 to Rs 100,000 at a time',
      },
    ]);
    const bought = await data(owner, BUY, { input: { amount: '1000' } });
    expect(bought).toEqual({
      invoice: {
        id: expect.stringMatching(/^binv_/),
        name: expect.stringMatching(/^HB-\d{6}$/),
        reason: 'CREDITS',
        plan: null,
        interval: null,
        status: 'OPEN',
        amount: { amount: '1000.00' },
      },
      userErrors: [],
    });
    // The plan's invoice waiting from before stays: credit has its own.
    const { openInvoice } = await data(owner, SUBSCRIPTION);
    expect([openInvoice.status, openInvoice.id === bought.invoice.id]).toEqual(['OPEN', false]);
    expect((await data(manager, WALLET)).openInvoice).toEqual({
      id: bought.invoice.id,
      reason: 'CREDITS',
      plan: null,
      interval: null,
      amount: { amount: '1000.00' },
    });

    // Paid as a plan is, through Hatti's gateway: the shop's once paid.
    const pay = await data(
      owner,
      'mutation ($id: ID!) { billingInvoicePay(id: $id) { checkoutUrl userErrors { code } } }',
      { id: bought.invoice.id },
    );
    const checkout = new URL(pay.checkoutUrl);
    const back = await api.app.inject({
      method: 'GET',
      url: `${checkout.pathname}${checkout.search}`,
    });
    expect(back.statusCode).toBe(303);
    expect(
      (await api.app.inject({ method: 'GET', url: `/billing/invoices/${bought.invoice.id}` })).body,
    ).toContain(
      `Thank you: invoice ${bought.invoice.name} is paid. Rs 1,000 of message credit is added ` +
        'to Zari&#39;s.',
    );
    expect(await data(manager, WALLET)).toEqual({
      balance: { amount: '1000.00' },
      openInvoice: null,
    });
    expect(
      await data(
        manager,
        `{ billingWalletEntries { id kind amount { amount } balance { amount } invoiceId messageId
             channel category parts note } }`,
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^bwe_/),
        kind: 'TOP_UP',
        amount: { amount: '1000.00' },
        balance: { amount: '1000.00' },
        invoiceId: bought.invoice.id,
        messageId: null,
        channel: null,
        category: null,
        parts: null,
        note: null,
      },
    ]);
    expect(
      (await data(owner, '{ billingInvoices(first: 1) { reason plan { code } interval } }'))[0],
    ).toEqual({ reason: 'CREDITS', plan: null, interval: null });
    // An app with read_settings sees it too.
    const { token: app, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'reader', $2, $3, '{read_settings}')`,
      [shop, hash, hint],
    );
    expect((await data(app, WALLET)).balance).toEqual({ amount: '1000.00' });
  });

  it("takes an invoice paid by transfer into Hatti's account, as its owner says, once Hatti finds it (ADR-254)", async () => {
    const manager = await member('manager');
    // Owners and managers see Hatti's account, to pay into; its invoices' pages show it too.
    expect(await data(manager, '{ billingBankAccount { title bankName iban raastId } }')).toEqual({
      title: 'Hatti Technologies (Private) Limited',
      bankName: 'Standard Chartered',
      iban: 'PK36SCBL0000001123456702',
      raastId: '+923001234567',
    });
    const { openInvoice } = await data(owner, SUBSCRIPTION);
    expect(Number(openInvoice.amount.amount)).toBeLessThan(17_999);
    expect(
      (await api.app.inject({ method: 'GET', url: `/billing/invoices/${openInvoice.id}` })).body,
    ).toContain('PK36 SCBL 0000 0011 2345 6702');

    const REPORT = `mutation ($id: ID!, $reference: String!) {
      billingInvoiceTransferReport(id: $id, reference: $reference) {
        transfer { id reference status amount { amount } received { amount } refusal reportedAt
                   checkedAt }
        userErrors { field code message } } }`;
    // The owner alone says it was paid: not a manager.
    expect(
      (await gql(manager, REPORT, { id: openInvoice.id, reference: 'FT24100012' })).errors?.[0]
        .extensions.code,
    ).toBe('ACCESS_DENIED');
    expect((await data(owner, REPORT, { id: openInvoice.id, reference: 'FT' })).userErrors).toEqual(
      [
        {
          field: ['reference'],
          code: 'INVALID',
          message: 'Give the reference your bank or Raast gave the transfer: 4 characters at least',
        },
      ],
    );
    const said = await data(owner, REPORT, { id: openInvoice.id, reference: 'FT24100012' });
    expect(said).toEqual({
      transfer: {
        id: expect.stringMatching(/^btr_/),
        reference: 'FT24100012',
        status: 'WAITING',
        // Pro's price, less what was left of the Growth period paid for.
        amount: openInvoice.amount,
        received: null,
        refusal: null,
        reportedAt: expect.any(String),
        checkedAt: null,
      },
      userErrors: [],
    });

    // Hatti's people find it, with the system login, and confirm it: the invoice is paid, and
    // its plan begins.
    const database = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'billing-transfers-test',
    });
    try {
      const billing = new BillingService(database, new PublicSite('http://localhost:4000'));
      expect((await billing.waitingTransfers()).map((transfer) => transfer.reference)).toEqual([
        'FT24100012',
      ]);
      expect(
        await billing.confirmTransfer(fromPublicId(said.transfer.id, 'billingTransfer'), {
          by: 'Ayesha',
        }),
      ).toMatchObject({ outcome: 'paid' });
    } finally {
      await database.close();
    }
    expect((await data(manager, SUBSCRIPTION)).plan.code).toBe('PRO');
    const invoices = await data(
      manager,
      `{ billingInvoices { id status reference
           transfers { id status received { amount } checkedAt } } }`,
    );
    expect(invoices.find((invoice: Json) => invoice.id === openInvoice.id)).toEqual({
      id: openInvoice.id,
      status: 'PAID',
      reference: 'FT24100012',
      transfers: [
        {
          id: said.transfer.id,
          status: 'CONFIRMED',
          received: openInvoice.amount,
          checkedAt: expect.any(String),
        },
      ],
    });
    // Each of the others had none said for it.
    expect(
      invoices
        .filter((invoice: Json) => invoice.id !== openInvoice.id)
        .map((invoice: Json) => invoice.transfers),
    ).toEqual(invoices.slice(1).map(() => []));
  });
});
