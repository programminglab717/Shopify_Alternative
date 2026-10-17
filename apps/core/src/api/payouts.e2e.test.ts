import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { monthOf } from './payouts.resolver.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const REPORT = `query ($from: DateTime!, $before: DateTime!) {
  payoutsReport(from: $from, before: $before) {
    totals { statements gross { amount } fees { amount } tax { amount } net { amount } }
    sources { kind name statements net { amount } tax { amount } }
    months { month statements net { amount } }
    withholdings { id kind name reference tax { amount } }
    truncated
  }
}`;

describe("Payouts' months (ANL-09, TAX-03, ADR-493)", () => {
  it("puts a statement in its month in the shop's time zone", () => {
    expect(monthOf(new Date('2026-09-30T20:00:00Z'), 'Asia/Karachi')).toBe('2026-10');
    expect(monthOf(new Date('2026-09-30T18:00:00Z'), 'Asia/Karachi')).toBe('2026-09');
  });
});

describe.skipIf(!server)('Admin GraphQL API: payouts and tax withheld (ANL-09, TAX-03)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const account = newId();
  const tokens = { read: '', products: '' };

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
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
      payload: { query, variables },
    });
    return response.json<{ data?: Json; errors?: Json[] }>();
  }

  async function settlement(at: string, reference: string, amounts: number[]) {
    const [gross, fees, tax, net] = amounts;
    await admin.query(
      `INSERT INTO payments.settlements (shop_id, account_id, reference, line_count, gross, fees,
                                         tax, net, actor_kind, created_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'app', $8)`,
      [shop, account, reference, gross, fees, tax, net, at],
    );
  }

  async function remittance(
    at: string,
    courier: string,
    reference: string | null,
    amounts: number[],
  ) {
    const [collected, charges, tax, paid] = amounts;
    const id = newId();
    await admin.query(
      `INSERT INTO logistics.cod_remittances (shop_id, id, courier, reference, line_count,
                                              collected, charges, tax, paid, received,
                                              actor_kind, created_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $8, 'app', $9)`,
      [shop, id, courier, reference, collected, charges, tax, paid, at],
    );
    return id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    await admin.query(
      `INSERT INTO payments.gateway_accounts (shop_id, id, gateway, environment, credentials,
                                              credentials_hint)
       VALUES ($1, $2, 'safepay', 'production', 'sealed', 'abcd')`,
      [shop, account],
    );
    tokens.read = await issueToken(['read_orders']);
    tokens.products = await issueToken(['read_products']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("adds up gateways' and couriers' statements by source and month, with the tax they withheld", async () => {
    await settlement('2026-09-10T08:00:00Z', 'SP-0910', [400000, 10000, 4000, 386000]);
    await settlement('2026-10-02T08:00:00Z', 'SP-1002', [200000, 5000, 0, 195000]);
    const postex = await remittance(
      '2026-09-30T20:00:00Z',
      'PostEx',
      'PX-1',
      [600000, 30000, 6000, 564000],
    );
    await remittance('2026-10-05T08:00:00Z', 'postex', null, [100000, 5000, 0, 95000]);
    // Outside the period.
    await settlement('2026-08-31T08:00:00Z', 'SP-0831', [100000, 2500, 1000, 96500]);

    const period = { from: '2026-09-01T00:00:00Z', before: '2026-11-01T00:00:00Z' };
    const denied = await gql(tokens.products, REPORT, period);
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    const wrong = await gql(tokens.read, REPORT, { from: period.before, before: period.from });
    expect(wrong.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');

    const body = await gql(tokens.read, REPORT, period);
    expect(body.errors).toBeUndefined();
    const report = body.data.payoutsReport;
    expect(report.totals).toEqual({
      statements: 4,
      gross: { amount: '13000.00' },
      fees: { amount: '500.00' },
      tax: { amount: '100.00' },
      net: { amount: '12400.00' },
    });
    expect(report.sources).toEqual([
      {
        kind: 'COURIER',
        name: 'PostEx',
        statements: 2,
        net: { amount: '6590.00' },
        tax: { amount: '60.00' },
      },
      {
        kind: 'GATEWAY',
        name: 'Safepay',
        statements: 2,
        net: { amount: '5810.00' },
        tax: { amount: '40.00' },
      },
    ]);
    // PostEx's first statement came in after midnight in Karachi, in October.
    expect(report.months).toEqual([
      { month: '2026-09', statements: 1, net: { amount: '3860.00' } },
      { month: '2026-10', statements: 3, net: { amount: '8540.00' } },
    ]);
    expect(report.withholdings).toEqual([
      expect.objectContaining({
        kind: 'GATEWAY',
        name: 'Safepay',
        reference: 'SP-0910',
        tax: { amount: '40.00' },
      }),
      {
        id: toPublicId('codRemittance', postex),
        kind: 'COURIER',
        name: 'PostEx',
        reference: 'PX-1',
        tax: { amount: '60.00' },
      },
    ]);
    expect(report.truncated).toBe(false);
  });
});
