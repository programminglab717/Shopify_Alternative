import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { HattiAdminApiError, HattiAdminClient } from '@hatti/admin-client';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { LeakyBuckets } from '@hatti/ratelimit';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();
const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

describe.skipIf(!server || !redisUrl)(
  "The Admin API client against Hatti's API (DEV-09, ADR-850)",
  () => {
    let testDb: TestDatabase;
    let admin: pg.Client;
    let api: TestApi;
    let app: NestFastifyApplication;
    let client: HattiAdminClient;
    let redis: Redis;
    const shop = newId();
    /** The buckets' clock, which the client's waits move on. */
    let clock = 1_800_000_000_000;
    const waited: number[] = [];

    beforeAll(async () => {
      testDb = await createTestDatabase(server);
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
      const { token, hash, hint } = generateAccessToken();
      await admin.query(
        `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'sdk', $2, $3, $4)`,
        [shop, hash, hint, ['write_products', 'read_settings']],
      );
      redis = new Redis(redisUrl!);
      // Small buckets, so that a few queries drain them.
      api = await startTestApi(testDb, {
        queryCost: {
          buckets: new LeakyBuckets(redis, `test-sdk-${randomBytes(4).toString('hex')}`),
          limits: {
            app: { maximum: 40, restoreRate: 10 },
            staff: { maximum: 40, restoreRate: 10 },
          },
          now: () => clock,
        },
      });
      app = api.app;
      // The API answering as it does over the network, through Fastify's inject.
      const fetch = (async (url: string, init: RequestInit) => {
        const answer = await app.inject({
          method: 'POST',
          url: new URL(url).pathname,
          headers: init.headers as Record<string, string>,
          payload: init.body as string,
        });
        return new Response(answer.body, {
          status: answer.statusCode,
          headers: { 'content-type': String(answer.headers['content-type'] ?? 'application/json') },
        });
      }) as unknown as typeof globalThis.fetch;
      client = new HattiAdminClient({
        apiUrl: 'http://localhost',
        accessToken: token,
        fetch,
        sleep: async (ms) => {
          waited.push(ms);
          clock += ms;
        },
      });
    });

    afterAll(async () => {
      await api?.close();
      redis?.disconnect();
      await admin?.end();
      await testDb?.drop();
    });

    it('asks the API with its token, reading what each query cost', async () => {
      const { data, cost } = await client.request<{ shop: { name: string } }>('{ shop { name } }');
      expect(data.shop.name).toBe('Zari');
      expect(cost).toMatchObject({
        requestedQueryCost: expect.any(Number),
        throttleStatus: { maximumAvailable: expect.any(Number) },
      });
    });

    it('waits out the throttle the API answers with, and asks again', async () => {
      const many = `{ ${Array.from({ length: 30 }, (_, i) => `s${i}: shop { name }`).join(' ')} }`;
      waited.length = 0;
      await client.request(many);
      const { data } = await client.request<Record<string, { name: string }>>(many);
      expect(data.s0!.name).toBe('Zari');
      expect(waited.length).toBe(1);
      expect(waited[0]).toBeGreaterThan(0);
    });

    it('makes a product once for one idempotency key, and reads the products a page at a time', async () => {
      const CREATE = `mutation ($input: ProductCreateInput!) {
      productCreate(input: $input) { product { id title } userErrors { message } }
    }`;
      const key = newId();
      const first = await client.request<{ productCreate: { product: { id: string } } }>(
        CREATE,
        { input: { title: 'Kurta' } },
        { idempotencyKey: key },
      );
      const again = await client.request<{ productCreate: { product: { id: string } } }>(
        CREATE,
        { input: { title: 'Kurta' } },
        { idempotencyKey: key },
      );
      expect(again.data.productCreate.product.id).toBe(first.data.productCreate.product.id);
      await client.request(CREATE, { input: { title: 'Khussa' } });
      const titles: string[] = [];
      for await (const product of client.paginate<{ title: string }, { products: never }>(
        `query ($after: String) {
        products(first: 1, after: $after) { nodes { title } pageInfo { hasNextPage endCursor } }
      }`,
        {},
        (data) => data.products,
      )) {
        titles.push(product.title);
      }
      expect(titles.sort()).toEqual(['Khussa', 'Kurta']);
    });

    it("throws what the API said for a field it hasn't, and for a scope the token lacks", async () => {
      await expect(client.request('{ nope }')).rejects.toBeInstanceOf(HattiAdminApiError);
      await expect(client.request('{ orders(first: 1) { nodes { id } } }')).rejects.toMatchObject({
        message: expect.stringContaining('read_orders'),
      });
    });
  },
);
