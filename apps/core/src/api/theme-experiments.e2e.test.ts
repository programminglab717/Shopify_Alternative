import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
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

const START = `mutation ($input: ThemeExperimentInput!) {
  themeExperimentStart(input: $input) {
    themeExperiment {
      themeId share
      drafts { themeId verdict revenueVerdict arm { sessions converted } }
    }
    userErrors { field message }
  }
}`;

describe.skipIf(!server)('Admin GraphQL API: theme experiments of several drafts (ADR-931)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  let token = '';

  async function data(query: string, variables?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      // Every request its own key: themeCreate must not run twice.
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
      payload: { query, variables },
    });
    const body = response.json() as { data?: Record<string, Json>; errors?: Json[] };
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    const issued = generateAccessToken();
    token = issued.token;
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shop, issued.hash, issued.hint, ['write_themes']],
    );
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('starts one of three drafts, each its share, and says of each how it sells', async () => {
    const theme = async (name: string) =>
      (
        await data(`mutation ($name: String!) { themeCreate(name: $name) { theme { id } } }`, {
          name,
        })
      ).theme.id as string;
    const [b, c, d] = [await theme('Eid offer'), await theme('Bigger photos'), await theme('Urdu')];
    const input = { name: 'Three ways', themeId: b, otherThemeIds: [c, d], days: 14 };
    expect((await data(START, { input: { ...input, share: 30 } })).userErrors).toEqual([
      {
        field: ['input', 'share'],
        message: 'Share must be a whole percent from 1 to 25 with 3 drafts',
      },
    ]);
    const started = await data(START, { input: { ...input, share: 25 } });
    expect(started.userErrors).toEqual([]);
    expect(started.themeExperiment.drafts.map((each: Json) => each.themeId)).toEqual([b, c, d]);
    expect(started.themeExperiment.drafts[2]).toEqual({
      themeId: d,
      verdict: 'too_early',
      revenueVerdict: 'too_early',
      arm: { sessions: 0, converted: 0 },
    });

    // As the worker would keep the counts: the second draft sells better, among three.
    const arm = (sessions: number, converted: number) => ({
      sessions,
      added_to_cart: converted,
      reached_checkout: converted,
      converted,
      revenue: converted * 500_000,
      revenue_squares: converted * 500_000 ** 2,
    });
    await admin.query(`UPDATE online_store.theme_experiments SET results = $1 WHERE shop_id = $2`, [
      JSON.stringify({
        a: arm(1_000, 20),
        b: arm(1_000, 20),
        c: arm(1_000, 45),
        d: arm(1_000, 21),
      }),
      shop,
    ]);
    const [running] = await data('{ themeExperiments { verdict drafts { themeId verdict } } }');
    expect(running).toEqual({
      verdict: 'no_difference',
      drafts: [
        { themeId: b, verdict: 'no_difference' },
        { themeId: c, verdict: 'b_better' },
        { themeId: d, verdict: 'no_difference' },
      ],
    });
    // Deleting any of its drafts ends it.
    await data(`mutation ($id: ID!) { themeDelete(id: $id) { userErrors { message } } }`, {
      id: d,
    });
    const { rows } = await admin.query<{ ended_reason: string }>(
      'SELECT ended_reason FROM online_store.theme_experiments WHERE shop_id = $1',
      [shop],
    );
    expect(rows).toEqual([{ ended_reason: 'theme_changed' }]);
  });

  it('gives each draft its own share, the live theme shown to no fewer than any (ADR-952)', async () => {
    const theme = async (name: string) =>
      (
        await data(`mutation ($name: String!) { themeCreate(name: $name) { theme { id } } }`, {
          name,
        })
      ).theme.id as string;
    const [b, c] = [await theme('Big sale banner'), await theme('Quiet banner')];
    const SHARED = `mutation ($input: ThemeExperimentInput!) {
      themeExperimentStart(input: $input) {
        themeExperiment { share drafts { themeId share } }
        userErrors { field message }
      }
    }`;
    const input = { name: 'Banners', themeId: b, otherThemeIds: [c], days: 7 };
    // The live theme's 40% fewer than the first draft's 45%; a share for no draft.
    expect(
      (await data(SHARED, { input: { ...input, share: 45, otherShares: [15] } })).userErrors,
    ).toEqual([
      {
        field: ['input', 'otherShares'],
        message:
          'The live theme is shown to no fewer shoppers than any draft: give the drafts less',
      },
    ]);
    expect(
      (await data(SHARED, { input: { ...input, share: 10, otherShares: [10, 10] } })).userErrors,
    ).toEqual([{ field: ['input', 'otherShares'], message: 'Give a share for each draft more' }]);
    // 40% and 10%: more than a third for one draft, as one share for all could not be.
    const started = await data(SHARED, { input: { ...input, share: 40, otherShares: [10] } });
    expect(started).toEqual({
      themeExperiment: {
        share: 40,
        drafts: [
          { themeId: b, share: 40 },
          { themeId: c, share: 10 },
        ],
      },
      userErrors: [],
    });
  });
});
