import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { AiGateway } from '@hatti/ai';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId } from '@hatti/ids';
import { StorefrontApiClient } from '@hatti/storefront-api';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_STOREFRONT_KEY, startTestApi, type TestApi } from '../testing/api.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** A PNG's first bytes and some more: the AI is a fake, so no more of a photo is needed. */
const PHOTO = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('a photo of a lawn suit'),
]).toString('base64');

const reading = (input: object) => ({
  content: [{ type: 'tool_use', name: 'give_searches', input }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 1_200, output_tokens: 30 },
});

describe.skipIf(!server)("Visual search: a shopper's photo read into a search (SRC-07)", () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let app: NestFastifyApplication;
  let client: StorefrontApiClient;
  const shop = newId();
  const tokens = { write: '', read: '' };
  const answers: unknown[] = [];

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

  async function data(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  const photo = () => client.photoSearch(shop, { image: PHOTO, mediaType: 'image/png' });

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
    const fetch = (async () =>
      new Response(JSON.stringify(answers.shift()), {
        status: 200,
      })) as unknown as typeof globalThis.fetch;
    api = await startTestApi(testDb, {
      ai: new AiGateway({ apiKey: 'test', model: 'model-from-config', fetch }),
    });
    app = api.app;
    await app.listen(0, '127.0.0.1');
    client = new StorefrontApiClient({ baseUrl: await app.getUrl(), key: TEST_STOREFRONT_KEY });
    tokens.write = await issueToken(['write_products', 'write_settings']);
    tokens.read = await issueToken(['read_products']);
  });

  afterAll(async () => {
    await api?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('reads a photo into the most particular search that finds products, once the shop allows', async () => {
    const created = await data(
      tokens.write,
      `mutation ($input: ProductCreateInput!) { productCreate(input: $input) { product { id } } }`,
      { input: { title: 'Printed Lawn Suit', status: 'ACTIVE' } },
    );
    const suit = fromPublicId(created.product.id, 'product');

    // Off until the shop turns it on: no photo is read, no credit spent.
    const setting = '{ photoSearch { enabled available usedToday limitPerDay } }';
    expect(await data(tokens.read, setting)).toEqual({
      enabled: false,
      available: true,
      usedToday: 0,
      limitPerDay: 300,
    });
    expect(await photo()).toEqual({ refused: 'unavailable' });
    const set = 'mutation ($on: Boolean!) { photoSearchSet(enabled: $on) { enabled } }';
    const denied = await gql(tokens.read, set, { on: true });
    expect(denied.errors?.[0]?.extensions?.code).toBe('ACCESS_DENIED');
    expect(await data(tokens.write, set, { on: true })).toEqual({ enabled: true });

    // What is not a photo is refused before the AI sees it.
    const wrong = await app.inject({
      method: 'POST',
      url: `/storefront/shops/${shop}/search/photo`,
      headers: { authorization: `Bearer ${TEST_STOREFRONT_KEY}` },
      payload: { image: Buffer.from('<svg/>').toString('base64'), mediaType: 'image/png' },
    });
    expect(wrong.statusCode).toBe(400);

    // The most particular finds nothing; the next finds the suit.
    answers.push(
      reading({
        product: true,
        searches: ['Maroon embroidered lawn suit!', 'Lawn suit', 'suit'],
      }),
    );
    expect(await photo()).toEqual({ query: 'lawn suit', productIds: [suit] });

    // A photo of no product is read into no search; one finding nothing gives the broadest.
    answers.push(reading({ product: false }));
    expect(await photo()).toEqual({ query: null, productIds: [] });
    answers.push(reading({ product: true, searches: ['brass karahi', 'karahi'] }));
    expect(await photo()).toEqual({ query: 'karahi', productIds: [] });

    // Each read photo spent one of the Free plan's ten credits (ADR-533), and is kept as what
    // came of it, never the photo.
    expect(await data(tokens.write, '{ productCopyDrafting { creditsLeft } }')).toEqual({
      creditsLeft: 7,
    });
    const kept = await admin.query(
      `SELECT outcome, query, input_tokens FROM catalog.photo_searches
        WHERE shop_id = $1 ORDER BY created_at`,
      [shop],
    );
    expect(kept.rows).toEqual([
      { outcome: 'found', query: 'lawn suit', input_tokens: 1_200 },
      { outcome: 'no_product', query: null, input_tokens: 1_200 },
      { outcome: 'none', query: 'karahi', input_tokens: 1_200 },
    ]);
    expect((await data(tokens.read, setting)).usedToday).toBe(3);

    // With the month's credits spent, no more is read.
    await admin.query(
      `INSERT INTO billing.ai_credit_uses (shop_id, use, used_at)
       SELECT $1, 'visual_search', now() FROM generate_series(1, 7)`,
      [shop],
    );
    expect(await photo()).toEqual({ refused: 'no_credits' });

    // Nor past the day's photos, however many credits are left.
    await admin.query(
      `INSERT INTO catalog.photo_searches (shop_id, outcome)
       SELECT $1, 'found' FROM generate_series(1, 297)`,
      [shop],
    );
    expect(await photo()).toEqual({ refused: 'too_many' });
    expect(answers).toEqual([]);
  });
});
