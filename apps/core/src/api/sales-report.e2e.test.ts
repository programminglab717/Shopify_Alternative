import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { base32Decode, totp } from '@hatti/crypto';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import { xlsxRows } from '@hatti/xlsx/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

/** A CSV's rows, its cells unquoted: those the journal writes. */
const parseCsv = (text: string): string[][] =>
  text
    .replace(/^\uFEFF/, '')
    .split('\r\n')
    .filter((line) => line !== '')
    .map((line) =>
      [...line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)].map((cell) =>
        cell[1]!.replace(/^"|"$/g, '').replace(/""/g, '"'),
      ),
    );

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SALES = `
  fragment sales on Sales {
    orders
    grossSales { amount }
    discounts { amount }
    returns { amount }
    netSales { amount }
    shipping { amount }
    totalSales { amount currencyCode }
    taxes { amount }
    averageOrderValue { amount }
    costOfGoods { amount }
    unitsWithoutCost
    grossProfit { amount }
    grossMargin
    shippingCosts { amount }
    writeOffs { amount }
    claimsRecovered { amount }
    profit { amount }
    refunds { amount }
  }
  query ($from: DateTime!, $before: DateTime!, $interval: SalesInterval) {
    salesReport(placedFrom: $from, placedBefore: $before, interval: $interval) {
      totals { ...sales }
      previous { placedFrom placedBefore totals { orders totalSales { amount } } }
      periods { start sales { orders } }
      topProducts { productId title unitsSold orders grossSales { amount } costOfGoods { amount } }
      trueProfit
    }
  }`;

describe.skipIf(!server)('Admin GraphQL API: sales analytics', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const tokens = { owner: '', products: '', marketing: '' };
  // From one reading of the clock, so the period is two hours to the millisecond.
  const now = Date.now();
  const period = {
    from: new Date(now - 3_600_000).toISOString(),
    before: new Date(now + 3_600_000).toISOString(),
  };

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
    tokens.owner = await issueToken(['write_products', 'write_orders']);
    tokens.marketing = await issueToken(['write_marketing_events', 'read_orders']);
    tokens.products = await issueToken(['write_products']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("says what a period's orders came to, and the products that sold most", async () => {
    const created = await gql(
      tokens.owner,
      `mutation {
        productCreate(input: {
          title: "Kurta", status: ACTIVE, variants: [{ price: "2,499", cost: "1,500" }]
        }) {
          product { id variants { id } }
        }
      }`,
    );
    const product = created.data?.productCreate.product;
    for (const [quantity, extra] of [
      [2, 'discount: "498", shippingPrice: "250"'],
      [1, ''],
    ] as const) {
      const placed = await gql(
        tokens.owner,
        `mutation ($variantId: ID!) {
          orderCreate(input: {
            lineItems: [{ variantId: $variantId, quantity: ${quantity} }], ${extra}
            shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                               address1: "House 12, Street 4", city: "Lahore" }
          }) { userErrors { code message } }
        }`,
        { variantId: product.variants[0].id },
      );
      expect(placed.data?.orderCreate.userErrors).toEqual([]);
    }

    // On Free, the report leaves its true profit lines out (ADR-529); gross profit stays.
    const free = (await gql(tokens.owner, SALES, period)).data?.salesReport;
    expect(free.trueProfit).toBe(false);
    expect(free.totals).toMatchObject({
      grossProfit: { amount: '2499.00' },
      shippingCosts: null,
      writeOffs: null,
      claimsRecovered: null,
      profit: null,
    });
    await admin.query(
      `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
       VALUES ($1, 'growth', 'monthly', now(), now() + interval '1 month')`,
      [shop],
    );

    const report = (await gql(tokens.owner, SALES, period)).data?.salesReport;
    expect(report.trueProfit).toBe(true);
    expect(report.totals).toEqual({
      orders: 2,
      grossSales: { amount: '7497.00' },
      discounts: { amount: '498.00' },
      returns: { amount: '0.00' },
      netSales: { amount: '6999.00' },
      shipping: { amount: '250.00' },
      totalSales: { amount: '7249.00', currencyCode: 'PKR' },
      // The shop charges no sales tax.
      taxes: { amount: '0.00' },
      averageOrderValue: { amount: '3499.50' },
      // Three kurtas at what each cost when sold (ADR-141); no parcel yet, so no courier's charges.
      costOfGoods: { amount: '4500.00' },
      unitsWithoutCost: 0,
      grossProfit: { amount: '2499.00' },
      grossMargin: 0.3571,
      shippingCosts: { amount: '0.00' },
      writeOffs: { amount: '0.00' },
      claimsRecovered: { amount: '0.00' },
      profit: { amount: '2749.00' },
      refunds: { amount: '0.00' },
    });
    // The two hours before, to compare with (ADR-250): no orders then.
    expect(report.previous).toEqual({
      placedFrom: new Date(Date.parse(period.from) - 7_200_000).toISOString(),
      placedBefore: period.from,
      totals: { orders: 0, totalSales: { amount: '0.00' } },
    });
    expect((report.periods as Json[]).reduce((sum, each) => sum + each.sales.orders, 0)).toBe(2);
    expect(report.topProducts).toEqual([
      {
        productId: product.id,
        title: 'Kurta',
        unitsSold: 3,
        orders: 2,
        grossSales: { amount: '7497.00' },
        costOfGoods: { amount: '4500.00' },
      },
    ]);

    const empty = await gql(tokens.owner, SALES, {
      from: '2026-01-01T00:00:00+05:00',
      before: '2026-02-01T00:00:00+05:00',
      interval: 'WEEK',
    });
    expect(empty.data?.salesReport.totals.averageOrderValue).toBeNull();
    expect(empty.data?.salesReport.periods[0].start).toBe('2025-12-28T19:00:00.000Z');

    const tooLong = await gql(tokens.owner, SALES, { ...period, from: '2025-01-01T00:00:00Z' });
    expect(tooLong.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

    const denied = await gql(tokens.products, SALES, period);
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });

  it("exports the report as a workbook for the shop's accountant (ANL-10, ADR-798)", async () => {
    const EXPORT = `mutation ($from: DateTime!, $before: DateTime!) {
      salesReportExport(placedFrom: $from, placedBefore: $before) {
        file { filename contentType content }
        userErrors { field code message }
      }
    }`;
    const exported = (await gql(tokens.owner, EXPORT, period)).data?.salesReportExport;
    expect(exported.userErrors).toEqual([]);
    expect(exported.file.filename).toMatch(/^sales-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const rows = xlsxRows(Buffer.from(exported.file.content, 'base64'));
    const totals = (await gql(tokens.owner, SALES, period)).data?.salesReport.totals;
    expect(rows[0]![0]).toBe('Day');
    // The plan has true profit by now: its lines end each row.
    expect(rows[0]!.at(-1)).toBe('Profit');
    expect(rows.at(-1)!.slice(0, 2)).toEqual(['Total', totals.orders]);

    const tooLong = (await gql(tokens.owner, EXPORT, { ...period, from: '2025-01-01T00:00:00Z' }))
      .data?.salesReportExport;
    expect(tooLong).toMatchObject({ file: null, userErrors: [{ field: ['placedBefore'] }] });
    const denied = await gql(tokens.products, EXPORT, period);
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });

  it("exports the sales as a journal for the shop's books, by its own accounts (ANL-10, ADR-885)", async () => {
    const EXPORT = `mutation ($from: DateTime!, $before: DateTime!, $format: JournalFormat) {
      accountingJournalExport(placedFrom: $from, placedBefore: $before, format: $format) {
        file { filename contentType content }
        userErrors { field code message }
      }
    }`;
    const journalOf = async (token: string, format = 'CSV') => {
      const exported = (await gql(token, EXPORT, { ...period, format })).data
        ?.accountingJournalExport;
      expect(exported.userErrors).toEqual([]);
      return {
        ...exported.file,
        text: Buffer.from(exported.file.content, 'base64').toString('utf8'),
      };
    };
    const csv = await journalOf(tokens.owner);
    expect(csv.filename).toMatch(/^journal-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
    const [heading, ...lines] = parseCsv(csv.text);
    expect(heading).toEqual([
      'Date',
      'Entry',
      'Account code',
      'Account',
      'Description',
      'Debit',
      'Credit',
    ]);
    // The day's orders, as the report has them: what they came to, owed; their items, sold.
    const totals = (await gql(tokens.owner, SALES, period)).data?.salesReport.totals;
    const posted = (account: string, column: 5 | 6) =>
      lines
        .filter((line) => line[3] === account)
        .reduce((sum, line) => sum + Number(line[column] || 0), 0);
    expect(posted('Sales', 6)).toBe(Number(totals.grossSales.amount));
    expect(posted('Cost of goods sold', 5)).toBe(Number(totals.costOfGoods.amount));
    const sum = (column: 5 | 6) =>
      lines.reduce((total, line) => total + Number(line[column] || 0), 0);
    expect(sum(5)).toBeCloseTo(sum(6), 2);
    const tally = await journalOf(tokens.owner, 'TALLY');
    expect(tally.filename).toMatch(/-tally\.xml$/);
    expect(tally.text).toContain('<VOUCHER VCHTYPE="Journal" ACTION="Create">');

    const LEDGERS = '{ journalLedgers { account code name named } }';
    const ledgers = (await gql(tokens.owner, LEDGERS)).data?.journalLedgers;
    expect(ledgers).toHaveLength(14);
    expect(ledgers[1]).toEqual({ account: 'SALES', code: '4000', name: 'Sales', named: false });
    const SET = `mutation ($accounts: [JournalLedgerInput!]!) {
      journalLedgersSet(accounts: $accounts) {
        journalLedgers { account code name named }
        userErrors { field code message }
      }
    }`;
    const online = { account: 'SALES', code: '41000', name: 'Online sales' };
    // Apps read the accounts, but only the shop's staff name them.
    const byApp = await gql(tokens.owner, SET, { accounts: [online] });
    expect(byApp.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');

    const staff = async (role: 'accountant' | 'marketer') => {
      const email = `staff-${randomBytes(4).toString('hex')}@example.pk`;
      const signedUp = await app.inject({
        method: 'POST',
        url: '/auth/sign-up',
        payload: { email, password: 'correct horse battery staple', name: 'Sana Iqbal' },
      });
      const body = signedUp.json() as { accessToken: string; user: { id: string } };
      await admin.query(
        'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
        [fromPublicId(body.user.id, 'user'), shop, role],
      );
      // Accountants need two-step verification, as the staff's tests show.
      const auth = (url: string, payload: Record<string, unknown>) =>
        app.inject({
          method: 'POST',
          url,
          payload,
          headers: { authorization: `Bearer ${body.accessToken}` },
        });
      const { secret } = (await auth('/auth/two-step/totp/setup', {})).json() as {
        secret: string;
      };
      await auth('/auth/two-step/totp/confirm', { code: totp(base32Decode(secret), Date.now()) });
      return async (query: string, variables?: Record<string, unknown>) =>
        (
          await app.inject({
            method: 'POST',
            url: ADMIN_GRAPHQL_PATH,
            headers: {
              authorization: `Bearer ${body.accessToken}`,
              'idempotency-key': newId(),
              'x-hatti-shop-id': toPublicId('shop', shop),
            },
            payload: { query, variables },
          })
        ).json() as { data?: Record<string, Json> | null; errors?: Json[] };
    };
    const marketer = await staff('marketer');
    expect((await marketer(SET, { accounts: [online] })).errors?.[0]?.message).toBe(
      "Access denied. Only owners, managers and accountants name the journal's accounts.",
    );
    const accountant = await staff('accountant');
    const set = (await accountant(SET, { accounts: [online] })).data?.journalLedgersSet;
    expect(set.userErrors).toEqual([]);
    expect(set.journalLedgers[1]).toEqual({ ...online, named: true });
    // Two accounts by one name would be one in the shop's books.
    const twice = (
      await accountant(SET, {
        accounts: [{ account: 'RETURNS', code: '4020', name: 'online SALES' }],
      })
    ).data?.journalLedgersSet;
    expect(twice).toMatchObject({
      journalLedgers: null,
      userErrors: [{ field: ['accounts', '0', 'name'], code: 'TAKEN' }],
    });
    const named = parseCsv((await journalOf(tokens.owner)).text);
    expect(named.some((line) => line[2] === '41000' && line[3] === 'Online sales')).toBe(true);
    // Blank, it is Hatti's usual again.
    const reset = (await accountant(SET, { accounts: [{ account: 'SALES', code: '', name: ' ' }] }))
      .data?.journalLedgersSet;
    expect(reset.journalLedgers[1]).toEqual({
      account: 'SALES',
      code: '4000',
      name: 'Sales',
      named: false,
    });
    const exported = await admin.query(
      `SELECT count(*)::int AS n FROM platform.audit_log WHERE shop_id = $1 AND action = 'journal.exported'`,
      [shop],
    );
    expect(exported.rows[0].n).toBe(3);

    const denied = await gql(tokens.products, EXPORT, period);
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });

  it('takes the ad spend the shop records off what its orders made (ADR-553)', async () => {
    const marketer = await issueToken(['write_pixels', 'read_orders']);
    // Yesterday in Karachi, a day of its own with no orders: the shop is on Growth by now.
    const day = new Date(now - 86_400_000).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Karachi',
    });
    const next = new Date(Date.parse(`${day}T00:00:00+05:00`) + 86_400_000).toISOString();
    const set = await gql(
      marketer,
      `mutation ($entries: [AdSpendInput!]!) {
        adSpendSet(entries: $entries) { count userErrors { field code } }
      }`,
      {
        entries: [
          { platform: 'META', day, campaign: 'Eid-Sale', amount: '1,200' },
          { platform: 'GOOGLE', day, amount: '300.50' },
        ],
      },
    );
    expect(set.data?.adSpendSet).toEqual({ count: 2, userErrors: [] });
    const refused = await gql(
      marketer,
      `mutation { adSpendSet(entries: [{ platform: TIKTOK, day: "2026-02-30", amount: "5" }]) {
        count userErrors { field code }
      } }`,
    );
    expect(refused.data?.adSpendSet).toEqual({
      count: null,
      userErrors: [{ field: ['entries', '0', 'day'], code: 'INVALID' }],
    });
    const listed = await gql(
      marketer,
      `query ($from: String!, $to: String!) {
        adSpendEntries(from: $from, to: $to) { platform day campaign amount { amount } }
      }`,
      { from: day, to: day },
    );
    expect(listed.data?.adSpendEntries).toEqual([
      { platform: 'GOOGLE', day, campaign: null, amount: { amount: '300.50' } },
      { platform: 'META', day, campaign: 'Eid-Sale', amount: { amount: '1200.00' } },
    ]);

    const report = await gql(
      marketer,
      `query ($from: DateTime!, $before: DateTime!) {
        salesReport(placedFrom: $from, placedBefore: $before, by: CAMPAIGN) {
          totals { orders adSpend { amount } returnOnAdSpend profit { amount } }
          rows { key sales { orders adSpend { amount } } }
        }
      }`,
      { from: `${day}T00:00:00+05:00`, before: next },
    );
    expect(report.data?.salesReport).toEqual({
      totals: {
        orders: 0,
        adSpend: { amount: '1500.50' },
        returnOnAdSpend: 0,
        profit: { amount: '-1500.50' },
      },
      rows: [{ key: 'Eid-Sale', sales: { orders: 0, adSpend: { amount: '1200.00' } } }],
    });
    // Recording it takes the scope of the ad platforms.
    const denied = await gql(
      tokens.owner,
      `mutation { adSpendSet(entries: [{ platform: META, day: "${day}", amount: "1" }]) { count } }`,
    );
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });

  it('says where the orders came from, in sales and in COD health (ADR-140)', async () => {
    // The kurta alone came through the online store, from an Instagram ad's campaign.
    const visit = {
      at: new Date().toISOString(),
      source: 'instagram',
      utm: { source: 'ig', medium: 'paid_social', campaign: 'Eid', term: null, content: null },
    };
    await admin.query(
      `UPDATE orders.orders SET source = 'online_store', attribution = $2
        WHERE shop_id = $1 AND subtotal = 249900`,
      [shop, JSON.stringify({ first: visit, last: visit })],
    );
    const rows = async (by: string) =>
      (
        await gql(
          tokens.owner,
          `query ($from: DateTime!, $before: DateTime!, $by: SalesDimension) {
            salesReport(placedFrom: $from, placedBefore: $before, by: $by) {
              rows { key title sales { orders totalSales { amount } } }
            }
          }`,
          { ...period, by },
        )
      ).data?.salesReport.rows;
    expect(await rows('VISIT_SOURCE')).toEqual([
      {
        key: null,
        title: 'No visit known',
        sales: { orders: 1, totalSales: { amount: '4750.00' } },
      },
      {
        key: 'instagram',
        title: 'Instagram',
        sales: { orders: 1, totalSales: { amount: '2499.00' } },
      },
    ]);
    expect(await rows('SOURCE')).toEqual([
      { key: 'API', title: 'Apps', sales: { orders: 1, totalSales: { amount: '4750.00' } } },
      {
        key: 'ONLINE_STORE',
        title: 'Online store',
        sales: { orders: 1, totalSales: { amount: '2499.00' } },
      },
    ]);
    const health = await gql(
      tokens.owner,
      `query ($from: DateTime!, $before: DateTime!) {
        codHealth(placedFrom: $from, placedBefore: $before, by: CAMPAIGN) {
          rows { key title confirmation { placed } }
        }
      }`,
      period,
    );
    expect(health.data?.codHealth.rows).toEqual([
      { key: 'Eid', title: 'Eid', confirmation: { placed: 1 } },
      { key: null, title: 'No campaign', confirmation: { placed: 1 } },
    ]);
  });

  it('puts customers in cohorts by the month of their first order (ANL-04, ADR-774)', async () => {
    const COHORTS = `query ($months: Int) {
      customerCohorts(months: $months) { month customers returned orderedAgain }
    }`;
    const body = await gql(tokens.owner, COHORTS, { months: 2 });
    const cohorts = body.data?.customerCohorts;
    // This month, in Karachi, the last: its customers placed the orders above, one of them more
    // than one.
    const thisMonth = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 7);
    expect(cohorts.map((cohort: Json) => cohort.month).at(-1)).toBe(thisMonth);
    expect(cohorts).toHaveLength(2);
    expect(cohorts[1]).toMatchObject({ returned: [] });
    expect(cohorts[1].customers).toBeGreaterThan(0);
    expect(cohorts[1].orderedAgain).toBeGreaterThan(0);
    expect(cohorts[0].returned).toHaveLength(1);

    const tooMany = await gql(tokens.owner, COHORTS, { months: 25 });
    expect(tooMany.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    const denied = await gql(tokens.products, COHORTS, {});
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });

  it('keeps affiliates, what they earn and what the shop paid them (MKT-08, ADR-776)', async () => {
    const created = await gql(
      tokens.marketing,
      `mutation ($input: AffiliateCreateInput!) {
        affiliateCreate(input: $input) {
          affiliate { id name phone ref discountCode commission active stats { orders } }
          userErrors { field code }
        }
      }`,
      {
        input: {
          name: 'Ayesha',
          phone: '0300 1234567',
          ref: 'Ayesha',
          discountCode: 'ayesha10',
          commission: '7.50',
        },
      },
    );
    const affiliate = created.data?.affiliateCreate.affiliate;
    expect(affiliate).toMatchObject({
      name: 'Ayesha',
      phone: '+923001234567',
      ref: 'ayesha',
      discountCode: 'AYESHA10',
      commission: '7.5',
      active: true,
      stats: { orders: 0 },
    });
    expect(affiliate.id).toMatch(/^afl_/);

    const paid = await gql(
      tokens.marketing,
      `mutation ($input: AffiliatePayoutRecordInput!) {
        affiliatePayoutRecord(input: $input) {
          payout { id amount { amount } note }
          userErrors { field code }
        }
      }`,
      { input: { affiliateId: affiliate.id, amount: '1000', note: 'Advance' } },
    );
    expect(paid.data?.affiliatePayoutRecord).toMatchObject({
      payout: { amount: { amount: '1000.00' }, note: 'Advance' },
      userErrors: [],
    });
    const ended = await gql(
      tokens.marketing,
      `mutation ($input: AffiliateUpdateInput!) {
        affiliateUpdate(input: $input) { affiliate { active endedAt } userErrors { code } }
      }`,
      { input: { id: affiliate.id, active: false } },
    );
    expect(ended.data?.affiliateUpdate.affiliate.active).toBe(false);

    const listed = await gql(
      tokens.marketing,
      `query ($id: ID!) {
        affiliates { ref stats { earned { amount } paid { amount } owed { amount } } }
        affiliateOrders(id: $id) { orderId }
        affiliatePayouts(id: $id) { note }
      }`,
      { id: affiliate.id },
    );
    expect(listed.data).toEqual({
      affiliates: [
        {
          ref: 'ayesha',
          stats: {
            earned: { amount: '0.00' },
            paid: { amount: '1000.00' },
            owed: { amount: '-1000.00' },
          },
        },
      ],
      affiliateOrders: [],
      affiliatePayouts: [{ note: 'Advance' }],
    });
    const denied = await gql(tokens.products, '{ affiliates { id } }', {});
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
  });
});
