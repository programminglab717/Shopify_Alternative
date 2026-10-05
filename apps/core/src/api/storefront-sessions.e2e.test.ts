import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { StorefrontActivity, StorefrontKeys } from '@hatti/storefront-data';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();
const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface GraphQLResponse {
  data?: Record<string, Json> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

const FUNNEL = 'sessions addedToCart reachedCheckout converted conversionRate';

describe.skipIf(!server || !redisUrl)('Admin GraphQL API: storefront sessions (ADR-180)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  const redis = new Redis(redisUrl ?? '', { lazyConnect: true });
  const keys = new StorefrontKeys();
  const [shopA, shopB] = [newId(), newId()];
  const tokens = { a: '', b: '', products: '' };

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
    );
    return token;
  }

  async function gql(token: string, query: string): Promise<GraphQLResponse> {
    const response = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() },
      payload: { query },
    });
    return response.json() as GraphQLResponse;
  }

  async function call(token: string, query: string): Promise<Json> {
    const body = await gql(token, query);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0];
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA, ['read_orders']);
    tokens.b = await issueToken(shopB, ['read_orders']);
    tokens.products = await issueToken(shopA, ['read_products']);
    api = await startTestApi(testDb, { redis });
  });

  afterAll(async () => {
    for (const shopId of [shopA, shopB]) {
      const found = await redis.keys(`s:{${shopId}}:an:*`);
      if (found.length > 0) await redis.del(...found);
      const changed = await redis.smembers(keys.activityChanged());
      const ours = changed.filter((member) => member.startsWith(`${shopId} `));
      if (ours.length > 0) await redis.srem(keys.activityChanged(), ...ours);
    }
    redis.disconnect();
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("gives a period's sessions day by day, and how many placed an order", async () => {
    await admin.query(
      `INSERT INTO online_store.session_days
         (shop_id, day, sessions, added_to_cart, reached_checkout, converted)
       VALUES ($1, '2026-10-04', 40, 10, 4, 2), ($1, '2026-10-05', 12, 3, 2, 1),
              ($2, '2026-10-05', 99, 9, 9, 9)`,
      [shopA, shopB],
    );
    // 4 and 5 October in Karachi.
    const report = await call(
      tokens.a,
      `{ storefrontSessions(from: "2026-10-03T19:00:00Z", before: "2026-10-05T19:00:00Z") {
          totals { ${FUNNEL} } periods { start sessions { sessions conversionRate } }
      } }`,
    );
    expect(report).toEqual({
      totals: {
        sessions: 52,
        addedToCart: 13,
        reachedCheckout: 6,
        converted: 3,
        conversionRate: 0.0577,
      },
      periods: [
        {
          start: '2026-10-03T19:00:00.000Z',
          sessions: { sessions: 40, conversionRate: 0.05 },
        },
        {
          start: '2026-10-04T19:00:00.000Z',
          sessions: { sessions: 12, conversionRate: 0.0833 },
        },
      ],
    });
    const months = await call(
      tokens.a,
      `{ storefrontSessions(from: "2026-08-31T19:00:00Z", before: "2026-10-31T19:00:00Z",
                            interval: MONTH) { periods { sessions { sessions conversionRate } } } }`,
    );
    expect(months.periods).toEqual([
      { sessions: { sessions: 0, conversionRate: null } },
      { sessions: { sessions: 52, conversionRate: 0.0577 } },
    ]);
    const backwards = await gql(
      tokens.a,
      `{ storefrontSessions(from: "2026-10-05T00:00:00Z", before: "2026-10-04T00:00:00Z") {
          totals { sessions } } }`,
    );
    expect(backwards.errors?.[0]).toMatchObject({
      message: 'Before must be later than from',
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it("says who is on the storefront now, and today's sessions so far", async () => {
    const activity = new StorefrontActivity(redis, keys);
    const now = new Date();
    await activity.visited(shopA, 'Asia/Karachi', 'session-one-0123456789', now);
    await activity.visited(shopA, 'Asia/Karachi', 'session-two-0123456789', now);
    await activity.reached(shopA, 'Asia/Karachi', 'session-two-0123456789', 'converted', now);
    const live = `{ storefrontLiveView { visitorsNow today { ${FUNNEL} } } }`;
    expect(await call(tokens.a, live)).toEqual({
      visitorsNow: 2,
      today: {
        sessions: 2,
        addedToCart: 0,
        reachedCheckout: 0,
        converted: 1,
        conversionRate: 0.5,
      },
    });
    // Another shop's are its own.
    expect(await call(tokens.b, live)).toEqual({
      visitorsNow: 0,
      today: {
        sessions: 0,
        addedToCart: 0,
        reachedCheckout: 0,
        converted: 0,
        conversionRate: null,
      },
    });
  });

  it('needs read_orders, as the sales report does', async () => {
    for (const query of [
      '{ storefrontLiveView { visitorsNow } }',
      '{ storefrontSessions(from: "2026-10-01T00:00:00Z", before: "2026-10-02T00:00:00Z") { totals { sessions } } }',
    ]) {
      const body = await gql(tokens.products, query);
      expect(body.errors?.[0]?.extensions?.code, query).toBe('ACCESS_DENIED');
    }
  });
});
