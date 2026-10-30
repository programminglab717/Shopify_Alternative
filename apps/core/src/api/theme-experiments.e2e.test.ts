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

  it("changes each draft's share of a running experiment, as at its start (ADR-958)", async () => {
    // The one the test before left running: 40% and 10%.
    const running = (
      (await data(`{ themeExperiments { id endedAt } }`)) as { id: string; endedAt: null }[]
    ).find((each) => each.endedAt === null)!;
    const SET = `mutation ($id: ID!, $shares: [Int!]!) {
      themeExperimentSharesSet(id: $id, shares: $shares) {
        themeExperiment { share drafts { share } }
        userErrors { field message }
      }
    }`;
    expect((await data(SET, { id: running.id, shares: [30] })).userErrors).toEqual([
      { field: ['shares'], message: 'Give a share for each draft' },
    ]);
    expect((await data(SET, { id: running.id, shares: [45, 15] })).userErrors).toEqual([
      {
        field: ['shares'],
        message:
          'The live theme is shown to no fewer shoppers than any draft: give the drafts less',
      },
    ]);
    expect(await data(SET, { id: running.id, shares: [20, 30] })).toEqual({
      themeExperiment: { share: 20, drafts: [{ share: 20 }, { share: 30 }] },
      userErrors: [],
    });
    // A draft Hatti stopped keeps its share.
    await admin.query(
      `UPDATE online_store.theme_experiments SET stopped_arms = '{c}' WHERE ended_at IS NULL`,
    );
    expect((await data(SET, { id: running.id, shares: [20, 10] })).userErrors).toEqual([
      {
        field: ['shares', '1'],
        message: 'Hatti stopped this draft: its shoppers see your live theme, and its share stays',
      },
    ]);
    expect((await data(SET, { id: running.id, shares: [25, 30] })).userErrors).toEqual([]);
    // Recorded, and none once it has ended.
    const { rows } = await admin.query<{ details: { from: number[]; to: number[] } }>(
      `SELECT details FROM platform.audit_log WHERE action = 'theme_experiment.shares_changed'
        ORDER BY occurred_at`,
    );
    expect(rows.map((row) => [row.details.from, row.details.to])).toEqual([
      [
        [40, 10],
        [20, 30],
      ],
      [
        [20, 30],
        [25, 30],
      ],
    ]);
    await data(`mutation ($id: ID!) { themeExperimentEnd(id: $id) { userErrors { field } } }`, {
      id: running.id,
    });
    expect((await data(SET, { id: running.id, shares: [10, 10] })).userErrors).toEqual([
      { field: ['id'], message: 'No experiment of the shop has this ID' },
    ]);
  });

  it('adds a draft to a running experiment, and takes one out, the others going on (ADR-970)', async () => {
    const theme = async (name: string) =>
      (
        await data(`mutation ($name: String!) { themeCreate(name: $name) { theme { id } } }`, {
          name,
        })
      ).theme.id as string;
    const [b, c, d, e] = [
      await theme('Ramadan'),
      await theme('Big buttons'),
      await theme('Dark'),
      await theme('Fourth'),
    ];
    const started = await data(START, {
      input: { name: 'Ramadan', themeId: b, share: 20, days: 14 },
    });
    const id = (await data(`{ themeExperiments { id endedAt } }`)).find(
      (each: Json) => each.endedAt === null,
    ).id as string;
    expect(started.userErrors).toEqual([]);
    const ADD = `mutation ($id: ID!, $themeId: ID!, $share: Int!) {
      themeExperimentDraftAdd(id: $id, themeId: $themeId, share: $share) {
        themeExperiment { endedAt drafts { themeId share stopped takenOut arm { sessions } } }
        userErrors { field message }
      }
    }`;
    const OUT = `mutation ($id: ID!, $themeId: ID!) {
      themeExperimentDraftTakeOut(id: $id, themeId: $themeId) {
        themeExperiment { endedAt endedReason drafts { themeId stopped takenOut } }
        userErrors { field message }
      }
    }`;
    expect((await data(ADD, { id, themeId: b, share: 10 })).userErrors).toEqual([
      { field: ['themeId'], message: 'The experiment shows this draft already' },
    ]);
    expect((await data(ADD, { id, themeId: c, share: 45 })).userErrors).toEqual([
      {
        field: ['share'],
        message:
          'The live theme is shown to no fewer shoppers than any draft: give the drafts less',
      },
    ]);
    // As the next arm, its counts beginning at none.
    expect(await data(ADD, { id, themeId: c, share: 30 })).toEqual({
      themeExperiment: {
        endedAt: null,
        drafts: [
          { themeId: b, share: 20, stopped: false, takenOut: false, arm: { sessions: 0 } },
          { themeId: c, share: 30, stopped: false, takenOut: false, arm: { sessions: 0 } },
        ],
      },
      userErrors: [],
    });
    expect((await data(ADD, { id, themeId: d, share: 10 })).userErrors).toEqual([]);
    expect((await data(ADD, { id, themeId: e, share: 5 })).userErrors).toEqual([
      { field: ['themeId'], message: 'An experiment shows 3 drafts at most' },
    ]);
    // Taken out: its shoppers see the live theme, the others going on.
    const out = await data(OUT, { id, themeId: c });
    expect(out.themeExperiment.drafts).toEqual([
      { themeId: b, stopped: false, takenOut: false },
      { themeId: c, stopped: false, takenOut: true },
      { themeId: d, stopped: false, takenOut: false },
    ]);
    const { rows: arms } = await admin.query<{ stopped_arms: string[]; taken_out_arms: string[] }>(
      `SELECT stopped_arms, taken_out_arms FROM online_store.theme_experiments
        WHERE ended_at IS NULL`,
    );
    expect(arms).toEqual([{ stopped_arms: ['c'], taken_out_arms: ['c'] }]);
    expect((await data(OUT, { id, themeId: c })).userErrors).toEqual([
      { field: ['themeId'], message: 'This draft is shown to no shoppers already' },
    ]);
    expect((await data(OUT, { id, themeId: e })).userErrors).toEqual([
      { field: ['themeId'], message: 'The experiment shows no such draft' },
    ]);
    // Let back in (ADR-977), its counts going on; one Hatti stopped stays stopped.
    const BACK = `mutation ($id: ID!, $themeId: ID!) {
      themeExperimentDraftLetBackIn(id: $id, themeId: $themeId) {
        themeExperiment { drafts { themeId stopped takenOut } }
        userErrors { field message }
      }
    }`;
    expect((await data(BACK, { id, themeId: b })).userErrors).toEqual([
      { field: ['themeId'], message: 'This draft is shown to shoppers already' },
    ]);
    expect((await data(BACK, { id, themeId: c })).themeExperiment.drafts[1]).toEqual({
      themeId: c,
      stopped: false,
      takenOut: false,
    });
    await admin.query(
      `UPDATE online_store.theme_experiments SET stopped_arms = '{c}' WHERE ended_at IS NULL`,
    );
    expect((await data(BACK, { id, themeId: c })).userErrors).toEqual([
      {
        field: ['themeId'],
        message: 'Hatti stopped this draft as it sold clearly worse: it stays stopped',
      },
    ]);
    // The last of them taken out, it ends.
    expect((await data(OUT, { id, themeId: b })).themeExperiment.endedAt).toBeNull();
    const last = await data(OUT, { id, themeId: d });
    expect(last.themeExperiment.endedReason).toBe('staff');
    const { rows } = await admin.query<{ action: string }>(
      `SELECT action FROM platform.audit_log WHERE action LIKE 'theme_experiment.draft_%'
        ORDER BY occurred_at, action`,
    );
    expect(rows.map((row) => row.action)).toEqual([
      'theme_experiment.draft_added',
      'theme_experiment.draft_added',
      'theme_experiment.draft_taken_out',
      'theme_experiment.draft_let_back_in',
      'theme_experiment.draft_taken_out',
      'theme_experiment.draft_taken_out',
    ]);
  });
});
