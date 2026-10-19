import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import { LeakyBuckets } from '@hatti/ratelimit';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import type { QueryCost } from './query-cost.js';

const server = testDatabaseServer();
const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface Answer {
  status: number;
  data?: Record<string, Json> | null;
  errors?: { message: string; extensions?: Record<string, Json> }[];
  extensions?: { cost?: QueryCost };
}

/** A query of `n` objects, each costing 1 and returned, so that all `n` are spent. */
const shops = (n: number) =>
  `{ ${Array.from({ length: n }, (_, i) => `s${i}: shop { name }`).join(' ')} }`;

/** Tiny buckets, so that a few queries drain them. */
const LIMITS = {
  app: { maximum: 30, restoreRate: 10 },
  staff: { maximum: 60, restoreRate: 20 },
};

describe.skipIf(!server || !redisUrl)('Admin GraphQL API: query cost (ADR-576)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let redis: Redis;
  let api: TestApi;
  const prefix = `test-cost-${randomBytes(4).toString('hex')}`;
  const [shopA, shopB] = [newId(), newId()];
  const tokens = { a: '', aOther: '', b: '' };
  let staff = '';
  /** The buckets' clock: tests move it on rather than wait. */
  let clock = 1_800_000_000_000;

  async function issueToken(shopId: string): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, ['write_products']],
    );
    return token;
  }

  /** A marketer in both shops: a role that needs no second factor. */
  async function marketer(): Promise<string> {
    const signedUp = await api.app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      payload: {
        email: `cost-${randomBytes(4).toString('hex')}@example.pk`,
        password: 'correct horse battery staple',
        name: 'Sana Iqbal',
      },
    });
    expect(signedUp.statusCode).toBe(201);
    const body = signedUp.json<{ accessToken: string; user: { id: string } }>();
    await admin.query(
      `INSERT INTO identity.memberships (user_id, shop_id, role)
       VALUES ($1, $2, 'marketer'), ($1, $3, 'marketer')`,
      [fromPublicId(body.user.id, 'user'), shopA, shopB],
    );
    return body.accessToken;
  }

  async function gql(
    caller: { app: string } | { staff: string; shop: string },
    query: string,
    options: { variables?: Record<string, unknown>; key?: string; on?: TestApi } = {},
  ): Promise<Answer> {
    const response = await (options.on ?? api).app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: {
        ...('app' in caller
          ? { 'x-hatti-access-token': caller.app }
          : {
              authorization: `Bearer ${caller.staff}`,
              'x-hatti-shop-id': toPublicId('shop', caller.shop),
            }),
        ...(options.key && { 'idempotency-key': options.key }),
      },
      payload: { query, variables: options.variables },
    });
    return { status: response.statusCode, ...response.json<Omit<Answer, 'status'>>() };
  }

  const products = async () =>
    (
      await admin.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM catalog.products WHERE shop_id = $1',
        [shopA],
      )
    ).rows[0]!.count;

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari'), ($2, 'Lawn', 'lawn')`,
      [shopA, shopB],
    );
    tokens.a = await issueToken(shopA);
    tokens.aOther = await issueToken(shopA);
    tokens.b = await issueToken(shopB);
    redis = new Redis(redisUrl ?? '', { lazyConnect: true });
    api = await startTestApi(testDb, {
      queryCost: { buckets: new LeakyBuckets(redis, prefix), limits: LIMITS, now: () => clock },
    });
    staff = await marketer();
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
    if (redis) {
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
      redis.disconnect();
    }
  });

  beforeEach(() => {
    // Long enough for every bucket to fill again.
    clock += 60_000;
  });

  it('tells what a query cost and what is left, giving back what it did not use', async () => {
    const created = await gql(
      { app: tokens.a },
      'mutation { productCreate(input: { title: "Lawn suit" }) { product { id } userErrors { message } } }',
    );
    expect(created.data?.productCreate.userErrors).toEqual([]);
    // A mutation costs 10, and 1 for each object its payload selects.
    expect(created.extensions?.cost).toEqual({
      requestedQueryCost: 12,
      actualQueryCost: 12,
      throttleStatus: { maximumAvailable: 30, currentlyAvailable: 18, restoreRate: 10 },
    });

    // Asked for a page of 20, the one product there is costs 1: the other 19 come back.
    clock += 60_000;
    const listed = await gql({ app: tokens.a }, '{ products(first: 20) { nodes { id title } } }');
    expect(listed.data?.products.nodes).toHaveLength(1);
    expect(listed.extensions?.cost).toEqual({
      requestedQueryCost: 22,
      actualQueryCost: 3,
      throttleStatus: { maximumAvailable: 30, currentlyAvailable: 27, restoreRate: 10 },
    });

    // Staff see their own bucket.
    expect((await gql({ staff, shop: shopA }, '{ shop { name } }')).extensions?.cost).toEqual({
      requestedQueryCost: 1,
      actualQueryCost: 1,
      throttleStatus: { maximumAvailable: 60, currentlyAvailable: 59, restoreRate: 20 },
    });
  });

  it('throttles a query costlier than what is left, taking nothing, until the bucket restores', async () => {
    expect((await gql({ app: tokens.a }, shops(25))).extensions?.cost?.throttleStatus).toEqual({
      maximumAvailable: 30,
      currentlyAvailable: 5,
      restoreRate: 10,
    });

    const throttled = await gql({ app: tokens.a }, shops(20));
    expect(throttled.status).toBe(200);
    expect(throttled.data ?? null).toBeNull();
    expect(throttled.errors).toEqual([
      {
        message:
          'Throttled: this query may cost 20 points and 5 are left, restoring 10 a second. Try ' +
          'again in 2 seconds',
        extensions: { code: 'THROTTLED' },
      },
    ]);
    expect(throttled.extensions?.cost).toEqual({
      requestedQueryCost: 20,
      actualQueryCost: null,
      throttleStatus: { maximumAvailable: 30, currentlyAvailable: 5, restoreRate: 10 },
    });
    // Nothing was taken: what is left still runs a query that fits.
    expect((await gql({ app: tokens.a }, shops(5))).errors).toBeUndefined();

    // Two seconds later, 20 are back.
    clock += 2_000;
    const restored = await gql({ app: tokens.a }, shops(20));
    expect(restored.errors).toBeUndefined();
    expect(restored.extensions?.cost?.throttleStatus.currentlyAvailable).toBe(0);
  });

  it('refuses a query costlier than any may be, before it runs and taking nothing', async () => {
    const refused = await gql({ app: tokens.a }, '{ products(first: 50) { nodes { id } } }');
    expect(refused.status).toBe(200);
    expect(refused.errors).toEqual([
      {
        message:
          'This query costs 52 points, more than the 30 any one query may. Ask for smaller ' +
          'pages, or fewer of them at once',
        extensions: { code: 'MAX_COST_EXCEEDED', cost: 52, maxCost: 30 },
      },
    ]);
    expect(refused.extensions?.cost).toEqual({
      requestedQueryCost: 52,
      actualQueryCost: null,
      throttleStatus: { maximumAvailable: 30, currentlyAvailable: 30, restoreRate: 10 },
    });
  });

  it('keeps a bucket for each app and each member of staff in each shop', async () => {
    await gql({ app: tokens.a }, shops(30));
    expect((await gql({ app: tokens.a }, shops(1))).errors?.[0]?.extensions?.code).toBe(
      'THROTTLED',
    );
    // Another app in the same shop, the same app's like in another shop, and staff: untouched.
    for (const caller of [{ app: tokens.aOther }, { app: tokens.b }, { staff, shop: shopA }]) {
      const answer = await gql(caller, shops(30));
      expect(answer.errors).toBeUndefined();
      expect(answer.extensions?.cost?.requestedQueryCost).toBe(30);
    }

    await gql({ staff, shop: shopA }, shops(30));
    expect((await gql({ staff, shop: shopA }, shops(1))).errors?.[0]?.extensions?.code).toBe(
      'THROTTLED',
    );
    // The same member of staff, in their other shop.
    expect(
      (await gql({ staff, shop: shopB }, shops(30))).extensions?.cost?.throttleStatus
        .currentlyAvailable,
    ).toBe(30);
  });

  it('lets a mutation throttled with an Idempotency-Key run when retried with it', async () => {
    const before = await products();
    await gql({ app: tokens.a }, shops(25));
    const key = randomUUID();
    const mutation =
      'mutation { productCreate(input: { title: "Kurta" }) { product { id } userErrors { message } } }';
    const throttled = await gql({ app: tokens.a }, mutation, { key });
    expect(throttled.errors?.[0]?.extensions?.code).toBe('THROTTLED');
    expect(await products()).toBe(before);

    clock += 60_000;
    const retried = await gql({ app: tokens.a }, mutation, { key });
    expect(retried.errors).toBeUndefined();
    expect(retried.data?.productCreate.product.id).toMatch(/^prod_/);
    expect(await products()).toBe(before + 1);
    // And once it ran, the key keeps its answer, as always.
    const replayed = await gql({ app: tokens.a }, mutation, { key });
    expect(replayed.data).toEqual(retried.data);
    expect(await products()).toBe(before + 1);
  });

  describe('without Redis, and with big buckets', () => {
    let unmetered: TestApi;
    let down: Redis;

    beforeAll(async () => {
      // Nothing listens on port 1: every call fails at once.
      down = new Redis('redis://localhost:1', {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
      });
      down.on('error', () => {});
      unmetered = await startTestApi(testDb, {
        queryCost: {
          buckets: new LeakyBuckets(down),
          limits: {
            app: { maximum: 5_000, restoreRate: 50 },
            staff: { maximum: 5_000, restoreRate: 100 },
          },
        },
      });
    });

    afterAll(async () => {
      await unmetered?.close();
      down?.disconnect();
    });

    it('lets queries through, as if each bucket were full', async () => {
      for (let i = 0; i < 3; i++) {
        const answer = await gql({ app: tokens.a }, shops(1), { on: unmetered });
        expect(answer.errors).toBeUndefined();
        expect(answer.extensions?.cost?.throttleStatus).toEqual({
          maximumAvailable: 5_000,
          currentlyAvailable: 4_999,
          restoreRate: 50,
        });
      }
    });

    it("caps apps' queries at 1,000 however big their bucket, and staff's at theirs", async () => {
      const pages = `{ ${['a', 'b', 'c', 'd'].map((alias) => `${alias}: products(first: 250) { nodes { id } }`).join(' ')} }`;
      const refused = await gql({ app: tokens.a }, pages, { on: unmetered });
      expect(refused.errors?.[0]?.extensions).toEqual({
        code: 'MAX_COST_EXCEEDED',
        cost: 1_008,
        maxCost: 1_000,
      });
      const answered = await gql({ staff, shop: shopA }, pages, { on: unmetered });
      expect(answered.errors).toBeUndefined();
      expect(answered.extensions?.cost?.requestedQueryCost).toBe(1_008);
    });
  });
});
