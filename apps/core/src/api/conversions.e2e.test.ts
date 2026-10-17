import 'reflect-metadata';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './constants.js';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SETTINGS = '{ metaConversions { pixelId accessTokenHint testEventCode purchaseAt } }';

const UPDATE = `mutation ($input: MetaConversionsInput!) {
  metaConversionsUpdate(input: $input) {
    metaConversions { pixelId accessTokenHint testEventCode purchaseAt }
    userErrors { field code message }
  }
}`;

const EVENTS = `query ($first: Int, $after: String, $status: ConversionStatus, $orderId: ID) {
  conversionEvents(first: $first, after: $after, status: $status, orderId: $orderId) {
    nodes { id platform orderId moment status eventName attempts error traceId sentAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

const TOKEN = 'EAAGm0PX4ZCpsBAKs3bZBqmlLZAZ'.padEnd(60, 'q') + 'Wx9z';

describe.skipIf(!server)("Admin GraphQL API: Meta's conversions API", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  const shop = newId();
  const other = newId();
  const tokens = { owner: '', reader: '', orders: '', other: '', marketer: '' };

  async function issueToken(shopId: string, scopes: string[]): Promise<string> {
    const { token, hash, hint } = generateAccessToken();
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, $4)`,
      [shopId, hash, hint, scopes],
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

  async function data(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'B')`, [
      shop,
      other,
    ]);
    // On Growth, which includes Meta's conversions API (ADR-523).
    await admin.query(
      `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
       SELECT id, 'growth', 'monthly', now(), now() + interval '1 month' FROM control.shops`,
    );
    tokens.owner = await issueToken(shop, ['write_pixels']);
    tokens.reader = await issueToken(shop, ['read_pixels']);
    tokens.orders = await issueToken(shop, ['write_orders']);
    tokens.other = await issueToken(other, ['write_pixels']);
    tokens.marketer = await issueToken(shop, ['read_marketing_events']);
    api = await startTestApi(testDb);
    app = api.app;
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("connects the shop's dataset, never showing its token again, and disconnects it", async () => {
    expect(await data(tokens.owner, SETTINGS)).toBeNull();
    expect(await data(tokens.owner, UPDATE, { input: { accessToken: TOKEN } })).toEqual({
      metaConversions: null,
      userErrors: [
        {
          field: ['input', 'pixelId'],
          code: 'BLANK',
          message: "Connecting Meta needs the pixel's ID",
        },
      ],
    });
    expect(
      await data(tokens.owner, UPDATE, {
        input: { pixelId: '1234567890', accessToken: TOKEN, purchaseAt: 'DELIVERED' },
      }),
    ).toEqual({
      metaConversions: {
        pixelId: '1234567890',
        accessTokenHint: 'Wx9z',
        testEventCode: null,
        purchaseAt: 'DELIVERED',
      },
      userErrors: [],
    });
    expect(
      (await data(tokens.owner, UPDATE, { input: { testEventCode: 'TEST4242' } })).metaConversions,
    ).toMatchObject({ testEventCode: 'TEST4242', purchaseAt: 'DELIVERED' });
    // Those who may read it see it; no one sees its token.
    expect(await data(tokens.reader, SETTINGS)).toEqual({
      pixelId: '1234567890',
      accessTokenHint: 'Wx9z',
      testEventCode: 'TEST4242',
      purchaseAt: 'DELIVERED',
    });
    expect(JSON.stringify(await gql(tokens.owner, SETTINGS))).not.toContain(TOKEN.slice(0, 20));
    for (const [token, query] of [
      [tokens.orders, SETTINGS],
      [tokens.reader, UPDATE],
      [tokens.reader, 'mutation { metaConversionsDelete { deletedPixelId } }'],
      [tokens.orders, EVENTS],
    ] as const) {
      const denied = await gql(token, query, { input: { pixelId: '1' } });
      expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    }
    // Another shop's is its own.
    expect(await data(tokens.other, SETTINGS)).toBeNull();

    const deleted = 'mutation { metaConversionsDelete { deletedPixelId userErrors { code } } }';
    expect(await data(tokens.owner, deleted)).toEqual({
      deletedPixelId: '1234567890',
      userErrors: [],
    });
    expect(await data(tokens.owner, deleted)).toEqual({ deletedPixelId: null, userErrors: [] });
    expect(await data(tokens.owner, SETTINGS)).toBeNull();
  });

  it("lists the moments of the shop's orders, the latest first, with how sending went", async () => {
    const orders = [newId(), newId()];
    const insert = (
      shopId: string,
      orderId: string,
      moment: string,
      status: string,
      extra: Record<string, unknown> = {},
    ) =>
      admin.query(
        `INSERT INTO marketing.conversions
                (shop_id, platform, order_id, moment, occurred_at, status, attempts, event_name,
                 sent_at, error, trace_id, created_at)
         VALUES ($1, 'meta', $2, $3, now(), $4, $5, $6, $7, $8, $9, clock_timestamp())`,
        [
          shopId,
          orderId,
          moment,
          status,
          extra.attempts ?? 1,
          extra.eventName ?? null,
          status === 'sent' ? new Date() : null,
          extra.error ?? null,
          extra.traceId ?? null,
        ],
      );
    await insert(shop, orders[0]!, 'placed', 'sent', { eventName: 'Purchase', traceId: 'AbC' });
    await insert(shop, orders[0]!, 'confirmed', 'pending', {
      attempts: 3,
      error: 'Error validating access token',
    });
    await insert(shop, orders[1]!, 'placed', 'failed', {
      eventName: 'Purchase',
      error: 'Invalid parameter',
    });
    await insert(other, orders[1]!, 'placed', 'sent', { eventName: 'Purchase' });

    const first = await data(tokens.reader, EVENTS, { first: 2 });
    expect(first.nodes).toEqual([
      expect.objectContaining({
        platform: 'META',
        orderId: toPublicId('order', orders[1]!),
        moment: 'PLACED',
        status: 'FAILED',
        eventName: 'Purchase',
        error: 'Invalid parameter',
        sentAt: null,
      }),
      expect.objectContaining({
        orderId: toPublicId('order', orders[0]!),
        moment: 'CONFIRMED',
        status: 'PENDING',
        eventName: null,
        attempts: 3,
        error: 'Error validating access token',
      }),
    ]);
    expect(first.nodes[0].id).toMatch(/^cnv_/);
    expect(first.pageInfo.hasNextPage).toBe(true);
    const rest = await data(tokens.reader, EVENTS, { first: 2, after: first.pageInfo.endCursor });
    expect(rest.nodes).toEqual([
      expect.objectContaining({ moment: 'PLACED', status: 'SENT', traceId: 'AbC' }),
    ]);
    expect(rest.nodes[0].sentAt).toEqual(expect.any(String));
    expect(rest.pageInfo.hasNextPage).toBe(false);

    // By status, by order; another shop's are its own.
    expect(
      (await data(tokens.reader, EVENTS, { status: 'SENT' })).nodes.map(
        (node: Json) => node.moment,
      ),
    ).toEqual(['PLACED']);
    expect(
      (await data(tokens.reader, EVENTS, { orderId: toPublicId('order', orders[0]!) })).nodes.map(
        (node: Json) => node.moment,
      ),
    ).toEqual(['CONFIRMED', 'PLACED']);
    expect((await data(tokens.other, EVENTS, {})).nodes).toHaveLength(1);
    const wrong = await gql(tokens.reader, EVENTS, { orderId: 'prod_1' });
    expect(wrong.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it("connects the shop's TikTok pixel, never showing its token again, and disconnects it (ADR-541)", async () => {
    const TIKTOK = '{ tiktokEvents { pixelCode accessTokenHint testEventCode purchaseAt } }';
    const CONNECT = `mutation ($input: TikTokEventsInput!) {
      tiktokEventsUpdate(input: $input) {
        tiktokEvents { pixelCode accessTokenHint testEventCode purchaseAt }
        userErrors { field code message }
      }
    }`;
    const tiktokToken = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8Tk42';
    expect(await data(tokens.owner, TIKTOK)).toBeNull();
    expect(
      await data(tokens.owner, CONNECT, { input: { pixelCode: 'CABC123DEF456GHI789J' } }),
    ).toEqual({
      tiktokEvents: null,
      userErrors: [
        {
          field: ['input', 'accessToken'],
          code: 'BLANK',
          message: 'Connecting TikTok needs the access token Events Manager gave',
        },
      ],
    });
    expect(
      await data(tokens.owner, CONNECT, {
        input: {
          pixelCode: 'CABC123DEF456GHI789J',
          accessToken: tiktokToken,
          testEventCode: 'TEST31337',
          purchaseAt: 'CONFIRMED',
        },
      }),
    ).toEqual({
      tiktokEvents: {
        pixelCode: 'CABC123DEF456GHI789J',
        accessTokenHint: 'Tk42',
        testEventCode: 'TEST31337',
        purchaseAt: 'CONFIRMED',
      },
      userErrors: [],
    });
    expect(await data(tokens.reader, TIKTOK)).toMatchObject({ accessTokenHint: 'Tk42' });
    expect(JSON.stringify(await gql(tokens.owner, TIKTOK))).not.toContain(tiktokToken.slice(0, 20));
    for (const [token, query] of [
      [tokens.orders, TIKTOK],
      [tokens.reader, CONNECT],
      [tokens.reader, 'mutation { tiktokEventsDelete { deletedPixelCode } }'],
    ] as const) {
      const denied = await gql(token, query, { input: { pixelCode: 'CABC123DEF456GHI789J' } });
      expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    }
    expect(await data(tokens.other, TIKTOK)).toBeNull();

    // A plan without the conversions API connects none.
    await admin.query(`UPDATE billing.subscriptions SET plan = 'starter' WHERE shop_id = $1`, [
      other,
    ]);
    const starter = await data(tokens.other, CONNECT, {
      input: { pixelCode: 'CABC123DEF456GHI789J', accessToken: tiktokToken },
    });
    await admin.query(`UPDATE billing.subscriptions SET plan = 'growth' WHERE shop_id = $1`, [
      other,
    ]);
    expect(starter.tiktokEvents).toBeNull();
    expect(starter.userErrors[0]).toMatchObject({ field: ['input'], code: 'INVALID' });

    const deleted = 'mutation { tiktokEventsDelete { deletedPixelCode userErrors { code } } }';
    expect(await data(tokens.owner, deleted)).toEqual({
      deletedPixelCode: 'CABC123DEF456GHI789J',
      userErrors: [],
    });
    expect(await data(tokens.owner, deleted)).toEqual({ deletedPixelCode: null, userErrors: [] });
    expect(await data(tokens.owner, TIKTOK)).toBeNull();

    // Its moments listed apart from Meta's.
    await admin.query(
      `INSERT INTO marketing.conversions
              (shop_id, platform, order_id, moment, occurred_at, status, event_name, trace_id,
               sent_at)
       VALUES ($1, 'tiktok', $2, 'placed', now(), 'sent', 'CompletePayment', 'req-1', now())`,
      [shop, newId()],
    );
    const BY_PLATFORM = `query ($platform: ConversionPlatform) {
      conversionEvents(platform: $platform) { nodes { platform eventName traceId } }
    }`;
    expect((await data(tokens.reader, BY_PLATFORM, { platform: 'TIKTOK' })).nodes).toEqual([
      { platform: 'TIKTOK', eventName: 'CompletePayment', traceId: 'req-1' },
    ]);
    expect(
      (await data(tokens.reader, BY_PLATFORM, { platform: 'META' })).nodes.every(
        (node: Json) => node.platform === 'META',
      ),
    ).toBe(true);
  });

  it("lists Pakistan's marketing calendar from the shop's today, each moment with its kit (ADR-484)", async () => {
    const CALENDAR = `query ($days: Int) {
      marketingCalendar(days: $days) {
        moment startsOn endsOn promoteFrom expected
        kit { code percentage messageEnglish messageUrdu }
      }
    }`;
    const calendar = (await data(tokens.marketer, CALENDAR, { days: 400 })) as Json[];
    // A year and more holds every moment's promoting.
    expect(new Set(calendar.map((date) => date.moment))).toEqual(
      new Set([
        'RAMADAN',
        'EID_UL_FITR',
        'EID_UL_ADHA',
        'PAKISTAN_DAY',
        'MOTHERS_DAY',
        'INDEPENDENCE_DAY',
        'ELEVEN_ELEVEN',
        'WHITE_FRIDAY',
        'TWELVE_TWELVE',
        'SUMMER_LAWN',
        'WINTER_COLLECTION',
        'WEDDING_SEASON',
      ]),
    );
    const starts = calendar.map((date) => date.startsOn as string);
    expect(starts).toEqual([...starts].sort());
    const eid = calendar.find((date) => date.moment === 'EID_UL_FITR');
    expect(eid).toMatchObject({ expected: true, kit: { percentage: 15 } });
    expect(eid.kit.code).toBe(`EID${(eid.startsOn as string).slice(2, 4)}`);
    expect(eid.kit.messageEnglish).toContain(eid.kit.code);
    expect(eid.kit.messageUrdu).toContain(eid.kit.code);
    expect(calendar.find((date) => date.moment === 'INDEPENDENCE_DAY')).toMatchObject({
      expected: false,
      kit: { percentage: 14 },
    });

    const tooFar = await gql(tokens.marketer, CALENDAR, { days: 1000 });
    expect(tooFar.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    // Its own scope.
    expect((await gql(tokens.orders, CALENDAR)).errors?.[0]?.extensions?.code).toBe(
      'ACCESS_DENIED',
    );
  });
});
